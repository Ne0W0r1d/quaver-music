// Quaver — Electron preload：窗口控制桥（悬浮三钮）+ 装饰模式（CSD/SSD）切换 + MPRIS IPC 桥
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("quaverCSD", {
  min: () => ipcRenderer.send("quaver:win", "min"),
  max: () => ipcRenderer.send("quaver:win", "max"),
  close: () => ipcRenderer.send("quaver:win", "close"),
  setDecor: (mode) => ipcRenderer.send("quaver:decor", mode),
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
