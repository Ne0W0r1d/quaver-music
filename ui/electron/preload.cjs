// Quaver — Electron preload：只暴露窗口控制桥（CSD 标题栏按钮）
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("quaverCSD", {
  min: () => ipcRenderer.send("quaver:win", "min"),
  max: () => ipcRenderer.send("quaver:win", "max"),
  close: () => ipcRenderer.send("quaver:win", "close"),
});
