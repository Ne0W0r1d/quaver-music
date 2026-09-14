// Quaver — Electron 主进程（ESM）
// 起一个进程内 vite preview（dist/ + /api 中继插件），窗口加载 http://127.0.0.1:<port>
// frame:false：无原生标题栏——窗口内右上角悬浮三个窗口按钮（min/max/close），经 preload IPC 接管。
import { app, BrowserWindow, ipcMain } from "electron";
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
const LOG = join(UI_ROOT, "electron-dev.log");
import { appendFileSync } from "node:fs";
const log = (...a) => { const s = a.map((x) => (typeof x === "string" ? x : String(x))).join(" "); try { appendFileSync(LOG, s + "\n"); } catch {} console.log(s); };

let win = null;
let cachedUrl = null; // preview 服务器只起一次；CSD/SSD 重建窗口时复用
// 窗口装饰模式：csd=自绘（frame:false，悬浮胶囊）；ssd=系统标题栏。渲染层 setDecor 偏好后重建窗口。
let decorMode = "csd";
let rebuilding = false;

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
    // vite preview：产物 + /api 中继（relay.ts 插件）同进程；动态 import 规避顶层导入副作用
    log("[quaver] starting vite preview…");
    const { preview } = await import("vite");
    const server = await preview({ configFile: join(UI_ROOT, "vite.config.ts"), preview: { host: "127.0.0.1", port: 4174, strictPort: false } });
    log("[quaver] preview started");
    url = server.resolvedUrls?.local?.[0] ?? "http://127.0.0.1:4174/";
  } else {
    // 兜底静态服务（无 /api 中继）：只为给出构建提示，不起 Electron 空转
    const s = serveStatic();
    s.listen(4175, "127.0.0.1");
    url = "http://127.0.0.1:4175/";
  }
  cachedUrl = url;
  }
  log("[quaver] loading", url);

  win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 900,
    minHeight: 600,
    frame: decorMode === "ssd", // CSD=无原生标题栏（自绘悬浮胶囊）；SSD=系统标题栏
    backgroundColor: "#f7f7f8",
    title: "Quaver",
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: false, // preload 只用 ipcRenderer/contextBridge；Linux chrome-sandbox 权限链路复杂，先绕开
    },
  });
  win.loadURL(url);
  win.webContents.on("did-finish-load", () => log("[quaver] page loaded OK"));
  win.webContents.on("did-fail-load", (_e, code, desc) => log("[quaver] load FAIL", code, desc));
  win.on("closed", () => (win = null));
}

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
  win?.destroy();
  createWindow().then(() => {
    if (win && bounds) win.setBounds(bounds);
    if (win && maximized) win.maximize();
  }).finally(() => (rebuilding = false));
});

// Wayland：本机 Electron 44 默认 ozone 平台即可，不加任何 commandLine 开关
log("[quaver] main.mjs entered, app name:", app.name || "(unset)");
// 单实例：重复启动聚焦已有窗口（防止误开多份 preview/日志串台）
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });
}
// 勿用顶层 await：Electron 对 ESM 主进程中挂起在 await 的模块引导不完整（实测 whenReady 永不兑现）
app.whenReady().then(() => {
  log("[quaver] app ready");
  createWindow().catch((e) => {
    log("[quaver] startup failed:", String(e && e.stack || e));
    app.quit();
  });
});
app.on("window-all-closed", () => { if (!rebuilding) app.quit(); });
