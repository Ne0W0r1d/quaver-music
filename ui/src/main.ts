// Quaver — SPA 入口：只 boot 一次壳层，路由由 hash 驱动（见 shell.ts / views.ts）
import { bootShell } from "./shell";

if (!location.hash) location.replace("#/");
bootShell();
