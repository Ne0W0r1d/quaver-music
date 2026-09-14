// Quaver — SPA 入口：先应用持久化偏好（主题/字体/装饰），再 boot 壳层；路由由 hash 驱动
import { applyTheme, applyFonts, applyDecor } from "./lib/prefs";
import { player } from "./player";
import { bootShell } from "./shell";

applyTheme();
applyFonts();
applyDecor();

if (!location.hash) location.replace("#/");
bootShell();

// dev 钩子：e2e/调试可直接驱动播放器状态（生产构建不含）
if (import.meta.env.DEV) (window as any).__player = player;
