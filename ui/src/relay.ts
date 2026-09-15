// Quaver — 同源 API 中继（dev/preview 中间件）
// 浏览器 -> /api/* -> Python sidecar :3200（FastAPI, vendor/Typhoeus/quaver_server）。
// 会话凭证（Credential）由 sidecar 持久化在 ~/.config/quaver/credential.json（0600），
// token 完全不进浏览器侧——所以这里只剩纯透传 + 封面代理。
import type { Connect } from "vite";
import type { IncomingMessage, ServerResponse } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SIDECAR = process.env.QUAVER_API ?? "http://127.0.0.1:3200";

const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

function readBody(req: IncomingMessage): Promise<Uint8Array | undefined> {
  if (req.method === "GET" || req.method === "HEAD") return Promise.resolve(undefined);
  return new Promise((res, rej) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => res(Buffer.concat(chunks)));
    req.on("error", rej);
  });
}

// 封面取色代理：CDN 无 Access-Control-Allow-Origin，canvas 直接加载会被 taint 无法 getImageData。
// 这里同源转发并限定主机+路径白名单（非开放代理）。
const IMG_HOSTS = new Set(["y.gtimg.cn", "qpic.y.qq.com", "img.y.gtimg.cn", "pictax.qpic.cn"]);
const IMG_PATHS = ["/music/photo_new/", "/music_cover/", "/music/a_"];
async function proxyImage(u: string | null, res: ServerResponse) {
  if (!u) { res.statusCode = 400; return res.end("missing u"); }
  let target: URL;
  try {
    target = new URL(u);
  } catch {
    res.statusCode = 400;
    return res.end("bad url");
  }
  const ok = (target.protocol === "https:" || target.protocol === "http:")
    && IMG_HOSTS.has(target.hostname)
    && IMG_PATHS.some((p) => target.pathname.startsWith(p));
  if (!ok) { res.statusCode = 403; return res.end("host not allowed"); }
  try {
    const upstream = await fetch(target, { headers: { referer: "https://y.qq.com/", "user-agent": "Mozilla/5.0" } });
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.statusCode = upstream.status;
    res.setHeader("content-type", upstream.headers.get("content-type") ?? "image/jpeg");
    res.setHeader("cache-control", "public, max-age=86400");
    res.setHeader("access-control-allow-origin", "http://127.0.0.1:5173");
    res.end(buf);
  } catch (e) {
    res.statusCode = 502;
    res.end(String(e));
  }
}

// 调试：日志页面数据源。Electron 壳层写 ui/electron-dev.log（见 electron/main.mjs），
// 这里以纯文本给出尾部 N 行；文件不存在（纯浏览器 dev）返回 404 JSON，前端显示占位提示。
function serveLog(res: ServerResponse, tail: number) {
  const file = join(import.meta.dirname ?? ".", "..", "electron-dev.log");
  if (!existsSync(file)) {
    res.statusCode = 404;
    return res.end(JSON.stringify({ code: -1, msg: "electron-dev.log 不存在" }));
  }
  const size = statSync(file).size;
  const buf = readFileSync(file);
  const text = size > 2_000_000 ? buf.subarray(size - 2_000_000).toString("utf8") : buf.toString("utf8");
  const lines = text.split("\n");
  res.statusCode = 200;
  res.setHeader("content-type", "text/plain; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(lines.slice(-Math.max(1, Math.min(5000, tail))).join("\n"));
}

export function apiRelay(): Connect.NextHandleFunction {
  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://local"); // req.url 已剥掉挂载前缀 /api
    const path = url.pathname.replace(/^\//, "");

    if (path === "img") return proxyImage(url.searchParams.get("u"), res);
    if (path === "log") return serveLog(res, parseInt(url.searchParams.get("tail") ?? "800", 10) || 800);

    const target = new URL(SIDECAR);
    target.pathname = "/" + path;
    target.search = url.search; // 透传 query

    const headers = new Headers();
    const ct = req.headers["content-type"];
    if (ct) headers.set("content-type", ct);
    const range = req.headers["range"];
    if (range) headers.set("range", range); // 播放流 Range 中继必须透传

    try {
      const upstream = await fetch(target, {
        method: req.method,
        headers,
        body: (await readBody(req)) as BodyInit | undefined,
        redirect: "manual",
      });
      // 播放流（/api/stream/<token>）：流式管道，绝不整段缓冲（边下边播 + 省内存）
      if (/^stream\/[^/]+$/.test(path) && upstream.body) {
        res.statusCode = upstream.status;
        upstream.headers.forEach((v, k) => {
          if (k === "transfer-encoding" || k === "content-encoding" || k === "connection") return;
          res.appendHeader(k, v);
        });
        const { Readable } = await import("node:stream");
        Readable.fromWeb(upstream.body as any).pipe(res);
        return;
      }
      res.statusCode = upstream.status;
      upstream.headers.forEach((v, k) => {
        // hop-by-hop 与内容编码头交给运行时重算，透传会双重编码
        if (k === "transfer-encoding" || k === "content-encoding" || k === "connection") return;
        res.appendHeader(k, v);
      });
      res.end(Buffer.from(await upstream.arrayBuffer()));
    } catch (e) {
      const r = json({ code: -1, msg: `sidecar unreachable: ${e}` }, 502);
      res.statusCode = r.status;
      r.headers.forEach((v, k) => res.appendHeader(k, v));
      res.end(Buffer.from(await r.arrayBuffer()));
    }
  };
}
