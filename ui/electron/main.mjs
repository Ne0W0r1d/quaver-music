// Quaver — Electron 主进程（ESM）
// 起一个进程内 vite preview（dist/ + /api 中继插件），窗口加载 http://127.0.0.1:<port>
// frame:false：无原生标题栏——窗口右上角平铺三个窗口按钮（min/max/close）+抓握点，经 preload IPC 接管。
import { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage } from "electron";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
// 注意：vite 不能在顶层 import——实测其在 Electron 主进程有副作用，会让 app.whenReady() 永不兑现。
// 只在 createWindow 里动态 import()。

const __dirname = dirname(fileURLToPath(import.meta.url));
const UI_ROOT = resolve(__dirname, "..");
const DIST = join(UI_ROOT, "dist");
// 打包态 asar 不可写，日志落 userData；开发态维持 ui/electron-dev.log（relay.ts 也读这个）
const LOG = join(app.isPackaged ? app.getPath("userData") : UI_ROOT, "electron-dev.log");
import { appendFileSync } from "node:fs";
const log = (...a) => { const s = a.map((x) => (typeof x === "string" ? x : String(x))).join(" "); try { appendFileSync(LOG, s + "\n"); } catch {} console.log(s); };

let win = null;
let cachedUrl = null; // preview 服务器只起一次；CSD/SSD 重建窗口时复用
let sidecar = null;   // 打包态自拉起的 Python sidecar 子进程
// 窗口装饰模式：csd=自绘（frame:false，右上角按钮簇）；ssd=系统标题栏。渲染层 setDecor 偏好后重建窗口。
let decorMode = "csd";
let rebuilding = false;
let tray = null; // Linux 走 D-Bus StatusNotifierItem（KDE/GNOME 托盘）

// 关闭按钮行为（渲染层 quaver:close-action 同步；默认缩放到托盘）：
// tray = 拦截 window close 改 hide（CSD 按钮簇✕、SSD 标题栏✕、Alt+F4 全部生效，托盘菜单可恢复）；
// quit = 走默认关闭流程（window-all-closed → app.quit）。
let closeAction = "tray";
let quitting = false;
app.on("before-quit", () => (quitting = true));

// 菜单栏治理：CSD（frameless）下 Electron 会把默认菜单画成窗口顶部菜单条，直接摘掉；
// SSD 还原默认菜单。不用 setMenuBarVisibility(false)——它不缩 Linux 的内容区（留一条空白）。
function applyMenu() {
  Menu.setApplicationMenu(decorMode === "ssd" ? defaultMenu : null);
}

function showWindow() {
  if (!win) { createWindow().catch((e) => log("[quaver] tray show failed:", String(e))); return; }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// Wayland 下 isVisible() 在 hide→Activate 往返后会短暂滞后（实测），据此判断会把 toggle 做反。
// 托盘可见性只以自维护标志为准；show/hide 事件仅同步外部路径（如 close 隐藏到托盘时）。
let winShown = true;

function toggleWindow() {
  if (!win) { winShown = true; showWindow(); return; }
  if (winShown) { winShown = false; win.hide(); }
  else { winShown = true; showWindow(); }
}

// MPRIS cmd 里 raise/quit 由主进程消费，其余转发给渲染层执行

function mprisDaemonPath() {
  // 打包态：electron-builder extraResources 把编译产物放到 <resources>/mpris/
  if (app.isPackaged) return join(process.resourcesPath, "mpris", "mpris-daemon.cjs");
  // 开发态：vendor/Typhoeus/mpris/dist/（npm run build:mpris 产物，缺失则跳过 MPRIS）
  return resolve(UI_ROOT, "..", "vendor", "Typhoeus", "mpris", "dist", "mpris-daemon.cjs");
}

let mprisBuf = "";      // daemon stdout 行缓冲
let mprisReady = false; // 收到 hello 前缓存最新 state，避免总线未就绪时丢首帧
let mprisPending = null;
let mprisRetries = 0;
let mprisDaemon = null; // 当前 daemon 子进程
let mprisSpawnedAt = 0; // 上次拉起时刻（崩溃重拉的存活判据）

function startMpris() {
  if (process.platform !== "linux") return; // 本期只做 Linux MPRIS；macOS/Windows 原生媒体键另议
  const script = mprisDaemonPath();
  if (!existsSync(script)) {
    log("[quaver] mpris daemon missing, skipped:", script);
    return;
  }
  log("[quaver] spawning mpris daemon:", script);
  // Electron 自带 node 跑 .cjs（ELECTRON_RUN_AS_NODE），打包态无需系统 node
  const child = spawn(process.execPath, [script], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", QUAVER_MPRIS_NAME: "quaver" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    mprisBuf += chunk;
    let i;
    while ((i = mprisBuf.indexOf("\n")) >= 0) {
      const line = mprisBuf.slice(0, i).trim();
      mprisBuf = mprisBuf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { log("[mpris] bad stdout line:", line.slice(0, 120)); continue; }
      if (msg.t === "hello") {
        mprisReady = true;
        log("[quaver] mpris daemon up:", msg.identity);
        if (mprisPending) mprisWrite(mprisPending);
      } else if (msg.t === "cmd") {
        if (msg.cmd === "raise") {
          if (!win) createWindow().catch(() => {});
          else { if (win.isMinimized()) win.restore(); win.show(); win.focus(); winShown = true; }
        } else if (msg.cmd === "quit") {
          app.quit();
        } else if (win && !win.isDestroyed()) {
          win.webContents.send("quaver:mpris-cmd", msg);
        }
      }
    }
  });
  child.stderr.on("data", (d) => log(String(d).trimEnd()));
  child.on("exit", (code) => {
    log("[quaver] mpris daemon exited:", code);
    mprisReady = false;
    mprisDaemon = null;
    // 快速退出 = D-Bus 会话不可用（无总线/头环境），重试无意义；存活过的崩溃才重拉
    if (code !== 0 && mprisRetries < 3 && Date.now() - mprisSpawnedAt > 5000) {
      mprisRetries++;
      setTimeout(startMpris, 2000 * mprisRetries);
    }
  });
  mprisSpawnedAt = Date.now();
  mprisDaemon = child;
}

function mprisWrite(state) {
  mprisPending = state; // 始终留最新一帧：hello 未到先缓存，到了补发
  if (!mprisReady || !mprisDaemon || mprisDaemon.killed || !mprisDaemon.stdin.writable) return;
  try {
    mprisDaemon.stdin.write(JSON.stringify(state) + "\n");
  } catch (e) {
    log("[quaver] mpris state write failed:", String(e));
  }
}

// 渲染层快照（preload quaverMpris.send）→ 直写 daemon stdin
ipcMain.on("quaver:mpris", (_e, state) => {
  if (state && state.t === "state") mprisWrite(state);
});

// build-res 资源定位：打包态在 <resources>/build-res，开发态在 ui/build-res。
const buildRes = (name) => join(app.isPackaged ? process.resourcesPath : UI_ROOT, "build-res", name);

function createTray() {
  // Linux 下 Electron Tray 实现 StatusNotifierItem（D-Bus），Plasma 原生支持；
  // AppIndicator 扩展没有 XEmbed 回退，老版 GNOME 看不到属正常。
  // 托盘图固定用浅色版（tray.png）：面板多为深底，浅米底图标对比更好。
  const iconPath = buildRes("tray.png");
  let image = nativeImage.createFromPath(iconPath);
  if (image.isEmpty()) image = nativeImage.createEmpty(); // 图标缺失也别让 Tray 构造抛错
  tray = new Tray(image);
  tray.setToolTip("Quaver");
  const menu = Menu.buildFromTemplate([
    { label: "显示/隐藏 Quaver", click: toggleWindow },
    { type: "separator" },
    { label: "退出", click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
  tray.on("click", () => toggleWindow()); // 左键 = 显示/隐藏（SNI Activate → click）
}

function spawnSidecar() {
  // electron-builder 把 PyInstaller 产物放在 <resources>/bin/quaver-server
  const bin = join(process.resourcesPath ?? "", "bin", "quaver-server");
  if (!existsSync(bin)) {
    log("[quaver] sidecar binary missing, /api 将回退到环境里的 QUAVER_API:", bin);
    return null;
  }
  const port = 3200 + Math.floor(Math.random() * 200); // 随机端口，避开 dev 遗留的 :3200
  process.env.QUAVER_API = `http://127.0.0.1:${port}`; // native-server.mjs 的中继目标
  log("[quaver] spawning sidecar:", bin, "port", port);
  const child = spawn(bin, [], {
    env: { ...process.env, QUAVER_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => log("[sidecar]", String(d).trimEnd()));
  child.stderr.on("data", (d) => log("[sidecar]", String(d).trimEnd()));
  child.on("exit", (code) => log("[quaver] sidecar exited:", code));
  child.quaverPort = port;
  return child;
}

// 等 sidecar 可响应再开窗：Onefile PyInstaller 首启要解包，慢于页面首屏请求（实测竞态）。
async function waitSidecar(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/login/status`, { signal: AbortSignal.timeout(1500) });
      if (r.ok) {
        log("[quaver] sidecar healthy");
        return true;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  log("[quaver] sidecar NOT healthy after", timeoutMs, "ms — 继续启动（页面会显示错误态）");
  return false;
}

function serveStatic() {
  // dist 缺失时的友好错误页（先 npm run build）
  const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".png": "image/png", ".json": "application/json", ".jpg": "image/jpeg" };
  const server = createServer(async (req, res) => {
    const path = decodeURIComponent((req.url || "/").split("?")[0]);
    let file = join(DIST, path === "/" ? "/index.html" : path);
    if (!existsSync(file) && !extname(file)) file += ".html";
    if (!existsSync(file) || !file.startsWith(DIST)) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(`<!doctype html><meta charset="utf-8"><body style="font:14px system-ui;padding:40px">
        <h2>dist/ 不存在</h2><p>先构建再启动应用：<code>cd ui &amp;&amp; npm run build &amp;&amp; npm run app</code></p></body>`);
    }
    res.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" });
    res.end(await readFile(file));
  });
  return server;
}

async function createWindow() {
  let url = cachedUrl;
  if (!url) {
  log("[quaver] module loaded; dist exists:", existsSync(join(DIST, "index.html")));
  if (existsSync(join(DIST, "index.html"))) {
    if (app.isPackaged) {
      // 打包态：纯 Node 服务（静态 dist + /api 中继，见 native-server.mjs），不依赖 vite；
      // 同时拉起随包 sidecar 二进制（extraResources 里的 quaver-server）。
      // 顺序要紧：先 spawn 设好 QUAVER_API，再 import native-server（它在模块加载时读 env）。
      sidecar = spawnSidecar();
      if (sidecar) await waitSidecar(sidecar.quaverPort);
      const { startQuaverServer } = await import("./native-server.mjs");
      const s = await startQuaverServer({ dist: DIST, logFile: LOG });
      log("[quaver] native server started");
      url = s.url;
    } else {
      // 开发态：vite preview（产物 + /api 中继 relay.ts 插件）同进程；动态 import 规避顶层导入副作用
      log("[quaver] starting vite preview…");
      const { preview } = await import("vite");
      const server = await preview({ configFile: join(UI_ROOT, "vite.config.ts"), preview: { host: "127.0.0.1", port: 4174, strictPort: false } });
      log("[quaver] preview started");
      url = server.resolvedUrls?.local?.[0] ?? "http://127.0.0.1:4174/";
    }
  } else {
    // 兜底静态服务（无 /api 中继）：只为给出构建提示，不起 Electron 空转
    const s = serveStatic();
    s.listen(4175, "127.0.0.1");
    url = "http://127.0.0.1:4175/";
  }
  cachedUrl = url;
  }
  if (process.env.QUAVER_URL) url = process.env.QUAVER_URL; // 集成测试：指向 vite dev server（含 __quaverPlayer 钩子）
  log("[quaver] loading", url);

  win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 760,   // 布局已适配窄窗（搜索框独立顶带 + 播放条流内收缩），半屏吸附不再挤压重叠
    minHeight: 520,   // 播放条为 .frame 流内固定行：任何高度下都占位可见
    frame: decorMode === "ssd", // CSD=无原生标题栏（右上角按钮簇）；SSD=系统标题栏
    backgroundColor: "#f7f7f8",
    title: "Quaver",
    icon: buildRes("icon.png"), // 深色版应用图标（任务栏/窗口管理器等），与 AppImage desktop 图标一致
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: false, // preload 只用 ipcRenderer/contextBridge；Linux chrome-sandbox 权限链路复杂，先绕开
    },
  });
  win.loadURL(url);
  win.webContents.on("did-finish-load", () => log("[quaver] page loaded OK"));
  win.webContents.on("did-fail-load", (_e, code, desc) => log("[quaver] load FAIL", code, desc));
  win.on("close", (e) => {
    // 缩放到托盘：任何路径的 close（按钮簇✕/系统标题栏✕/Alt+F4）都改 hide；
    // 重建窗口（decor 切换）、真退出（托盘菜单/quit 行为）时放行。
    // 注意不因 tray 创建失败而放行 close：隐藏窗口仍可靠 second-instance/MPRIS raise 找回。
    if (closeAction === "tray" && !quitting && !rebuilding) {
      e.preventDefault();
      winShown = false;
      win?.hide();
      log("[quaver] close -> hide (tray:", tray ? "ok" : "MISSING", ")");
    }
  });
  win.on("show", () => (winShown = true));
  win.on("hide", () => (winShown = false));
  win.on("closed", () => (win = null));
}

ipcMain.on("quaver:close-action", (_e, action) => {
  closeAction = action === "quit" ? "quit" : "tray";
  log("[quaver] close-action ->", closeAction);
});

ipcMain.on("quaver:win", (_e, action) => {
  if (!win) return;
  if (action === "min") win.minimize();
  else if (action === "max") win.isMaximized() ? win.unmaximize() : win.maximize();
  else if (action === "close") win.close();
});

// 装饰模式切换（CSD<->SSD）：frame 只能在构造时给定 → 记住几何、拆掉旧窗、重建。
// rebuilding 标志防止 window-all-closed 在拆窗瞬间退出应用。
ipcMain.on("quaver:decor", (_e, mode) => {
  const next = mode === "ssd" ? "ssd" : "csd";
  if (next === decorMode) return;
  const bounds = win?.getBounds();
  const maximized = win?.isMaximized();
  decorMode = next;
  log("[quaver] decor ->", next);
  rebuilding = true;
  if (!defaultMenu) defaultMenu = Menu.getApplicationMenu(); // 兜底：切走前若默认菜单已被摘，无从还原
  win?.destroy();
  createWindow().then(() => {
    if (win && bounds) win.setBounds(bounds);
    if (win && maximized) win.maximize();
    applyMenu();
  }).finally(() => (rebuilding = false));
});

// Wayland：本机 Electron 44 默认 ozone 平台即可，不加任何 ozone 相关开关。
// 但要关掉 Electron 内嵌 Chromium 的 MPRIS mediator：渲染层 HTML5 音频开播后，
// Chromium 自己会注册 org.mpris.MediaPlayer2.chromium.instance<pid>（Identity 用页面标题），
// 与 Quaver 的 mpris daemon 在总线上双条目并存、互抢桌面部件/媒体键（实测 electron#18253 workaround）。
// Quaver 不用 navigator.mediaSession，全局媒体键由我们自己的 daemon 经 MPRIS 提供 → 关掉零副作用。
if (!process.env.QUAVER_KEEP_MEDIATOR) {
  app.commandLine.appendSwitch("disable-features", "MediaSessionService,HardwareMediaKeyHandling");
}
log("[quaver] main.mjs entered, app name:", app.name || "(unset)");
// 先抓一份 Electron 默认菜单（SSD 模式用），随后按 decorMode 应用。
let defaultMenu = Menu.getApplicationMenu();
applyMenu();
// 单实例：重复启动聚焦已有窗口（防止误开多份 preview/日志串台）
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    // 缩放到托盘时再次启动 = 唤回窗口（showWindow 处理 min/hidden 两种情况）
    showWindow();
  });
}
// 勿用顶层 await：Electron 对 ESM 主进程中挂起在 await 的模块引导不完整（实测 whenReady 永不兑现）
app.whenReady().then(() => {
  log("[quaver] app ready");
  createWindow().catch((e) => {
    log("[quaver] startup failed:", String(e && e.stack || e));
    app.quit();
  });
  try { createTray(); } catch (e) { log("[quaver] tray init failed:", String(e)); }
  try { startMpris(); } catch (e) { log("[quaver] mpris init failed:", String(e)); }
});
app.on("window-all-closed", () => { if (!rebuilding) app.quit(); });
app.on("will-quit", () => {
  try { sidecar?.kill(); } catch {}
  try { mprisDaemon?.kill(); } catch {}
});
