// Quaver — dev 同源 API 中继
// 浏览器 -> /api/* (本文件, :4321) -> sidecar :3200
// 为什么不用 vite.server.proxy：Astro dev 以 Vite middlewareMode(custom) 运行，
// 该模式不挂载 vite 的 proxy 中间件（请求直接进 Astro 路由 -> 404）。
// 会话 token 从 ~/.config/quaver/session.txt 读取（scripts/qq-login.sh 或登录页维护），
// 以 x-qq-session 头转发——token 不进浏览器侧，也绕开了 ACAO:* 不能带 cookie 的限制。
import type { APIRoute } from "astro";
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// server route：不预渲染，运行时转发
export const prerender = false;

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

// 专用端点：登录页扫码成功后回写会话文件；token 为空串 = 清除（仅本机 dev 用途）
const saveSession: APIRoute = async ({ request }) => {
  try {
    const { token } = (await request.json()) as { token?: string };
    if (token === "") {
      try { writeFileSync(sessionPath(), ""); } catch {}
      return json({ ok: true });
    }
    if (!token || !/^[a-f0-9]{32,128}$/i.test(token)) return json({ ok: false, error: "bad token" }, 400);
    mkdirSync(dirname(sessionPath()), { recursive: true, mode: 0o700 });
    writeFileSync(sessionPath(), token, { mode: 0o600 });
    try { chmodSync(sessionPath(), 0o600); } catch {}
    return json({ ok: true });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 400);
  }
};

export const POST = async (ctx: any) => {
  if (ctx.params.route === "__save-session") return saveSession(ctx);
  return passthrough(ctx);
};
export const GET = passthrough;
export const PUT = passthrough;
export const DELETE = passthrough;

async function passthrough({ params, request, url }: any): Promise<Response> {
  const path: string = params.route ?? "";

  const target = new URL(SIDECAR);
  target.pathname = "/" + path;
  target.search = url.search; // 透传 query

  const headers = new Headers();
  const token = readSession();
  if (token) headers.set("x-qq-session", token);
  const ct = request.headers.get("content-type");
  if (ct) headers.set("content-type", ct);

  const body = ["GET", "HEAD"].includes(request.method) ? undefined : await request.arrayBuffer();

  try {
    const res = await fetch(target, { method: request.method, headers, body, redirect: "manual" });
    return new Response(res.body, { status: res.status, headers: new Headers(res.headers) });
  } catch (e) {
    return json({ error: "sidecar unreachable", detail: String(e) }, 502);
  }
}
