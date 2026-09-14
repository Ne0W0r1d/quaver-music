// Quaver — 打包模式下的纯 Node HTTP 服务（不依赖 vite）。
// 与 dev/preview 的 src/relay.ts 中间件等价：静态 dist/ + /api 中继(sidecar) + 封面取色代理 + 调试日志尾部。
// Electron 主进程与独立 `node native-server.mjs` 都可使用。
import { createServer } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".json": "application/json",
  ".woff2": "font/woff2",
  ".mp3": "audio/mpeg",
};

const SIDECAR = process.env.QUAVER_API ?? "http://127.0.0.1:3200";

// —— 封面取色代理（与 relay.ts 同一白名单：主机 + 路径前缀，非开放代理）——
const IMG_HOSTS = new Set(["y.gtimg.cn", "qpic.y.qq.com", "img.y.gtimg.cn", "pictax.qpic.cn"]);
const IMG_PATHS = ["/music/photo_new/", "/music_cover/", "/music/a_"];

async function proxyImage(u, res) {
  if (!u) {
    res.statusCode = 400;
    return res.end("missing u");
  }
  let target;
  try {
    target = new URL(u);
  } catch {
    res.statusCode = 400;
    return res.end("bad url");
  }
  const ok =
    (target.protocol === "https:" || target.protocol === "http:") &&
    IMG_HOSTS.has(target.hostname) &&
    IMG_PATHS.some((p) => target.pathname.startsWith(p));
  if (!ok) {
    res.statusCode = 403;
    return res.end("host not allowed");
  }
  try {
    const upstream = await fetch(target, {
      headers: { referer: "https://y.qq.com/", "user-agent": "Mozilla/5.0" },
    });
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.statusCode = upstream.status;
    res.setHeader("content-type", upstream.headers.get("content-type") ?? "image/jpeg");
    res.setHeader("cache-control", "public, max-age=86400");
    res.end(buf);
  } catch (e) {
    res.statusCode = 502;
    res.end(String(e));
  }
}

function serveLog(res, logFile, tail) {
  if (!logFile || !existsSync(logFile)) {
    res.statusCode = 404;
    return res.end(JSON.stringify({ code: -1, msg: "log 文件不存在" }));
  }
  const size = statSync(logFile).size;
  const buf = readFileSync(logFile);
  const text = size > 2_000_000 ? buf.subarray(size - 2_000_000).toString("utf8") : buf.toString("utf8");
  const lines = text.split("\n");
  res.statusCode = 200;
  res.setHeader("content-type", "text/plain; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(lines.slice(-Math.max(1, Math.min(5000, tail))).join("\n"));
}

function readBody(req) {
  if (req.method === "GET" || req.method === "HEAD") return Promise.resolve(undefined);
  return new Promise((res, rej) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => res(Buffer.concat(chunks)));
    req.on("error", rej);
  });
}

const MISSING_DIST_PAGE = `<!doctype html><meta charset="utf-8"><body style="font:14px system-ui;padding:40px">
  <h2>dist/ 不存在</h2><p>先构建再启动应用：<code>cd ui &amp;&amp; npm run build &amp;&amp; npm run app</code></p></body>`;

/**
 * @param {{dist: string, logFile?: string, host?: string, port?: number}} opts
 * @returns {Promise<{server: import("node:http").Server, url: string, close: () => void}>}
 */
export async function startQuaverServer({ dist, logFile, host = "127.0.0.1", port = 0 }) {
  const DIST = normalize(dist);

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://local");

    // —— /api/*：中继 ——
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      const sub = url.pathname.slice(4); // 剥掉 "/api"
      if (sub === "/img") return proxyImage(url.searchParams.get("u"), res);
      if (sub === "/log") return serveLog(res, logFile, parseInt(url.searchParams.get("tail") ?? "800", 10) || 800);

      const target = new URL(SIDECAR);
      target.pathname = sub || "/";
      target.search = url.search;

      const headers = new Headers();
      const ct = req.headers["content-type"];
      if (ct) headers.set("content-type", ct);

      try {
        const upstream = await fetch(target, {
          method: req.method,
          headers,
          body: await readBody(req),
          redirect: "manual",
        });
        res.statusCode = upstream.status;
        upstream.headers.forEach((v, k) => {
          // hop-by-hop 与内容编码头交给运行时重算，透传会双重编码
          if (k === "transfer-encoding" || k === "content-encoding" || k === "connection") return;
          res.appendHeader(k, v);
        });
        res.end(Buffer.from(await upstream.arrayBuffer()));
      } catch (e) {
        res.statusCode = 502;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ code: -1, msg: `sidecar unreachable: ${e}` }));
      }
      return;
    }

    // —— 静态 dist/（MPA：无扩展名的路径补 .html）——
    let path = decodeURIComponent(url.pathname);
    if (path === "/") path = "/index.html";
    let file = join(DIST, path);
    if (!existsSync(file) && !extname(file)) file = join(DIST, path + ".html");
    if (!existsSync(file) || !normalize(file).startsWith(DIST)) {
      if (!existsSync(join(DIST, "index.html"))) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return res.end(MISSING_DIST_PAGE);
      }
      res.statusCode = 404;
      return res.end("not found");
    }
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
    res.end(await import("node:fs/promises").then((m) => m.readFile(file)));
  });

  await new Promise((resolve) => server.listen(port, host, resolve));
  const actual = server.address().port;
  return { server, url: `http://${host}:${actual}/`, close: () => server.close() };
}

// 允许独立跑（调试用）：node electron/native-server.mjs
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const dist = new URL("../dist", import.meta.url).pathname;
  const p = parseInt(process.env.PORT ?? "4176", 10);
  startQuaverServer({ dist, logFile: join(dist, "..", "electron-dev.log"), port: p }).then(({ url }) =>
    console.log("quaver native server:", url),
  );
}
