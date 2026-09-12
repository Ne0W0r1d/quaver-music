// Quaver UI — Astro 配置
// dev：Astro server route /api/* 中继 sidecar(:3200)（见 src/pages/api/[...route].ts）。
// prod：@astrojs/node standalone，一个进程同时 serve UI + 中继（同源、无 CORS）。
// 桌面壳（QtWebEngine/Tauri/webview）后续直接指向本服务即可。
import { defineConfig } from "astro/config";
import node from "@astrojs/node";

export default defineConfig({
  output: "server",
  adapter: node({ mode: "standalone" }),
  // 左下角三横线的"怪线"实为 Astro Dev Toolbar（仅 dev 注入的调试浮层），关掉保持画布干净
  devToolbar: { enabled: false },
});
