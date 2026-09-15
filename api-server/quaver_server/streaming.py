"""Quaver 侧 Typhoeus 接线：provider 组装 + 流中继 token 表.

端点逻辑薄壳在这里，档位/门控/回退/中继的语义全在 vendor/Typhoeus 包内：
- resolve → 协商出明文可播流（会员门控 + rank 回退 + 首块明文嗅探，绝不解密）
- 中继端点持 token 透传 Range（vkey 不出后端；token 有 TTL，链接过期即失效）
"""

from __future__ import annotations

import asyncio
import secrets
import time
from dataclasses import dataclass, field

from fastapi import HTTPException, Request
from fastapi.responses import StreamingResponse

from typhoeus import ByteRange, SongRef, open_range
from typhoeus.adapters.qqmusic import QQMusicProvider
from typhoeus.quality import STREAMABLE, available_for
from typhoeus.resolver import StreamResolver

from quaver_server.session import session

provider = QQMusicProvider(session.client, credential_state=session)
resolver = StreamResolver(provider)
# 登录/登出后会员缓存立即失效
session.add_change_listener(provider.invalidate_membership)


@dataclass
class StreamEntry:
    url: str
    mime: str
    total: int
    filename: str
    tier: str
    expires_at: float
    hits: int = 0
    meta: dict = field(default_factory=dict)


# token → StreamEntry（进程内，不落盘；重启丢链接可接受——UI 重新 resolve 即可）
_streams: dict[str, StreamEntry] = {}
_TTL_SECONDS = 7200.0  # 与上游 vkey expiration 同量级；播放中命中即续期（滑动过期）


def _purge_expired() -> None:
    now = time.monotonic()
    for tok in [t for t, e in _streams.items() if e.expires_at < now]:
        _streams.pop(tok, None)


async def resolve_stream(mid: str, media_mid: str | None, tier_id: str, auto: bool,
                         deprioritize: list[str] | None = None) -> dict:
    """协商 + 探测总长，发放中继 token。TyphoeusError 由上层 handler 归一。"""
    song = SongRef(mid=mid, media_mid=media_mid or mid)
    resolved = await resolver.resolve(song, tier_id, auto_downgrade=auto,
                                      deprioritize=tuple(deprioritize or ()))
    # 取 total：对 CDN 发 bytes=0-0，从 Content-Range 解析（不下载实体）
    up = await asyncio.to_thread(open_range, resolved.url, ByteRange(0, 0))
    total = 0
    cr = up.headers.get("content-range", "")
    if "/" in cr:
        try:
            total = int(cr.rsplit("/", 1)[1])
        except ValueError:
            total = 0
    _purge_expired()
    token = secrets.token_urlsafe(16)
    _streams[token] = StreamEntry(
        url=resolved.url,
        mime=resolved.tier.mime,
        total=total,
        filename=resolved.filename,
        tier=resolved.tier.id,
        expires_at=time.monotonic() + _TTL_SECONDS,
        meta={"degraded": resolved.degraded, "requested": resolved.requested_tier.id},
    )
    return {
        "token": token,
        "path": f"/stream/{token}",
        "tier": resolved.tier.id,
        "tier_label": resolved.tier.label,
        "requested_tier": resolved.requested_tier.id,
        "degraded": resolved.degraded,
        "mime": resolved.tier.mime,
        "size": total,
        "filename": resolved.filename,
    }


async def serve_stream(token: str, request: Request) -> StreamingResponse:
    """Range 透传中继（仅明文档位的字节流；无解密路径）。"""
    entry = _streams.get(token)
    if entry is None or entry.expires_at < time.monotonic():
        raise HTTPException(404, "播放流不存在或已过期，请重新播放")
    entry.hits += 1
    entry.expires_at = time.monotonic() + _TTL_SECONDS  # 滑动续期：活跃播放不过期
    rng = ByteRange.parse(request.headers.get("range"))
    if rng and (rng.start is not None or rng.end is not None) and entry.total > 0:
        rng = rng.clamp(entry.total)
        if rng.start is not None and rng.start >= entry.total:
            return StreamingResponse(
                iter(()), status_code=416,
                headers={"content-range": f"bytes */{entry.total}", "accept-ranges": "bytes"},
            )
    up = await asyncio.to_thread(open_range, entry.url, rng)
    headers = {
        "accept-ranges": "bytes",
        "content-type": entry.mime,
        "cache-control": "no-store",
    }
    if up.content_range:
        headers["content-range"] = up.content_range
    if up.content_length:
        headers["content-length"] = str(up.content_length)
    elif up.status == 200 and entry.total:
        headers["content-length"] = str(entry.total)
    return StreamingResponse(up.chunks, status_code=up.status, headers=headers)


async def tiers_async() -> dict:
    membership = await provider.membership()
    tiers = available_for(membership)
    # 全量明文档位（含未解锁，UI 画锁徽标用）；加密档位永不出现在任何列表
    return {
        "membership": int(membership),
        "membership_label": {0: "普通用户", 1: "会员", 2: "超级会员"}[membership],
        "tiers": [{"id": t.id, "label": t.label, "rank": t.rank, "hi_res": t.rank >= 40} for t in tiers],
        "all_tiers": [
            {"id": t.id, "label": t.label, "rank": t.rank, "hi_res": t.rank >= 40,
             "locked": membership < t.requires, "requires": int(t.requires)}
            for t in STREAMABLE
        ],
        "max": tiers[-1].id if tiers else None,
    }
