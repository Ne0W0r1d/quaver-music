// Quaver — Electron preload：暴露窗口控制桥（悬浮三钮）+ 装饰模式（CSD/SSD）切换
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("quaverCSD", {
  min: () => ipcRenderer.send("quaver:win", "min"),
  max: () => ipcRenderer.send("quaver:win", "max"),
  close: () => ipcRenderer.send("quaver:win", "close"),
  setDecor: (mode) => ipcRenderer.send("quaver:decor", mode),
});
