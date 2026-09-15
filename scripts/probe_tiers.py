"""实测各音质档位：result 码 + 首块 magic（判定明文/加密）。一次性 spike 脚本。

用法: api-server/.venv/bin/python scripts/probe_tiers.py [song_mid]
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "api-server"))

import niquests  # noqa: E402
from qqmusic_api.modules.song import EncryptedSongFileType, SongFileInfo, SongFileType  # noqa: E402

from quaver_server.session import session  # noqa: E402

CANDIDATES = [
    ("MP3_128", SongFileType.MP3_128),
    ("MP3_320", SongFileType.MP3_320),
    ("FLAC", SongFileType.FLAC),
    ("OGG_640", SongFileType.OGG_640),
    ("OGG_320", SongFileType.OGG_320),
    ("MASTER", SongFileType.MASTER),
    ("ATMOS_2", SongFileType.ATMOS_2),
    ("ATMOS_51", SongFileType.ATMOS_51),
    ("NAC", SongFileType.NAC),
    ("E_FLAC(encrypted)", EncryptedSongFileType.FLAC),
]


def magic(head: bytes) -> str:
    if head[:4] == b"fLaC":
        return "PLAIN-FLAC"
    if head[:4] == b"OggS":
        return "PLAIN-OGG"
    if head[:3] == b"ID3" or head[:2] == b"\xff\xfb" or head[:2] == b"\xff\xf3":
        return "PLAIN-MP3"
    if head[4:8] == b"ftyp":
        return "PLAIN-MP4"
    if head[:4] == b"\x7fELF" or head[:5] == b"QTag":
        return "QMC-ENCRYPTED?"
    return f"UNKNOWN {head[:8].hex()}"


async def probe(mid: str, media_mid: str, name: str) -> None:
    print(f"\n=== {name} ({mid}) ===")
    for label, ft in CANDIDATES:
        try:
            resp = await session.client.song.get_song_urls(
                [SongFileInfo(mid=mid, media_mid=media_mid)], file_type=ft
            )
            item = resp.data[0]
            info = f"{label:18s} result={item.result}"
            if item.purl:
                url = "https://isure.stream.qqmusic.qq.com/" + item.purl
                r = niquests.get(url, headers={"Range": "bytes=0-63"}, timeout=15)
                head = r.content[:64]
                size = None
                cr = r.headers.get("content-range", "")
                if "/" in cr:
                    size = cr.split("/")[-1]
                info += f" status={r.status_code} size={size} vkey={'Y' if item.vkey else 'N'} ekey={'Y' if item.ekey else 'N'} magic={magic(head)}"
            print(info)
        except Exception as exc:
            print(f"{label:18s} ERROR {type(exc).__name__}: {exc}")


async def main() -> None:
    kw = sys.argv[1] if len(sys.argv) > 1 else "告白"
    found = await session.client.search.search_by_type(kw, num=5)
    tracks = []
    for t in found.song[:3]:
        d = t.model_dump()
        mm = (d.get("file") or {}).get("media_mid") or d.get("mid")
        tracks.append((d["mid"], mm, d.get("title", d.get("name", "?"))))
    for mid, mm, name in tracks:
        await probe(mid, mm, name)


asyncio.run(main())
