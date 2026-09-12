# Spike #1 — API + 扫码登录 + 音频格式验证

日期：2026-09-12 · 环境：Fedora 44 / Node v22.23.2 / @yakult-green-tea/qq-music-api 3.1.2

## 结论速览

| 检查项 | 结果 |
| --- | --- |
| npm 安装 + `dist/src/app.js` 起服务 | ✅ 正常，监听 :3200 |
| QQ 音乐 App 扫码登录（key/create/check 轮询） | ✅ 803 成功，HttpOnly session cookie 可用 |
| 会话持久性（跨请求复用 cookie） | ✅ `/login/status` `/user/detail` `/user/liked-songs` 均正常 |
| 播放链接 `/getMusicPlay/:mid?quality=` | ✅ 返回带 vkey 的 stream.qqmusic.qq.com URL |
| **音频加密（QMC）** | ⚠️ 见下 |
| `/getSearchByKey` 搜索 | ❌ 上游返回空列表（老 fcgi 端点疑似失效），需换端点或自实现 |
| QR 会话节流 | ⚠️ 连续新建会话会被 429 backoff（约 1-2 分钟），客户端要处理 Retry-After |
| `getSongListDetail`（公开歌单详情） | ❌ 上游回 `subcode 4000 "check privacy error!"`，带 tid 也不行 → 歌单页占位 |
| `/user/detail` 会员字段 | ❌ 不提供 vip 状态（无 tenpay/svip 字段），"超级会员"徽章暂无数据源 |
| UI 骨架（Astro SSR + node adapter） | ✅ 音乐馆/猜你喜欢/每日30首/我喜欢/登录/我的/设置/歌单 全 200；dev(:4321) 与 standalone(PORT) 双模式中继验证通过 |
| 每日30首 / 猜你喜欢 | ⚠️ 官方端点不存在，前端分别以"我喜欢+日期种子随机30"与"随机洗牌50"占位 |

## 音频格式实测（核心问题）

测试曲目：In the Dark — TAURI（`002Cvsvv1RVStG`，paytype=0，非付费）

- **flac**：下载 16,115,065 字节 = 接口声明 `size_flac`，完整。文件头 `fLaC` 明文，
  STREAMINFO/Vorbis comments/PICTURE 元数据块完整（标题、专辑、封面都在），
  0–~182s 音频帧全部可解码；仅最后 ~2s 出现 2 次 `invalid sync code`，
  尾部字节呈 0x55/0xAA 低熵图案（更像压缩后的静音数据，不像随机密文）。
- **128mp3 / 320mp3**：全文件 ffmpeg 解码 0 错误，完全明文。
- 320mp3 实际回源内容与 128mp3 相同（file 头一致），说明该账号非 VIP 时
  高品质档位被降级处理——档位可用性取决于登录态会员身份。

**判断：普通/免费曲目现在直接回明文，QMC 解密只影响 VIP 专属档位
（mflac/mflac24 等）。MVP 用「登录态播放 + 明文档位」即可跑通整条链路；
VIP 档位需要外挂 QMC 解密（Rust: `qmc2`，JS: `music-decoder`），放在二期。**

注意：测试样本均为 paytype=0。任何一首 VIP 曲目仍可能是
mflac（QMC1 mask）或 qmc2/oggv2，客户端播放层要预留"本地解密代理"扩展位。

## 对架构选型的影响

- Node API 作为本地 sidecar 的路线成立：扫码登录、Cookie 会话、播放链接全部工作。
- 跨域/凭据最省事的组合是 **Koa 同时 serve Astro 静态产物**（一个 origin），
  与仓库自带 /explorer 同模式 → 支持"方案 B：Astro UI + 薄壳"。
- 播放层若用 WebView 的 `<audio>`：明文档位直接可播；加密档位需 sidecar
  做 decrypt 流式代理（Node 侧有现成库），这条对 A/B 两方案同样适用。
- QtWebEngine 壳可行（本机 qt6-qtwebengine 6.11.2 已装）。

## 跨源会话传递（实测出的坑）

- `?cookie=qqmusic_session=<token>` 这条文档写法在本 fork 实际**返回 400**，不要用。
- 可用通道：`Cookie:` 头（同源）或 **`x-qq-session: <token>` 头**（fork 新增，优先级 header > query > cookie）。
- 浏览器限制：`ACAO: *` 时 fetch 不允许携带凭据 cookie，所以跨源 UI 拿不到 HttpOnly session。
- 采用方案：Astro server route 同源中继（`ui/src/pages/api/[...route].ts`），
  服务端读 `~/.config/quaver/session.txt` 注入 `x-qq-session` 后转发 :3200 —— token 不进浏览器。
  注意：Astro dev 跑在 Vite middlewareMode(custom)，**`vite.server.proxy` 在此模式下不生效**（实测 404）。

## 其他实测发现

- 搜索 `/getSearchByKey`：上游返回 `code:0` 但 list 全空 → 老 fcgi 搜索端点已废，二期要换 `smartbox` 或新搜索 CGI。
- 歌词 `/getLyric`：`-1901` 需要 `sig` 参数（loginkey 计算），fork 未实现 → 二期。
- `/user/liked-songs` 正常：30 首/页，带 `file.media_mid`（取播放链接必需）。

## 复现步骤

```bash
cd api-server && npm i @yakult-green-tea/qq-music-api
node node_modules/@yakult-green-tea/qq-music-api/dist/src/app.js   # :3200
../scripts/qq-login.sh          # 终端出二维码，zbar+qrencode，扫码后 cookie 存 ~/.config/quaver/session.txt
curl -b "qqmusic_session=<token>" http://localhost:3200/user/liked-songs?limit=10
curl -b "qqmusic_session=<token>" "http://localhost:3200/getMusicPlay/<mid>?quality=flac&mediaId=<mid>"
ffprobe -hide_banner out.flac   # 判断明文/加密
```
