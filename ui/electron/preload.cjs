// Quaver — Electron preload：窗口控制桥（悬浮三钮）+ 装饰模式（CSD/SSD）切换 + MPRIS IPC 桥
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("quaverCSD", {
  min: () => ipcRenderer.send("quaver:win", "min"),
  max: () => ipcRenderer.send("quaver:win", "max"),
  close: () => ipcRenderer.send("quaver:win", "close"),
  setDecor: (mode) => ipcRenderer.send("quaver:decor", mode),
  // 关闭按钮行为偏好（tray=缩放到托盘 / quit=退出程序）同步给主进程
  setCloseAction: (action) => ipcRenderer.send("quaver:close-action", action === "quit" ? "quit" : "tray"),
});

// MPRIS：渲染层 ↔ mpris daemon（经主进程中转，daemon 走 stdio NDJSON）。
// state 为播放器快照（结构化克隆可序列化）；命令回调只收纯数据。
contextBridge.exposeInMainWorld("quaverMpris", {
  send: (state) => ipcRenderer.send("quaver:mpris", state),
  onCommand: (cb) =>
    ipcRenderer.on("quaver:mpris-cmd", (_e, msg) => {
      try { cb(msg); } catch (err) { console.warn("mpris cmd failed", err); }
    }),
});

// 音频引擎（mpv 后端）：invoke 走请求/应答（handle 返回值可序列化），事件为主进程主动推。
// 渲染层 Transport 抽象（src/lib/transport.ts）据此实现 EngineTransport；
// 浏览器 dev（无 preload）下 window.quaverAudio 不存在 → 自动落到 <audio> WebTransport。
contextBridge.exposeInMainWorld("quaverAudio", {
  invoke: (cmd) => ipcRenderer.invoke("quaver:audio", cmd),
  onEvent: (cb) =>
    ipcRenderer.on("quaver:audio-event", (_e, ev) => {
      try { cb(ev); } catch (err) { console.warn("audio engine event failed", err); }
    }),
});
