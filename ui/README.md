# Quaver UI（Vite + 原生 TS，SPA 壳层）

Vite 多页入口，运行时为 SPA 壳：`index.html` 是唯一真页面（hash 路由），
其余 `*.html` 是深链兼容的跳转层。无框架，原生 TS + DOM。
浏览器不直接碰 QQ 音乐接口：所有请求走同源 `/api/*`，由 `src/relay.ts` 中继到本地 sidecar（:3200，`vendor/Typhoeus/`）。

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
    ├── relay.ts        # /api -> sidecar:3200 中继（透传 + 封面取色代理）
    ├── style.css       # 全局样式
    ├── lib/{api,config,prefs,songs,icons,transport}.ts   # config=quaver.conf 门面，prefs=偏好映射，transport=播放传输抽象（见下）
    └── components/
        ├── PlayerBar.ts    # 底部播放条（进度线/控制/收藏/队列；封面点击展开 np）
        ├── NowPlaying.ts   # 正在播放全屏覆盖层（模糊封面背景+滚动歌词+大封面）
        └── QueuePanel.ts   # 播放队列面板
```

`electron/`（桌面壳，不属于 vite 构建）：`main.mjs` 主进程（窗口/托盘/MPRIS daemon 拉起/音频引擎接线/配置 IPC）、
`config.mjs` 配置文件引擎（跨平台目录、INI 保注释读写、schema 与原子落盘）、
`preload.cjs` 桥（窗口控制 + MPRIS + `quaverAudio` + `quaverConfig`）、`native-server.mjs` 打包态静态+/api 服务、
`audio/` 原生音频引擎（`bins.mjs` 二进制解析、`mpv-ipc.mjs` libmpv JSON IPC、`engine.mjs` 状态机与 IPC 命令面）。

## 配置持久化（quaver.conf）

所有用户设置都在系统标准配置目录的 `quaver.conf`（INI）里，换 AppImage 版本、重装都不丢：

| 平台 | 目录 |
| --- | --- |
| Linux | `$XDG_CONFIG_HOME/quaver-music`（默认 `~/.config/quaver-music`） |
| Windows | `%AppData%\Quaver Music` |
| macOS | `~/Library/Application Support/Quaver Music` |

同目录还有：`credential.json`（登录凭证，0600）、`device.json`（设备指纹）、`electron-dev.log`。
`QUAVER_CONFIG_DIR` 可整体顶掉这个目录（主进程同时用它下发给 sidecar，两边规则必须一致）。

```ini
[Style]    Style / DefaultUIFonts / DefaultLyricsFonts / ShowTranslation
[Window]   Decor / CloseAction
[Playing]  Backend / AudioDevice / Fade / Volume / Muted
[Quality]  DefaultQuality / FallbackToQMAtmos
```

- 键名与可选值以 `electron/config.mjs` 的 `SCHEMA` 为唯一真相；改新项要同时改
  `src/lib/config.ts` 的 `FALLBACK` 与 `src/lib/prefs.ts` 的类型化 getter/setter（三处）。
- **保注释**：程序只改写对应键的那一行，注释、顺序、你自己加的键都原样保留；行内 `# 注释` 也认。
- 字体两项存的就是 **CSS font-family 列表**（如 `Source Han Sans, "Microsoft YaHei", sans-serif`）。
  设置页里下拉给预设、右侧输入框可直接编辑，两边互相同步（选预设 → 填进输入框；输入非预设值 →
  下拉自动切「自定义」），逐字符即时生效、落盘合并 400ms；留空 = 不覆盖，走内置默认栈。
- 值不合法时回落默认值并写日志，不阻断启动。设置页「配置文件」一区可一键定位与恢复默认。
- 读盘时机：preload 用 `sendSync` 同步取一次（渲染层模块在 ESM import 阶段就实例化，
  异步装载会让启动期全落在默认值上）；之后每次改动整键写回。音量这类拖拽高频项合并 250ms 落盘。
- 浏览器直接开 dev server 时没有桥，自动回落 localStorage（键 `quaver.conf.v1`），同一套页面脚本两处都能跑。
- 打包态页面跑在**固定端口**（`main.mjs:STABLE_PORT`）：origin 稳定，Chromium 的 localStorage/IndexedDB/Cache
  才能跨启动延续；端口被占时 `native-server.mjs` 自动回落系统分配端口（设置本就在 conf 里，不受影响）。

自检：`npm run verify:config`（INI 引擎 + 渲染层映射，纯 Node，不用起浏览器）。

## 播放管线（双后端）

`player.ts` 只依赖 `lib/transport.ts` 的 `Transport` 接口，两条实现热切换：

- **MPV（默认，`EngineTransport`）**：主进程 spawn `mpv --input-ipc-server=<unix socket> --idle=yes`，
  经 JSON IPC 收发 `loadfile/pause/seek/volume/audio-device`；位置/时长/播放态/缓冲由引擎广播（约 4Hz），
  渲染层用单调时钟外推插值（单帧上限 0.35s、连续两帧不动即冻结），歌词/进度条/MPRIS 位置同源。
  缓存 = mpv demuxer cache（纯内存有界滑动窗口，`--cache-on-disk=no`，不落盘）。
  播放流仍走本机 `/api/stream/<token>` 中继（URL 只在 socket 里传，vkey/token 不进命令行与日志）。
  **淡入淡出**：不用 `afade`（要掐流时间位置，切歌/暂停场景不好用），而是用 mpv `volume` 属性做振幅包络 ——
  挂流时压到 0，`file-loaded` 起播瞬间升到目标；暂停/停止先降下来再落 `pause`/`stop`。
  「淡出后要执行的动作」是单一 pending 槽：任何更新的意图（播放/切歌 load）都会作废它 ——
  否则切歌时那个延迟的 `stop` 会把刚 loadfile 的新歌掐掉。淡出途中 `seek`（MPRIS Stop = pause+seek(0)）
  会把淡出提前收尾再跳，避免先听见 250ms 歌头。时长档位见设置页（关闭/0.15s/0.4s/0.8s，配置 `[Playing] Fade`）。
- **浏览器 `<audio>`（`WebTransport`）**：渲染层直挂流，dev/无原生引擎时的兜底；行为与历史管线一致（无淡入淡出）。

解析顺序：`QUAVER_MPV`（显式路径）> 随包运行时 > 宿主 `PATH`。排障追加参数走 `QUAVER_MPV_ARGS`（空白分隔，如 `--ao=null`），
显式顶掉随包目录走 `QUAVER_AUDIO_DIR`（指向解好的声源根，内含 `mpv/`）。
引擎不可用（三处都没有 / 浏览器 dev）时自动落 `<audio>` 并在设置页提示，不阻断播放。
解码后端偏好 `[Playing] Backend`：`MPV`（默认）/`Chromium`（渲染层内部标识仍是 Blink）；
音频设备偏好 `[Playing] AudioDevice`（mpv `audio-device` 名）。

### 随包音频运行时（mpv）

上游 mpv 不发布 Linux 二进制，CI 在打包前用 `scripts/stage-mpv.sh` 取 pkgforge 的 mpv AppImage
（钉版本 + sha256，x86_64 / aarch64），**构建期** `--appimage-extract` 展开到 `build-res/audio/mpv/`
（gitignored，~90MB），再由 `extraResources` 落到包内 `<resources>/audio`。本地想要同样效果：

```sh
cd ui && ./scripts/stage-mpv.sh            # 默认按 uname -m；产物在 build-res/audio/mpv
node electron/audio/bins.mjs --check build-res/audio   # 自检（验的就是生产解析路径）
```

`build-res/audio` 在仓库里只留一个 `.gitkeep`（`extraResources` 的 `from` 路径不存在会让 electron-builder 直接失败）；
没暂存也能正常构建，运行期回落系统 mpv —— 随包是优化不是前提。

运行期的三条硬约束（改之前先看 `electron/audio/bins.mjs` 头部注释）：

- 载荷是 `mpv/shared/bin/mpv`，**不能裸跑**（缺包内 so）；
- 必须用**包内自带 loader + `lib/lib.path`** 声明的库路径启动，**绝不能改用宿主 `LD_LIBRARY_PATH`**
  （宿主导入包内 libc → `undefined symbol: __pointer_chk_guard` 直接崩）；
- 不要走它的 `AppRun`：sharun 启动器会跑包内钩子（自更新下载 appimageupdatetool、弹「要不要装 yt-dlp」），
  对 spawn 出来的子进程是灾难。loader 直启载荷 = 同一套运行时、零钩子。

CI 两道断言：暂存后 `bins.mjs --check build-res/audio`；AppImage 产出后再解包，
`bins.mjs --check squashfs-root/resources/audio` —— 跨架构/缺库不会报错、只会跑不起来（exec 126），
且 AppImage 只读挂载没法运行时 chmod 补救，必须在 CI 就验过。

## 约定

- 切视图只重建 `.content` 内容区；播放条/歌词页/侧栏常驻，音频不中断。
- `player.on(fn)` 订阅状态广播，组件在回调里拉平 DOM；UI 反向改状态后调 `player.notifyPublic()`。
- 视图函数 `async (root, query) => cleanup?`：返回的 cleanup 在路由切换前执行（登录页轮询靠它停）。
- 红心收藏存 localStorage（`quaver.loved.v1`）——它是本地数据不是设置，且本 fork 上游不提供收藏写接口，勿伪造。
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
- 音量/静音/歌词翻译开关存 `quaver.conf`（`[Playing] Volume|Muted`、`[Style] ShowTranslation`）；
  静音保留原音量值，恢复即回。音量是拖拽高频项，落盘合并 250ms。
- 玻璃效果：侧栏/标题栏/播放条 = 半透明底 + backdrop-filter；色彩来源 = `.ambient` 环境色层
  （当前封面 blur 铺底，z-index:-1 画在 body 背景上、内容下，白卡不受污染）。无播放时退回纯色。
- dev/自动化：`import.meta.env.DEV` 下 `window.__quaverPlayer` 暴露单例。
- 新 hash 路由 = `views.ts` 注册 + `nav`（如需侧栏入口）+ 可选同名跳转层 html（记得进 `vite.config.ts` 的 `PAGES`）。
