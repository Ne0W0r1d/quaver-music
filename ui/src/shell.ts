// Quaver — SPA 壳层（入口 main.ts 调用 bootShell）
// 顶栏/侧栏/播放条/正在播放页/队列面板 = 常驻不销毁；
// .content 内 = 常驻搜索框（.content-top）+ 按路由切换的视图区（.route），
// 切视图不打断音频、搜索框与输入状态不随视图重建。地址栏 hash 路由
// （file:// 与壳层加载均兼容），旧的多页入口（daily.html 等）保留为薄跳转层。
import "./style.css";
import { api, coverUrl, upPic, identityBadges } from "./lib/api";
import { player } from "./player";
import { PlayerBar } from "./components/PlayerBar";
import { NowPlaying } from "./components/NowPlaying";
import { QueuePanel } from "./components/QueuePanel";
import { SearchBox } from "./components/SearchBox";
import { views } from "./views";

export const nav = [
  { path: "#/", label: "首页", icon: "home" },
  { path: "#/guess", label: "猜你喜欢", icon: "sparkle" },
  { path: "#/daily", label: "每日 30 首", icon: "disc" },
  { path: "#/liked", label: "我喜欢", icon: "heart" },
];

const icons: Record<string, string> = {
  home: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 11l8-7 8 7v8a1 1 0 0 1-1 1h-4v-6h-6v6H5a1 1 0 0 1-1-1z"/></svg>',
  sparkle:
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 4l1.7 4.3L18 10l-4.3 1.7L12 16l-1.7-4.3L6 10l4.3-1.7z"/><path d="M18.5 15.5l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9z"/></svg>',
  disc: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="2" fill="currentColor" stroke="none"/></svg>',
  heart:
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 20s-7-4.6-9-9c-1.3-3 .8-6.5 4-6.5 2 0 3.5 1.2 5 3 1.5-1.8 3-3 5-3 3.2 0 5.3 3.5 4 6.5-2 4.4-9 9-9 9z"/></svg>',
  settings:
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="12" r="3"/><path d="M12 2.8v3M12 18.2v3M2.8 12h3M18.2 12h3M5.4 5.4l2.1 2.1M16.5 16.5l2.1 2.1M18.6 5.4l-2.1 2.1M7.5 16.5l-2.1 2.1"/></svg>',
  userPh:
    '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="8.5" r="3.5"/><path d="M5 19c1.5-3 4-4.5 7-4.5s5.5 1.5 7 4.5"/></svg>',
};

// content = .content 主内容区整体；route = 内容区里可被路由替换的部分。
// 搜索框在 content 内、route 外——随壳层常驻，切视图/刷新视图不重建、输入不丢。
export const state = { content: null as HTMLElement | null, route: null as HTMLElement | null };

export function currentRoute() {
  const h = location.hash.replace(/^#\/?/, "");
  const [path, query = ""] = h.split("?");
  return { path: path === "" ? "/" : "/" + path, query: new URLSearchParams(query) };
}

let mountedCleanup: (() => void) | null = null;

export async function renderRoute() {
  if (!state.route) return;
  const { path, query } = currentRoute();
  // 导航高亮
  document.querySelectorAll<HTMLElement>(".nav a").forEach((a) => {
    const p = a.dataset.route || "/";
    a.classList.toggle("active", p === path);
  });
  mountedCleanup?.();
  mountedCleanup = null;

  const view = views[path] ?? views["/"];
  state.route.innerHTML = "";
  state.route.scrollTop = 0;
  try {
    const cleanup = await view(state.route, query);
    if (typeof cleanup === "function") mountedCleanup = cleanup;
  } catch (e) {
    console.error(e);
    state.route.innerHTML = `<div class="muted">页面加载失败：${String((e as Error).message ?? e)}</div>`;
  }
  player.markActive();
}

export function bootShell() {
  // 环境色层：当前封面高斯模糊铺满窗口，供侧栏/播放条等玻璃面板透出色彩
  const ambient = document.createElement("div");
  ambient.className = "ambient";
  ambient.innerHTML = `<div class="ambient-art"></div>`;
  document.body.prepend(ambient);
  const ambArt = ambient.querySelector<HTMLElement>(".ambient-art")!;
  let ambPic = "";
  player.on(() => {
    const pic = player.current ? coverUrl(player.current, 300) : "";
    if (pic === ambPic) return;
    ambPic = pic;
    if (!pic) { ambArt.classList.remove("ready"); return; }
    const img = new Image();
    img.onload = () => {
      if (ambPic !== pic) return; // 期间已换曲
      ambArt.style.backgroundImage = `url("${pic}")`;
      ambArt.classList.add("ready");
    };
    img.onerror = () => { if (ambPic === pic) ambArt.classList.remove("ready"); }; // 封面 404：保持中性底
    img.src = pic;
  });

  const frame = document.createElement("div");
  frame.className = "frame";
  frame.innerHTML = `
    <!-- CSD：无标题栏、无浮窗。三钮（min/max/close）+抓握点平铺窗口右上角，簇底即拖拽区；顶缘另有一条隐形拖拽细条 -->
    <div class="win-dragtop" aria-hidden="true"></div>
    <div class="winbtns" data-csd-drag>
      <span class="win-grip" aria-hidden="true"><svg viewBox="0 0 16 12" width="14" height="11"><g fill="currentColor"><circle cx="4" cy="3.5" r="1.1"/><circle cx="8" cy="3.5" r="1.1"/><circle cx="12" cy="3.5" r="1.1"/><circle cx="4" cy="8.5" r="1.1"/><circle cx="8" cy="8.5" r="1.1"/><circle cx="12" cy="8.5" r="1.1"/></g></svg></span>
      <button aria-label="最小化" data-win="min"><svg viewBox="0 0 12 12" width="11" height="11"><path d="M2 6h8" stroke="currentColor" stroke-width="1.2"/></svg></button>
      <button aria-label="最大化" data-win="max"><svg viewBox="0 0 12 12" width="11" height="11"><rect x="2.5" y="2.5" width="7" height="7" fill="none" stroke="currentColor" stroke-width="1.2"/></svg></button>
      <button aria-label="关闭" data-win="close"><svg viewBox="0 0 12 12" width="11" height="11"><path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" stroke-width="1.2"/></svg></button>
    </div>
    <div class="body">
      <aside class="sidebar">
        <a class="user" id="user-header" href="#/login" title="点击登录">
          <span class="avatar" id="avatar">${icons.userPh}</span>
          <span class="user-meta">
            <span class="nick" id="nick">未登录</span>
            <span class="badges" id="badges"></span>
          </span>
        </a>
        <nav class="nav">
          ${nav.map((n) => `<a href="${n.path}" data-route="${n.path.slice(1) || "/"}">${icons[n.icon]}<span>${n.label}</span></a>`).join("")}
        </nav>
        <hr class="sep" />
        <div class="playlists" id="playlists"><div class="pl-empty">登录后可见歌单</div></div>
        <a class="settings" href="#/settings" title="设置">${icons.settings}</a>
      </aside>
      <main class="content">
        <div class="content-top"></div>
        <div class="route" id="route"></div>
      </main>
    </div>
  `;
  document.body.prepend(frame);
  state.content = frame.querySelector<HTMLElement>(".content")!;
  state.route = frame.querySelector<HTMLElement>("#route")!;
  // 搜索框常驻壳层顶带（.content-top，与 CSD 按钮簇同一水平带）：路由切换/视图刷新只重建 #route，
  // 它不动；顶带把标题行整个让给页面内容，窄窗口下不再互相遮挡。
  state.content.querySelector<HTMLElement>(".content-top")!.append(SearchBox());
  // 播放条必须在 .frame 流内（占 flex 高度）；np/队列是 fixed 覆盖层，挂 body 即可
  frame.append(PlayerBar());
  document.body.append(NowPlaying(), QueuePanel());

  window.addEventListener("hashchange", renderRoute);

  // CSD 按钮：Electron 壳层里走 quaverCSD 桥；浏览器/dev 下仅派发事件占位
  document.querySelectorAll<HTMLElement>("[data-win]").forEach((b) =>
    b.addEventListener("click", () => {
      const csd = (window as any).quaverCSD;
      if (csd?.[b.dataset.win!]) csd[b.dataset.win!]();
      else window.dispatchEvent(new CustomEvent("quaver:window", { detail: b.dataset.win }));
    }),
  );

  bootSidebar();
  renderRoute();
}

// 侧栏状态（头像/昵称/会员徽章/歌单）
async function bootSidebar() {
  try {
    const st: any = await api("/login/status");
    if (!st?.logged_in) return; // 未登录：保持占位样式
    const [me, vip] = await Promise.all([
      api<any>("/user/me").catch(() => null),
      api<any>("/user/vip").catch(() => null),
    ]);
    const base = me?.base_info;
    if (!base?.name) return;
    document.querySelector("#user-header")!.setAttribute("href", "#/user");
    document.querySelector<HTMLElement>("#avatar")!.innerHTML = base.avatar
      ? `<img src="${String(base.avatar).replace(/^http:/, "https:")}" alt=""/>`
      : icons.userPh;
    document.getElementById("nick")!.textContent = base.name;
    // 徽章数据驱动：会员最高档（橙=超级会员/绿=绿钻系）+ 音乐人（蓝）
    document.getElementById("badges")!.innerHTML = identityBadges(me, vip);

    // 我喜欢（dirid=201 固定）不进歌单列表——导航栏已有入口
    const pl: any = await api("/user/created-songlists").catch(() => null);
    const box = document.getElementById("playlists")!;
    box.innerHTML = "";
    for (const x of (pl?.playlists ?? []).filter((p: any) => p.dirid !== 201)) {
      const a = document.createElement("a");
      a.className = "pl";
      const pic = upPic(x.picurl || x.bigpic_url);
      a.innerHTML = `<span class="thumb">${pic ? `<img src="${pic}" alt="" loading="lazy"/>` : ""}</span><span class="pname">${x.title ?? "歌单"}</span>`;
      a.href = `#/playlist?id=${encodeURIComponent(x.id ?? "")}&name=${encodeURIComponent(x.title ?? "歌单")}`;
      box.append(a);
    }
    if (!box.children.length) box.innerHTML = `<div class="pl-empty">暂无歌单</div>`;
  } catch (e) {
    console.warn("sidebar boot failed", e);
  }
}
