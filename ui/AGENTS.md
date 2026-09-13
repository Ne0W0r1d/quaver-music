## Development

Vite MPA（无框架）。启动 dev server 用后台模式：

```sh
npm run dev -- --port 5173 --strictPort --host 127.0.0.1
```

健康检查：`curl -s http://127.0.0.1:5173/index.html | head -5` 应返回 HTML；
`curl -s http://127.0.0.1:5173/api/login/status` 验证中继（需 sidecar :3200 在跑，
否则返回 502 JSON 也算中继活着）。

## Conventions

- 页面 = 根目录 `<name>.html` + `src/entries/<name>.ts`；新页面要同时加进
  `vite.config.ts` 的 `PAGES`。
- 页面脚本第一行必须 `mountLayout("标题")`（注入顶栏/侧栏/播放条并搬运 `.page` 内容），
  之后才可查询页面 DOM。
- `/api/*` 由 `src/relay.ts`（vite 插件中间件，dev 与 preview 都挂）转发 sidecar :3200，
  会话 token 从 `~/.config/quaver/session.txt` 注入 `x-qq-session` 头，勿在浏览器侧存 token。
- 跨页导航一律 `.html` 后缀绝对路径（Vite dev 对 `/foo.html` 与 `/foo` 都可解析；
  壳层直接加载 dist 文件时只有 `.html` 形式可用）。
- 播放全局对象 `window.QuaverPlayer` 由 `PlayerBar()` 挂载。

## Documentation

Vite guide: https://vite.dev/guide/
- Static sites / MPA: https://vite.dev/guide/static-deploy
- Backend for /api middleware: https://vite.dev/guide/backend-integration
- Proxy & server options: https://vite.dev/config/server-options
