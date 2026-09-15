// Quaver — SPA 入口：先应用持久化偏好（主题/字体/装饰），再 boot 壳层；路由由 hash 驱动
import { applyTheme, applyFonts, applyDecor, syncCloseAction } from "./lib/prefs";
import { player } from "./player";
import { bootShell } from "./shell";
import { startMprisBridge } from "./mpris";

applyTheme();
applyFonts();
applyDecor();
syncCloseAction(); // 把「关闭按钮行为」偏好推给 Electron 主进程（tray/quit）

if (!location.hash) location.replace("#/");
bootShell();
startMprisBridge(); // Electron 壳层才有桥；浏览器 dev 下为 no-op

// dev 钩子：e2e/调试可直接驱动播放器状态（生产构建不含）
if (import.meta.env.DEV) (window as any).__player = player;
