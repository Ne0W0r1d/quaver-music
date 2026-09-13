// Quaver — 路由视图表（仅内容区渲染；播放器/侧栏常驻）
// 视图函数: async (root, query) => cleanup?
import { api, upPic, getQuality, setQuality } from "./lib/api";
import { renderSongRows, loadLiked, type RowHooks } from "./lib/songs";
import { player } from "./player";

const h = (tag: string, cls: string, html = "") => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  el.innerHTML = html;
  return el;
};

// —— 首页：大标题 + 推荐歌单卡片网格（官方推荐 CGI，无需登录态） ——
async function homeView(root: HTMLElement) {
  root.append(h("h1", "page-title", "首页"));
  const grid = h("div", "grid playlist-grid");
  grid.innerHTML = `<div class="muted">加载中…</div>`;
  root.append(grid);

  const d: any = await api("/recommend/songlist?num=30");
  const list: any[] = d?.songlists ?? [];
  grid.innerHTML = "";
  for (const x of list) {
    const a = h("a", "card") as HTMLAnchorElement;
    a.href = `#/playlist?id=${encodeURIComponent(x.id ?? "")}&name=${encodeURIComponent(x.title ?? "")}`;
    a.innerHTML = `<div class="art"><img src="${upPic(x.picurl)}" alt="" loading="lazy"/></div>
      <div class="name">${x.title ?? "歌单"}</div><div class="sub">${x.creator_nick ? x.creator_nick + " 制作" : "推荐歌单"}</div>`;
    grid.append(a);
  }
  if (!list.length) grid.innerHTML = `<div class="muted">暂无推荐</div>`;
}

// —— 歌单页：信息头（封面/标题/制作人/描述）+ 歌曲列表（分页拉全） ——
async function playlistView(root: HTMLElement, q: URLSearchParams) {
  const name = q.get("name") || "歌单";
  const id = q.get("id") || "";
  const box = h("div", "rows", `<div class="muted">加载中…</div>`);
  root.append(box);
  if (!/^\d+$/.test(id)) { box.innerHTML = `<div class="muted">歌单 id 无效</div>`; return; }

  let info: any = null;
  const songs: any[] = [];
  try {
    for (let page = 1; ; page++) {
      const d: any = await api(`/songlist/${id}/detail?page=${page}&num=100`);
      info ??= d?.info;
      songs.push(...(d?.songs ?? []));
      if (!d?.hasmore || (d?.songs ?? []).length === 0) break;
    }
  } catch (e: any) {
    box.innerHTML = `<div class="muted">加载失败：${e.message}</div>`;
    return;
  }
  root.innerHTML = "";

  const head = h("div", "pl-head");
  const logo = upPic(info?.picurl || "");
  head.innerHTML = `
    <button class="pl-back" aria-label="返回" title="返回"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 6l-6 6 6 6"/></svg></button>
    <div class="pl-art">${logo ? `<img src="${logo}" alt=""/>` : ""}</div>
    <div class="pl-info">
      <h1 class="pl-name">${info?.title ?? name}</h1>
      <div class="pl-meta">${info?.creator?.nick ? `${info.creator.nick} 制作` : ""}${info?.songnum ? ` · ${info.songnum} 首` : ""}</div>
      <div class="pl-desc muted">${(info?.desc || "").replace(/</g, "&lt;")}</div>
    </div>`;
  root.append(head);
  head.querySelector<HTMLElement>(".pl-back")!.onclick = () => history.length > 1 ? history.back() : (location.hash = "#/");

  const rows = h("div", "rows");
  root.append(rows);
  if (!songs.length) {
    rows.innerHTML = `<div class="muted">歌单为空或不可见</div>`;
    return;
  }
  const hooks: RowHooks = { showAlbum: true, onPlay: (s, i, all) => player.playList(all, i) };
  renderSongRows(rows, songs, hooks);
}

// —— 歌手页（点击行内歌手跳转的落点）：热门歌曲列表 ——
async function singerView(root: HTMLElement, q: URLSearchParams) {
  const mid = q.get("mid") || "";
  const name = decodeURIComponent(q.get("name") || "歌手");
  root.append(h("h1", "page-title", name));
  const box = h("div", "rows", `<div class="muted">加载中…</div>`);
  root.append(box);
  if (!mid) { box.innerHTML = `<div class="muted">缺少歌手 mid</div>`; return; }
  try {
    const d: any = await api(`/singer/${encodeURIComponent(mid)}/songs?num=50&page=1`);
    const songs: any[] = d?.song_list ?? [];
    if (!songs.length) { box.innerHTML = `<div class="muted">没有取到热门歌曲</div>`; return; }
    renderSongRows(box, songs, { showAlbum: true, onPlay: (s, i, all) => player.playList(all, i) });
  } catch (e: any) {
    box.innerHTML = `<div class="muted">加载失败：${e.message}</div>`;
  }
}

// —— 专辑页（点击行内专辑跳转的落点）：detail + songs 两个端点 ——
async function albumView(root: HTMLElement, q: URLSearchParams) {
  const mid = q.get("mid") || "";
  root.append(h("div", "rows", `<div class="muted">加载中…</div>`));
  if (!mid) { (root.querySelector(".rows") as HTMLElement).innerHTML = `<div class="muted">缺少专辑 mid</div>`; return; }
  try {
    const [detail, list] = await Promise.all([
      api<any>(`/album/${encodeURIComponent(mid)}/detail`).catch(() => null),
      api<any>(`/album/${encodeURIComponent(mid)}/songs?num=100`),
    ]);
    const alb = detail?.album ?? {};
    const songs: any[] = list?.song_list ?? [];
    root.innerHTML = "";
    const picMid = alb.pmid || alb.mid || mid;
    const singers: string = (alb.singer?.length ? alb.singer : detail?.singers ?? []).map((x: any) => x.name).join(" / ");
    const head = h("div", "pl-head");
    head.innerHTML = `
      <button class="pl-back" aria-label="返回" title="返回"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 6l-6 6 6 6"/></svg></button>
      <div class="pl-art">${picMid ? `<img src="https://y.gtimg.cn/music/photo_new/T002R300x300M000${picMid.split("_")[0]}.jpg" alt=""/>` : ""}</div>
      <div class="pl-info">
        <h1 class="pl-name">${alb.name ?? "专辑"}</h1>
        <div class="pl-meta">${singers}${alb.time_public ? ` · ${alb.time_public}` : ""}${list?.total_num ? ` · ${list.total_num} 首` : ""}</div>
        <div class="pl-desc muted">${(alb.desc || "").replace(/</g, "&lt;")}</div>
      </div>`;
    root.append(head);
    head.querySelector<HTMLElement>(".pl-back")!.onclick = () => history.length > 1 ? history.back() : (location.hash = "#/");
    const box = h("div", "rows");
    root.append(box);
    if (!songs.length) { box.innerHTML = `<div class="muted">没有取到歌曲</div>`; return; }
    renderSongRows(box, songs, { showArtist: true, showAlbum: false, onPlay: (s, i, all) => player.playList(all, i) });
  } catch (e: any) {
    root.innerHTML = ""; root.append(h("div", "rows muted", `加载失败：${e.message}`));
  }
}

// —— 列表页公共壳 ——
function listPage(root: HTMLElement, title: string, note?: string) {
  root.append(h("h1", "page-title", title));
  if (note) root.append(h("p", "muted page-note", note));
  const rows = h("div", "rows", `<div class="muted">加载中…</div>`);
  rows.id = "rows";
  root.append(rows);
  return rows;
}

async function guessView(root: HTMLElement) {
  const box = listPage(root, "猜你喜欢", "官方个性化推荐（推荐雷达 CGI），登录后可得更准结果。");
  try {
    const d: any = await api("/recommend/guess");
    const songs: any[] = d?.songs ?? [];
    if (!songs.length) { box.innerHTML = `<div class="muted">暂无推荐，登录后可得</div>`; return; }
    renderSongRows(box, songs, { onPlay: (s, i, all) => player.playList(all, i) });
  } catch (e: any) {
    box.innerHTML = `<div class="muted">${e.message}</div>`;
  }
}

async function dailyView(root: HTMLElement) {
  const box = listPage(root, "每日 30 首", '官方"每日30首"接口未开放；本页以「我喜欢」为基础，按日期种子稳定随机取 30 首。');
  // 当日稳定种子：mulberry32(date) —— 同一天刷新顺序不变，隔天换一批
  let t = (Math.floor(Date.now() / 86400000) * 2654435761) >>> 0;
  const rnd = () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
  try {
    const pool = await loadLiked(box, {}, 500).catch(() => [] as any[]);
    if (!pool.length) { box.innerHTML = `<div class="muted">需要先登录并收藏一些歌</div>`; return; }
    const picked: any[] = [];
    const idx = pool.map((_, i) => i);
    while (picked.length < 30 && idx.length) {
      const j = Math.floor(rnd() * idx.length);
      picked.push(pool[idx.splice(j, 1)[0]]);
    }
    box.innerHTML = "";
    renderSongRows(box, picked, { onPlay: (s, i, all) => player.playList(all, i) });
  } catch (e: any) {
    box.innerHTML = `<div class="muted">${e.message} — 需要先登录</div>`;
  }
}

async function likedView(root: HTMLElement) {
  root.append(h("h1", "page-title", "我喜欢 "));
  const cnt = h("span", "muted cnt");
  root.querySelector("h1")!.append(cnt);
  const box = h("div", "rows", `<div class="muted">加载中…</div>`);
  root.append(box);
  try {
    const songs = await loadLiked(box, { onPlay: (s, i, all) => player.playList(all, i) });
    cnt.textContent = songs.length ? `· ${songs.length} 首` : "";
  } catch (e: any) {
    box.innerHTML = `<div class="muted">${e.message} — 需要先登录</div>`;
  }
}

async function settingsView(root: HTMLElement) {
  root.append(h("h1", "page-title", "设置"));
  const wrap = h("div", "set-view");
  wrap.innerHTML = `
    <div class="set-row"><span>播放音质</span>
      <select id="quality" aria-label="播放音质">
        <option value="128">标准 128k</option>
        <option value="320">HQ 320k</option>
        <option value="flac">SQ 无损 FLAC</option>
      </select></div>
    <p class="muted">高品质档位取决于账号会员身份；非会员请求高档位会被降级。加密档位（mflac/qmc）需后续外挂解密代理。</p>
    <div class="set-row" id="sidecar-state"><span>Sidecar 状态</span><span class="muted">检测中…</span></div>`;
  root.append(wrap);
  const sel = wrap.querySelector<HTMLSelectElement>("#quality")!;
  sel.value = getQuality();
  sel.onchange = () => setQuality(sel.value as any);

  const st = wrap.querySelector<HTMLElement>("#sidecar-state .muted")!;
  api("/").then(() => (st.textContent = "✅ 正常（Python · QQMusicApi）")).catch((e) => (st.textContent = "❌ " + e.message));
}

async function userView(root: HTMLElement) {
  const wrap = h("div", "me");
  root.append(wrap);
  try {
    const [home, vip] = await Promise.all([
      api<any>("/user/me"),
      api<any>("/user/vip").catch(() => null),
    ]);
    const base = home?.base_info;
    if (!base?.name) { location.hash = "#/login"; return; }
    const badges: string[] = [];
    if (vip?.identity?.huge_vip) badges.push(`<i class="badge">豪华绿钻</i>`);
    else if (vip?.identity?.vip) badges.push(`<i class="badge">绿钻</i>`);
    if (vip?.svip) badges.push(`<i class="badge blue">超级会员</i>`);
    wrap.innerHTML = `
      <div class="avatar-big">${base.avatar ? `<img src="${String(base.avatar).replace(/^http:/, "https:")}" alt=""/>` : ""}</div>
      <h2 style="margin:12px 0 4px">${base.name}</h2>
      <div class="badges" style="justify-content:center">${badges.join("")}</div>
      <p class="muted">UID: ${base.encrypted_uin ?? ""}</p>
      <button id="logout" class="ghost-btn">退出登录</button>`;
    wrap.querySelector<HTMLElement>("#logout")!.onclick = async () => {
      await api("/login/logout", { method: "POST" }).catch(() => {});
      location.href = "/login.html"; // 登录态变化走整页，重置侧栏
    };
  } catch {
    location.hash = "#/login";
  }
}

// —— 登录页（扫码），内容区视图 ——
async function loginView(root: HTMLElement) {
  root.innerHTML = `
    <div class="login-wrap">
      <h2>扫码登录</h2>
      <p class="muted">用手机 QQ 音乐 App 或微信扫码。凭证由本机 sidecar 保存于 ~/.config/quaver/credential.json（0600），不进浏览器。</p>
      <div class="qr-box">
        <div id="qr" class="qr"><div class="muted">正在生成二维码…</div></div>
        <div id="lstate" class="muted"></div>
        <div class="row-btn">
          <select id="channel" aria-label="登录通道">
            <option value="mobile">QQ 音乐 App</option>
            <option value="qq">手机 QQ</option>
            <option value="wx">微信</option>
          </select>
          <button id="refresh" type="button">重新生成</button>
        </div>
      </div>
    </div>`;
  const qr = root.querySelector<HTMLElement>("#qr")!;
  const lstate = root.querySelector<HTMLElement>("#lstate")!;
  const channel = root.querySelector("#channel") as HTMLSelectElement;
  let timer: number | undefined;
  let stopped = false;

  async function start() {
    window.clearInterval(timer);
    qr.innerHTML = `<div class="muted">生成中…</div>`;
    lstate.textContent = "";
    let d: any;
    try {
      d = await api<any>(`/login/qrcode/${channel.value}`);
    } catch (e: any) {
      qr.innerHTML = `<div class="muted">${/429|backoff|频繁/.test(e.message) ? "操作太快，等 60-90s 再重试" : e.message}</div>`;
      return;
    }
    if (stopped) return;
    qr.innerHTML = `<img src="${d.img}" alt="登录二维码"/>`;
    lstate.textContent = "等待扫码…";

    timer = window.setInterval(async () => {
      if (stopped) { window.clearInterval(timer); return; }
      try {
        const c: any = await api(`/login/qrcode/${channel.value}/status?identifier=${encodeURIComponent(d.identifier)}`);
        if (c.event === 1) return; // SCAN
        if (c.event === 2) { lstate.textContent = "已扫码，请在手机上确认"; return; }
        if (c.event === 3) { lstate.textContent = "二维码已过期，点「重新生成」"; window.clearInterval(timer); return; }
        if (c.event === 4) { lstate.textContent = "已拒绝登录"; window.clearInterval(timer); return; }
        if (c.event === 0 && c.done) {
          window.clearInterval(timer);
          lstate.textContent = "✅ 登录成功，正在返回…";
          setTimeout(() => (location.href = "/index.html"), 800);
        }
      } catch { /* 瞬时网络抖动，下一轮再试 */ }
    }, 2000);
  }

  root.querySelector<HTMLElement>("#refresh")!.onclick = start;
  channel.onchange = start;
  start();

  return () => { stopped = true; window.clearInterval(timer); };
}

export const views: Record<string, (root: HTMLElement, q: URLSearchParams) => Promise<(() => void) | void>> = {
  "/": homeView,
  "/guess": guessView,
  "/daily": dailyView,
  "/liked": likedView,
  "/playlist": playlistView,
  "/singer": singerView,
  "/album": albumView,
  "/settings": settingsView,
  "/user": userView,
  "/login": loginView,
};
