# Quaver UI（Vite + 原生 TS，SPA 壳层）

Vite 多页入口，运行时为 SPA 壳：`index.html` 是唯一真页面（hash 路由），
其余 `*.html` 是深链兼容的跳转层。无框架，原生 TS + DOM。
浏览器不直接碰 QQ 音乐接口：所有请求走同源 `/api/*`，由 `src/relay.ts` 中继到本地 sidecar（:3200，`api-server/`）。

```sh
npm install
npm run dev        # 开发服务 http://localhost:5173（含 /api 中继）
npm run build      # tsc 检查 + 产物到 dist/
npm run preview    # 预览构建产物（同样挂 /api 中继）
```

## 结构

```text
/
├── index.html          # 唯一 SPA 入口 -> src/main.ts -> shell.ts
├── <其余>.html         # 深链跳转层（重定向到 #/路由）
├── public/
├── vite.config.ts
└── src/
    ├── main.ts         # bootShell()
    ├── shell.ts        # 常驻壳层：标题栏/侧栏/内容区 + hash 路由渲染
    ├── views.ts        # 路由视图表（仅内容区：首页/猜你/每日/我喜欢/歌单/设置/我的/登录）
    ├── player.ts       # 全局播放器状态机（队列/模式/歌词/收藏，订阅式 notify）
    ├── lyric.ts        # LRC 解析（含翻译行）
    ├── relay.ts        # /api -> sidecar:3200 中继（会话 token 注入）
    ├── style.css       # 全局样式
    ├── lib/{api,songs,icons}.ts
    └── components/
        ├── PlayerBar.ts    # 底部播放条（进度线/控制/收藏/队列；封面点击展开 np）
        ├── NowPlaying.ts   # 正在播放全屏覆盖层（模糊封面背景+滚动歌词+大封面）
        └── QueuePanel.ts   # 播放队列面板
```

## 约定

- 切视图只重建 `.content` 内容区；播放条/歌词页/侧栏常驻，音频不中断。
- `player.on(fn)` 订阅状态广播，组件在回调里拉平 DOM；UI 反向改状态后调 `player.notifyPublic()`。
- 视图函数 `async (root, query) => cleanup?`：返回的 cleanup 在路由切换前执行（登录页轮询靠它停）。
- 红心收藏目前存 localStorage（`quaver.loved.v1`）——本 fork 上游不提供收藏写接口，勿伪造。
- 歌词翻译：fork 的老歌词 CGI 恒返回空 trans；`relay.ts` 的 `enrichLyric()` 在 `/api/getLyric`
  命中空 trans 时改走免 cookie 的 `musicu.fcg GetPlayLyricInfo`（trans=1）补齐并解码成明文 LRC。
  前端 `parseLrc` 同时兼容 base64/明文（player.b64utf8 有探测逻辑），显示开关 = player.showTrans。
- 列表交互（对齐设计稿）：歌曲行 = 序号+封面+歌名/歌手/专辑三行+♥+时长；双击行播放整队列
  （单击封面兜底播放）；歌手/专辑名为可点链接 → `#/singer?mid=` / `#/album?mid=` 视图
  （getSingerHotsong / getAlbumInfo，后者 list 项是 songmid/songname 异形需归一）。
- 播放条悬浮：`.player` 绝对定位悬浮窗底（高 64 + 底距 10）；`.body` 底部 padding 84px
  把侧栏/内容卡整体收缩到条上方（条不再遮挡任何容器，列表尾行滚到卡片底部即完整可见）。
  进度 = 整个 Bar 可拖拽（pointerdown 于任意非控件处起拖，拖中预览线/圆点/时间跟手，
  松手才 seek；换算用 #pb-prog 矩形与可视线对齐），顶边青线只是视觉指示。
  音量 = 浮窗 #pb-volpop（悬停/点击 #pb-mute 弹出，玻璃底：静音钮+滑杆+百分比读数一体；
  Bar 上滚轮微调 ±4%；条外点击关闭）。无底边音量线。
  进度可视化 = 封面染色：`lib/color.ts` 经同源中继 `/api/img`（主机+路径白名单，CDN 无 CORS
  会 taint canvas）取 24x24 量化主色 → HSL 拉进可读区间（色相保留、饱和≥0.5、亮度锚 0.6，
  灰封面例外只微提饱和）→ `--tint` 填充 Bar 已播区（.pb-fill 宽=--pf，z-index 0，控件 z-index 1；
  .player 有 backdrop-filter，负 z-index 会被整层压没——勿改回）。深色文字对比 ~4.5:1 达 AA-large。
- 音量持久化 localStorage：`quaver.volume.v1`(0..1) + `quaver.muted.v1`；静音保留原音量值，恢复即回。
- 玻璃效果：侧栏/标题栏/播放条 = 半透明底 + backdrop-filter；色彩来源 = `.ambient` 环境色层
  （当前封面 blur 铺底，z-index:-1 画在 body 背景上、内容下，白卡不受污染）。无播放时退回纯色。
- dev/自动化：`import.meta.env.DEV` 下 `window.__quaverPlayer` 暴露单例。
- 新 hash 路由 = `views.ts` 注册 + `nav`（如需侧栏入口）+ 可选同名跳转层 html（记得进 `vite.config.ts` 的 `PAGES`）。
