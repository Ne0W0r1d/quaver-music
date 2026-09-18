// Quaver UI — Vite 配置（MPA：多页 html 入口，壳层由 src/layout.ts 注入）
// dev/preview：同源 /api 中继 -> sidecar(:3200)，见 src/relay.ts。
// 为什么不用 server.proxy：中继除转发外还要做封面取色代理与流中断收敛；会话凭证只存在
// 本机配置目录（Linux ~/.config/quaver-music/credential.json），浏览器侧全程拿不到。
// 桌面壳（Electron/QtWebEngine/Tauri）后续直接加载 dist/ 或 preview 服务即可。
import { defineConfig, type Connect, type PreviewServer, type ViteDevServer } from "vite";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { apiRelay } from "./src/relay.ts";

// 关于页版本号：优先取最近 git tag（如 v0.1.1），无 tag 时回退 package.json version
function appVersion(): string {
  const root = fileURLToPath(new URL(".", import.meta.url));
  try {
    return execSync("git describe --tags --abbrev=0", { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return "v" + (JSON.parse(readFileSync(root + "package.json", "utf8")).version as string);
  }
}

const PAGES = ["index", "guess", "daily", "liked", "playlist", "user", "settings", "login"];

function attachRelay(server: ViteDevServer | PreviewServer) {
  (server.middlewares as Connect.Server).use("/api", apiRelay());
}

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(appVersion()),
  },
  build: {
    rollupOptions: {
      input: Object.fromEntries(
        PAGES.map((p) => [p, fileURLToPath(new URL(`./${p}.html`, import.meta.url))]),
      ),
    },
  },
  plugins: [
    {
      name: "quaver-api-relay",
      configureServer: attachRelay,
      configurePreviewServer: attachRelay,
    },
  ],
});
