# Typhoeus — 高音质流传输（仅限会员）实现记录

日期：2026-09-14 · 分支：`feat/high-end-quality`（主仓 + vendor/Typhoeus submodule）

## 结论

高音质档位（无损 SQ、OGG 640、臻品音质/全景声/母带）在**会员登录态**下由腾讯
直接下发**明文流**（首块 magic `fLaC`/`OggS`，带 vkey 无 ekey）——播放它们不需要
解密。Typhoeus 因此实现为：档位协商 + 会员门控 + Range/206 明文中继；**QMC 加密
档位（mflac/mgg）三重拦截拒绝，全链路无解密代码**（可缓存不可被解密）。

## 实测矩阵（超级会员账号，2026-09-14，`scripts/probe_tiers.py`）

| 档位 | 前缀 | 结果 |
| --- | --- | --- |
| 128/320 mp3 | M500/M800 | 明文（会员回真实 M800 内容，size 差 2.5x） |
| FLAC（无损 SQ） | F000 | 明文 fLaC |
| OGG 640/320（SQ/HQ） | O801/O800 | 明文 OggS（个别曲 404=无此资源 → 触发降档回退） |
| 臻品音质/全景声 5.1 | Q000/Q001 | 明文 fLaC |
| 臻品母带 Hi-Res | AI00 | 明文 fLaC（164-184 MB/曲，result=104003=该曲无母带） |
| NAC 自研 codec | TL01 | 非白名单容器（`NAC_`）→ 嗅探拒绝（Web 解码器不可用） |
| 加密 FLAC | F0M0 | 带 ekey、首块乱码 —— **策略层拒绝，不请求、不解密** |

非会员/匿名：高档被降级或 104003（spike-1 已证）；故 UI 门控必须以后端
`/stream/tiers`（`user.get_vip_info` → svip/huge_vip/vip）为准，不能只信本地。

## 架构

```
ui (api.ts getPlayUrl → /api/stream/resolve → <audio> src=/api/stream/<token>)
 └ relay.ts / native-server.mjs：/api/stream/* 流式管道（Range 透传，不缓冲）
    └ sidecar (quaver_server/streaming.py 薄接线)
       └ vendor/Typhoeus (包：quality/provider/resolver/stream/adapters.qqmusic)
          └ vendor/QQMusicApi (SDK：GetVkey 明文档位；不碰 GetEVkey/ekey)
```

- 会员门控：显式选高档+会员不足 → 403（UI 保留选择、提示开会员，勿静默降档）；
  `auto=true` → 链裁剪到可及最高档。
- 曲目缺高档资源（104003/404）→ rank 回退链逐档取链（degraded=true 徽章 `→无损 SQ`）。
- vkey 不出后端：浏览器只见随机 token；token 滑动过期 2h；中继透传 CDN 的
  206/416/Content-Range（`<audio>` seek 全兼容，headless Chrome 实播验证）。

## 顺手修复

`POST /song/urls` 旧路径：per-item `file_type` 默认 MP3_128 会**静默覆盖**批量
档位（SDK `item.file_type or file_type` 优先级）→ 未显式指定时传 None。修复后
`file_type=7` 实测回 `F000….flac`（修复前回 M500）。

## 验证记录（全部真实执行）

- Typhoeus 单测 19 passed（假 provider，无网络）。
- curl：tiers/resolve/206/后缀 range/416/451(加密档拒绝)/422/降档 degraded。
- headless Chrome（scripts/typhoeus-smoke.mjs）：flac/640ogg/master/320/128/auto
  六档 currentTime 前进、duration 261s 对、src 走 `/api/stream/`；播放条徽章
  「无损 SQ」；设置页 9 张档位卡（会员全解锁）。
- 旧冒烟 scripts/smoke.mjs 全 PASS（唯一 400 为歌词端点上游 24001，改动前即存在）。
