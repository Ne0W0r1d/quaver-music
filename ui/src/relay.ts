// Quaver — 同源 API 中继（dev/preview 中间件）
// 浏览器 -> /api/* -> sidecar :3200
// 会话 token 从 ~/.config/quaver/session.txt 读取（scripts/qq-login.sh 或登录页维护），
// 以 x-qq-session 头转发——token 不进浏览器侧，也绕开了 ACAO:* 不能带 cookie 的限制。
import type { Connect } from "vite";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const SIDECAR = process.env.QUAVER_API ?? "http://localhost:3200";

const sessionPath = () =>
  join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "quaver", "session.txt");

const readSession = () => {
  try {
    return readFileSync(sessionPath(), "utf8").trim();
  } catch {
    return "";
  }
};

const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });

function readBody(req: IncomingMessage): Promise<Uint8Array | undefined> {
  if (req.method === "GET" || req.method === "HEAD") return Promise.resolve(undefined);
  return new Promise((res, rej) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => res(Buffer.concat(chunks)));
    req.on("error", rej);
  });
}

// fork 的老歌词 CGI 永远不返回 trans（实测），但免 cookie 的 musicu.fcg GetPlayLyricInfo 可以。
// 命中 /api/getLyric 且上游 trans 为空时，来这里补齐并解码成明文 LRC。
const MUSICU = "https://u.y.qq.com/cgi-bin/musicu.fcg";
async function enrichLyric(bodyText: string, songmid: string): Promise<string> {
  try {
    const j = JSON.parse(bodyText);
    const resp = j?.response;
    if (!resp || typeof resp !== "object" || resp.trans || !songmid) return bodyText;
    const r = await fetch(MUSICU, {
      method: "POST",
      headers: { "content-type": "application/json", referer: "https://y.qq.com/", "user-agent": "Mozilla/5.0" },
      body: JSON.stringify({
        comm: { ct: 24, cv: 0 },
        req_0: { module: "music.musichallSong.PlayLyricInfo", method: "GetPlayLyricInfo", param: { songMid: songmid, crypt: 0, trans: 1, roma: 0, lrc: 0 } },
      }),
    });
    const m: any = await r.json();
    const tr = m?.req_0?.data?.trans;
    if (tr) resp.trans = Buffer.from(tr, "base64").toString("utf8");
    return JSON.stringify(j);
  } catch {
    return bodyText; // 合并失败不影响原歌词
  }
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

export function apiRelay(): Connect.NextHandleFunction {
  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://local"); // req.url 已剥掉挂载前缀 /api
    const path = url.pathname.replace(/^\//, "");

    if (path === "img") return proxyImage(url.searchParams.get("u"), res);

    // 专用端点：登录页扫码成功后回写会话文件；token 为空串 = 清除（仅本机 dev 用途）
    if (path === "__save-session" && req.method === "POST") {
      try {
        const raw = await readBody(req);
        const { token } = JSON.parse(raw ? Buffer.from(raw).toString("utf8") : "") as { token?: string };
        if (token === "") {
          try { writeFileSync(sessionPath(), ""); } catch {}
          return send(json({ ok: true }), res);
        }
        if (!token || !/^[a-f0-9]{32,128}$/i.test(token)) return send(json({ ok: false, error: "bad token" }, 400), res);
        mkdirSync(dirname(sessionPath()), { recursive: true, mode: 0o700 });
        writeFileSync(sessionPath(), token, { mode: 0o600 });
        try { chmodSync(sessionPath(), 0o600); } catch {}
        return send(json({ ok: true }), res);
      } catch (e) {
        return send(json({ ok: false, error: String(e) }, 400), res);
      }
    }

    const target = new URL(SIDECAR);
    target.pathname = "/" + path;
    target.search = url.search; // 透传 query

    const headers = new Headers();
    const token = readSession();
    if (token) headers.set("x-qq-session", token);
    const ct = req.headers["content-type"];
    if (ct) headers.set("content-type", ct);

    try {
      const upstream = await fetch(target, {
        method: req.method,
        headers,
        body: (await readBody(req)) as BodyInit | undefined,
        redirect: "manual",
      });
      // 歌词端点：合并翻译（透传其余头/状态码）
      if (path === "getLyric" && upstream.ok) {
        const text = await upstream.text();
        const merged = await enrichLyric(text, url.searchParams.get("songmid") ?? "");
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(merged);
        return;
      }
      res.statusCode = upstream.status;
      upstream.headers.forEach((v, k) => res.appendHeader(k, v));
      res.end(Buffer.from(await upstream.arrayBuffer()));
    } catch (e) {
      send(json({ error: "sidecar unreachable", detail: String(e) }, 502), res);
    }
  };
}

async function send(r: Response, res: ServerResponse) {
  res.statusCode = r.status;
  r.headers.forEach((v, k) => res.appendHeader(k, v));
  res.end(Buffer.from(await r.arrayBuffer()));
}
