// Quaver — 路由视图表（仅内容区渲染；播放器/侧栏常驻）
// 视图函数: async (root, query) => cleanup?
import { api, upPic, getQuality, setQuality, setSessionQuality, getStreamTiers, identityBadges } from "./lib/api";
import { renderSongRows, loadLiked, type RowHooks } from "./lib/songs";
import { getMyMusicid, isFavSonglist, loadFavSonglists, onFavSonglistsChange, toggleFavSonglist } from "./lib/favs";
import { pushHistory } from "./components/SearchBox";
import { player } from "./player";
import {
  getTheme, setTheme, getDecor, setDecor,
  getUiFontList, setUiFontList, setUiFontPreset,
  getLyricFontList, setLyricFontList, setLyricFontPreset,
  getDecode, getFade, FONT_LABELS, FONT_PRESETS, FONT_CUSTOM, fontKeyOf, normalizeFontList,
  getFallbackSort, setFallbackSort, getCloseAction, setCloseAction,
  type FadePreset,
} from "./lib/prefs";
import { configInfo, revealConfig, resetConfig } from "./lib/config";

const h = (tag: string, cls: string, html = "") => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  el.innerHTML = html;
  return el;
};

const escHtml = (s: string) =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export const BACK_SVG = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 6l-6 6 6 6"/></svg>`;

// 信息头（歌单/专辑/歌手共用）：左图 右「名称/详情/简介」整体上对齐；
// 简介默认两行截断，文本真溢出时出「展开」按钮（点一下显全文，再点收回）。
// 返回按钮不在这里——统一挂在壳层顶带（搜索框旁，见 shell.ts）。
function mountHead(root: HTMLElement, opts: {
  artHtml: string; artRound?: boolean; name: string; meta: string; desc: string;
  /** 信息头行动区（如歌单页的收藏按钮），挂在简介下方 */
  actions?: HTMLElement | null;
}) {
  const head = h("div", "pl-head");
  head.innerHTML = `
    <div class="pl-art${opts.artRound ? " round" : ""}">${opts.artHtml}</div>
    <div class="pl-info">
      <h1 class="pl-name">${escHtml(opts.name)}</h1>
      <div class="pl-meta">${escHtml(opts.meta)}</div>
      <div class="pl-desc muted">${escHtml(opts.desc)}</div>
    </div>`;
  if (opts.actions) {
    const box = h("div", "pl-actions");
    box.append(opts.actions);
    head.querySelector<HTMLElement>(".pl-info")!.append(box);
  }
  root.append(head);
  const desc = head.querySelector<HTMLElement>(".pl-desc")!;
  if (opts.desc) {
    // 截断检测在下一帧做（-webkit-line-clamp 生效后 scrollHeight 才可比）
    requestAnimationFrame(() => {
      if (desc.scrollHeight - desc.clientHeight <= 2) return; // 两行内放得下：不需要按钮
      const btn = h("button", "pl-expand", "展开") as HTMLButtonElement;
      btn.type = "button";
      btn.onclick = () => {
        const open = desc.classList.toggle("open");
        btn.textContent = open ? "收起" : "展开";
      };
      desc.after(btn);
    });
  }
  return head;
}

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

// —— 歌单页收藏按钮（在线收藏写接口：PlaylistFavWrite Fav/CancelFavPlaylist） ——
// 收藏态取自 lib/favs 的收藏歌单缓存（与侧栏同源，收藏后侧栏同帧出现）；
// 自有歌单不渲染（不能收藏自己的歌单），未登录不渲染（收藏必须带登录态）。
async function favSonglistButton(meta: {
  id: string; title: string; picurl?: string; songnum?: number; creatorMusicid?: number;
}): Promise<HTMLElement | null> {
  const myId = await getMyMusicid();
  if (!myId) return null;
  if (meta.creatorMusicid && Number(meta.creatorMusicid) === myId) return null;
  // 收藏列表没拉到（未登录/上游失败）也照常给按钮：点击时写接口会给出真实错误
  await loadFavSonglists().catch(() => [] as any[]);

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "fav-btn";
  btn.dataset.plid = meta.id;
  const paint = () => {
    const on = isFavSonglist(meta.id);
    btn.classList.toggle("on", on);
    btn.innerHTML = `<span class="fb-ic">${on ? "♥" : "♡"}</span><span>${on ? "已收藏" : "收藏"}</span>`;
    btn.title = on ? "从我的收藏中移除" : "收藏这首歌单";
  };
  paint();
  btn.onclick = async () => {
    const off = onFavSonglistsChange(() => { if (!btn.dataset.fail) paint(); });
    btn.disabled = true;
    try {
      await toggleFavSonglist({ id: meta.id, title: meta.title, picurl: meta.picurl, songnum: meta.songnum });
    } catch (e: any) {
      console.warn("收藏歌单失败", e);
      btn.dataset.fail = "1";
      btn.classList.add("failed");
      btn.setAttribute("title", String(e?.message ?? e));
      btn.innerHTML = `<span class="fb-ic">!</span><span>收藏失败</span>`;
      window.setTimeout(() => {
        delete btn.dataset.fail;
        btn.classList.remove("failed");
        paint();
      }, 2600);
    } finally {
      btn.disabled = false;
      off();
      if (!btn.dataset.fail) paint();
    }
  };
  return btn;
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
  // 收藏态与自身音乐号跟歌单详情并行取，信息头渲染时按钮已就绪（不等额外往返）
  const favsReady = Promise.all([getMyMusicid(), loadFavSonglists().catch(() => [])]);
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

  const logo = upPic(info?.picurl || "");
  const metaParts = [info?.creator?.nick ? `${info.creator.nick} 制作` : "", info?.songnum ? `${info.songnum} 首` : ""].filter(Boolean);
  await favsReady.catch(() => {});
  mountHead(root, {
    artHtml: logo ? `<img src="${logo}" alt=""/>` : "",
    name: info?.title ?? name,
    meta: metaParts.join(" · "),
    desc: info?.desc || "",
    actions: await favSonglistButton({
      id,
      title: info?.title ?? name,
      picurl: logo,
      songnum: info?.songnum,
      creatorMusicid: info?.creator?.musicid,
    }).catch(() => null),
  });

  const rows = h("div", "rows");
  root.append(rows);
  if (!songs.length) {
    rows.innerHTML = `<div class="muted">歌单为空或不可见</div>`;
    return;
  }
  const hooks: RowHooks = { showAlbum: true, onPlay: (s, i, all) => player.playList(all, i) };
  renderSongRows(rows, songs, hooks);
}

// 专辑卡网格（歌手页「专辑」标签 / 歌手全部专辑页共用同一套卡面）
function albumCardsHtml(albums: any[]): string {
  return albums.map((x) => {
    const pm: string = x.pmid || x.mid || "";
    const cover = pm ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${pm.split("_")[0]}.jpg` : "";
    const sub = [x.album_type, x.time_public].filter(Boolean).join(" · ");
    return `<a class="card" href="#/album?mid=${encodeURIComponent(x.mid ?? "")}&name=${encodeURIComponent(x.name || "专辑")}">
      <div class="art">${cover ? `<img src="${cover}" alt="" loading="lazy"/>` : ""}</div>
      <div class="name">${escHtml(x.name || "专辑")}</div><div class="sub">${escHtml(sub)}</div></a>`;
  }).join("");
}

// —— 歌手页（点击行内歌手跳转的落点）：信息头 + 分类标签（热歌 / 新歌 / 专辑） ——
// 三块内容一次性并拉，标签只决定「显示哪一块」：切换不重新请求、不重置 .route 滚动位置。
// 默认落在「热歌」。信息头仍与歌单/专辑页同一套（左图右文、上对齐）。
const SINGER_TABS = [
  { key: "hot", label: "热歌" },
  { key: "new", label: "新歌" },
  { key: "album", label: "专辑" },
] as const;

async function singerView(root: HTMLElement, q: URLSearchParams) {
  const mid = q.get("mid") || "";
  const name = decodeURIComponent(q.get("name") || "歌手");
  root.append(h("div", "rows", `<div class="muted">加载中…</div>`));
  if (!mid) { (root.querySelector(".rows") as HTMLElement).innerHTML = `<div class="muted">缺少歌手 mid</div>`; return; }
  // 五路并拉（热门/最新两种排序各拉一份）；简介/专辑失败不阻塞主内容（各 .catch 归 null）
  const [homeInfo, detail, songData, newSongData, albumData] = await Promise.all([
    api<any>(`/singer/${encodeURIComponent(mid)}/info`).catch(() => null),
    api<any>(`/singer/${encodeURIComponent(mid)}/desc`).catch(() => null),
    api<any>(`/singer/${encodeURIComponent(mid)}/songs?num=50&page=1&order=1`).catch(() => null),
    api<any>(`/singer/${encodeURIComponent(mid)}/songs?num=30&page=1&order=2`).catch(() => null),
    api<any>(`/singer/${encodeURIComponent(mid)}/albums?num=30`).catch(() => null),
  ]);
  root.innerHTML = "";

  const base = homeInfo?.base_info ?? {};
  const displayName = base.name || detail?.name || name;
  const avatar = upPic(base.avatar || detail?.pic) ||
    `https://y.gtimg.cn/music/photo_new/T001R300x300M000${mid}.jpg`;
  const meta = [
    detail?.foreign_name && detail.foreign_name !== displayName ? detail.foreign_name : "",
    detail?.area, detail?.birthday,
    songData?.total_num ? `歌曲 ${songData.total_num}` : "",
    albumData?.total ? `专辑 ${albumData.total}` : "",
  ].filter(Boolean).join(" · ");
  mountHead(root, {
    artHtml: `<img src="${avatar}" alt=""/>`,
    artRound: true,
    name: displayName,
    meta,
    desc: detail?.desc || "",
  });

  const songs: any[] = songData?.song_list ?? [];
  const hotKeys = new Set(songs.map((s) => s.mid));
  // 最新发布（order=2 按发行时间倒序）：与热门同列风格，去掉与热门完全重合的条目
  const newSongs: any[] = ((newSongData?.song_list ?? []) as any[]).filter((s) => !hotKeys.has(s.mid));
  const albums: any[] = albumData?.album_list ?? [];

  // 标签栏 + 面板组：三块常驻 DOM，select() 只切 hidden
  const tabs = h("div", "tag-tabs");
  tabs.innerHTML = SINGER_TABS.map(
    (t) => `<button class="tag" type="button" data-tab="${t.key}">${t.label}</button>`,
  ).join("");
  const body = h("div", "tag-body");
  root.append(tabs, body);

  const songPanel = (list: any[], empty: string) => {
    const p = h("div", "tag-panel");
    if (!list.length) { p.innerHTML = `<div class="rows muted">${empty}</div>`; return p; }
    const rows = h("div", "rows");
    p.append(rows);
    renderSongRows(rows, list, { showAlbum: true, onPlay: (s, i, all) => player.playList(all, i) });
    return p;
  };

  const hotPanel = songPanel(songs, "没有取到热门歌曲");
  const newPanel = songPanel(newSongs, "暂无新歌");
  const albumPanel = h("div", "tag-panel");
  if (albums.length) {
    const more = h("div", "sec-row");
    more.style.marginTop = "0";
    more.innerHTML = `<span class="muted">共 ${albumData?.total ?? albums.length} 张</span>
      <a class="sec-more" href="#/singer-albums?mid=${encodeURIComponent(mid)}&name=${encodeURIComponent(displayName)}">查看全部 ›</a>`;
    const grid = h("div", "grid");
    grid.innerHTML = albumCardsHtml(albums);
    albumPanel.append(more, grid);
  } else {
    albumPanel.innerHTML = `<div class="rows muted">暂无专辑</div>`;
  }
  const panels = [hotPanel, newPanel, albumPanel];
  body.append(...panels);

  const select = (key: string) => {
    panels.forEach((p, i) => (p.hidden = SINGER_TABS[i].key !== key));
    tabs.querySelectorAll<HTMLElement>(".tag").forEach((b) => b.classList.toggle("sel", b.dataset.tab === key));
  };
  tabs.querySelectorAll<HTMLElement>(".tag").forEach((b) => (b.onclick = () => select(b.dataset.tab!)));
  select("hot");
}

// —— 歌手全部专辑页：信息头复用歌手页样式 + 全部分页拉取专辑网格 ——
async function singerAlbumsView(root: HTMLElement, q: URLSearchParams) {
  const mid = q.get("mid") || "";
  const name = decodeURIComponent(q.get("name") || "歌手");
  root.append(h("div", "rows", `<div class="muted">加载中…</div>`));
  if (!mid) { (root.querySelector(".rows") as HTMLElement).innerHTML = `<div class="muted">缺少歌手 mid</div>`; return; }
  // 分页拉全：上游单页封顶 30（num 再大也只回 30），循环条件按 total + 空批兜底
  const albums: any[] = [];
  let total = 0;
  try {
    for (let page = 1; ; page++) {
      const d: any = await api<any>(`/singer/${encodeURIComponent(mid)}/albums?num=30&page=${page}`);
      const batch: any[] = d?.album_list ?? [];
      albums.push(...batch);
      total = d?.total ?? 0;
      if (!batch.length || albums.length >= total) break;
    }
  } catch (e: any) {
    if (!albums.length) { root.innerHTML = ""; root.append(h("div", "rows muted", `加载失败：${e.message}`)); return; }
  }
  root.innerHTML = "";
  const avatar = `https://y.gtimg.cn/music/photo_new/T001R300x300M000${mid}.jpg`;
  mountHead(root, {
    artHtml: `<img src="${avatar}" alt=""/>`,
    artRound: true,
    name: `${name}的专辑`,
    meta: total ? `共 ${total} 张` : "",
    desc: "",
  });
  if (!albums.length) { root.append(h("div", "rows muted", "暂无专辑")); return; }
  const grid = h("div", "grid");
  grid.innerHTML = albumCardsHtml(albums);
  root.append(grid);
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
    const metaParts = [
      singers,
      alb.time_public,
      list?.total_num ? `${list.total_num} 首` : "",
    ].filter(Boolean);
    mountHead(root, {
      artHtml: picMid ? `<img src="https://y.gtimg.cn/music/photo_new/T002R300x300M000${picMid.split("_")[0]}.jpg" alt=""/>` : "",
      name: alb.name ?? "专辑",
      meta: metaParts.join(" · "),
      desc: alb.desc || "",
    });
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
  const box = listPage(root, "猜你喜欢", "品味懂你意思");
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

/** 两次预载列表是否同一批曲（同序同 mid）：一样就不重画，避免打断滚动 */
const sameMids = (a: any[], b: any[]) => a.length === b.length && a.every((x, i) => x.mid === b[i]?.mid);

async function likedView(root: HTMLElement) {
  root.append(h("h1", "page-title", "我喜欢 "));
  const cnt = h("span", "muted cnt");
  root.querySelector("h1")!.append(cnt);
  const box = h("div", "rows", `<div class="muted">加载中…</div>`);
  root.append(box);

  let shown = 0; // 标题计数（服务端 total 优先：超预载上限时也报真实总数）
  const setCount = (n: number) => { shown = Math.max(0, n); cnt.textContent = shown ? `· ${shown} 首` : ""; };
  // 取消收藏：行淡出后移出本页 + 计数 -1。只在写接口确认后调用——失败已在 player 侧回滚，不会触发
  const dropRow = (song: any) => {
    const key = String(song._key ?? song.mid ?? "");
    const row = key ? box.querySelector<HTMLElement>(`.row[data-songkey="${CSS.escape(key)}"]`) : null;
    if (!row || row.classList.contains("leaving")) return;
    row.classList.add("leaving");
    setCount(shown - 1);
    setTimeout(() => row.remove(), 220);
  };
  const paint = (songs: any[]) => {
    setCount(Math.max(songs.length, player.likedTotal));
    renderSongRows(box, songs, {
      onPlay: (s, i, all) => player.playList(all, i),
      onLove: (song, on) => { if (!on) dropRow(song); }, // 取消红心 = 取消单曲收藏 + 移出本页
    });
  };

  // 预载命中（开机已拉回）：首帧直接出，红心默认全部点亮；随后按 TTL 后台对账，内容变了才重画
  const cached = player.likedCache as any[] | null;
  if (cached) paint(cached);
  const ok = await player.loadLoved();
  if (!ok) {
    if (!cached) box.innerHTML = `<div class="muted">加载失败 — 需要先登录</div>`;
    return;
  }
  const fresh: any[] = player.likedCache ?? [];
  if (!cached || !sameMids(cached, fresh)) paint(fresh);
}

// —— 设置页（对齐设计稿：外观设置 / 播放设置 / 调试 三区；不触碰侧栏与播放条） ——
async function settingsView(root: HTMLElement) {
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  const fontOptions = Object.entries(FONT_LABELS).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")
    + `<option value="${FONT_CUSTOM}">自定义</option>`;
  const decodeRow = (name: string, label: string, disabled = false) =>
    `<label><input type="radio" name="decode" value="${name}"${disabled ? " disabled" : ""}/>${label}${disabled ? ` <span class="muted soon">敬请期待</span>` : ""}</label>`;

  root.append(h("h1", "page-title", "设置"));
  const wrap = h("div", "set-view");
  wrap.innerHTML = `
    <section class="set-sec">
      <h2>外观设置</h2>
      <p class="muted set-note">在这里，可以设置 Quaver 的客户端外观</p>

      <div class="set-sub">外观模式</div>
      <div class="opt-cards" id="theme-cards">
        <button class="opt-card" data-opt="system" type="button"><span class="sw sw-system"></span>跟随系统</button>
        <button class="opt-card" data-opt="light" type="button"><span class="sw sw-light"></span>明镜白</button>
        <button class="opt-card" data-opt="dark" type="button"><span class="sw sw-dark"></span>玄幻黑</button>
      </div>

      <div class="set-sub">窗口装饰 <span class="muted set-subnote">- 仅桌面端生效，切换后自动重建窗口</span></div>
      <div class="opt-cards" id="decor-cards">
        <button class="opt-card" data-opt="csd" type="button">自绘标题栏（CSD）</button>
        <button class="opt-card" data-opt="ssd" type="button">系统标题栏（SSD）</button>
      </div>

      <div class="set-sub">关闭按钮行为 <span class="muted set-subnote">- 点窗口右上角 ✕ 时（CSD/SSD 通用）</span></div>
      <div class="opt-cards" id="close-cards">
        <button class="opt-card" data-opt="tray" type="button">缩放到托盘</button>
        <button class="opt-card" data-opt="quit" type="button">退出程序</button>
      </div>
      <p class="muted set-hint">缩放到托盘：窗口隐藏，播放与系统托盘图标继续，托盘菜单「退出」才结束程序。</p>

      <div class="set-sub">字体设置</div>
      <div class="set-field"><span>界面字体</span>
        <div class="font-row">
          <select id="font-ui" aria-label="界面字体预设">${fontOptions}</select>
          <input id="font-ui-list" type="text" spellcheck="false" autocomplete="off"
            aria-label="界面字体 font-family 列表"
            placeholder="留空，如 Source Han Sans, system-ui, sans-serif" />
        </div>
      </div>
      <div class="set-field"><span>歌词字体</span>
        <div class="font-row">
          <select id="font-lyric" aria-label="歌词字体预设">${fontOptions}</select>
          <input id="font-lyric-list" type="text" spellcheck="false" autocomplete="off"
            aria-label="歌词字体 font-family 列表" placeholder="" />
        </div>
      </div>
      <p class="muted set-hint">输入框里填的就是 CSS font-family 列表（逗号分隔、按优先级挑第一个装得上的），改完即时生效；留空表示不覆盖，走内置默认栈。</p>
    </section>

    <section class="set-sec">
      <h2>播放设置</h2>
      <p class="muted set-note">在这里，可以设置 Quaver 的播放设置</p>

      <div class="set-sub">后端模式</div>
      <p class="muted set-note">如果播放音频出现问题可在这设置</p>
      <div id="backend-device"${isMac ? " hidden" : ""}>
        <label class="set-field"><span>音频输出设备</span>
          <select id="audio-backend" disabled><option>系统默认</option></select></label>
        <p class="muted set-hint" id="audio-device-hint">MPV 引擎下可直选输出设备（PipeWire/Pulse/ALSA…），切换即时生效；浏览器后端跟随系统。</p>
      </div>
      <div class="set-sub set-sub2">播放引擎 <span class="muted set-subnote" id="engine-note">- 默认 MPV，可选浏览器</span></div>
      <div class="opt-radios" id="decode-radios">
        ${decodeRow("MPV", "MPV（原生引擎）")}${decodeRow("Blink", "浏览器 &lt;audio&gt;")}
      </div>
      <p class="muted set-hint" id="engine-hint">MPV：主进程原生播放，带内存滑动窗口缓存与设备直选，MPRIS/媒体键体验最完整；浏览器：渲染层 &lt;audio&gt; 兜底。切换即时生效，当前曲目换轨续播。</p>

      <div class="set-sub set-sub2">淡入淡出 <span class="muted set-subnote">- 仅 MPV 引擎生效</span></div>
      <div class="opt-cards" id="fade-cards">
        <button class="opt-card" data-opt="off" type="button">关闭</button>
        <button class="opt-card" data-opt="short" type="button">短（0.15s）</button>
        <button class="opt-card" data-opt="normal" type="button">标准（0.4s）</button>
        <button class="opt-card" data-opt="long" type="button">长（0.8s）</button>
      </div>
      <p class="muted set-hint">起播从静音升到当前音量；暂停 / 切歌 / 停止时先降下来再停（切歌时淡出与下一首的淡入自然衔接）。浏览器 &lt;audio&gt; 后端不生效。</p>

      <div class="set-sub">默认音质 <span class="muted set-subnote" id="q-member-note"></span></div>
      <div class="opt-cards" id="quality-grid">
        <button class="opt-card q" data-q="auto" type="button">自动</button>
      </div>
      <div class="set-sub set-sub2">Fallback 排序 <span class="muted set-subnote">- 高档不可用时的降档顺序</span></div>
      <div class="opt-cards" id="qfallback-cards">
        <button class="opt-card" data-opt="no-atmos" type="button">不优先全景声</button>
        <button class="opt-card" data-opt="rank" type="button">按标准排序</button>
      </div>
      <p class="muted set-hint">自动/降档时优先取到「臻品母带」，跳过「臻品全景声」（显式点选全景声不受影响）；「按标准排序」则回退链保持 rank 降序原样。</p>
      <p class="muted set-hint">档位即时生效（下一首起按新音质协商取链）。臻品母带/全景声等高档位仅限会员；本后端只流播明文档，不提供加密档（QMC）解密。</p>
    </section>

    <section class="set-sec">
      <h2>配置文件</h2>
      <p class="muted set-note">以下设置全部持久化在系统标准配置目录的 <code>quaver.conf</code>（INI）里，可以直接手改；登录凭证在同一目录，不进浏览器。</p>
      <label class="set-field"><span>配置文件</span>
        <input id="conf-path" readonly /></label>
      <div class="set-debug">
        <button class="ghost-btn" id="open-conf" type="button">在文件管理器中显示</button>
        <button class="ghost-btn" id="reset-conf" type="button">恢复默认设置</button>
      </div>
      <p class="muted set-hint" id="conf-hint"></p>
    </section>

    <section class="set-sec">
      <h2>调试</h2>
      <div class="set-debug"><button class="ghost-btn" id="open-log" type="button">打开日志页面</button></div>
    </section>
    <section class="set-sec">
      <h2>关于</h2>
      <div class="about-img"><img class="ic-dark" src="/quaver-icon-dark.svg" width=60 alt="Quaver Icon"><img class="ic-light" src="/quaver-icon.svg" width=60 alt="Quaver Icon">
      <h3> Quaver Music </h3>
      <h4> 又一个基于 Electron + Vite 前端 + TS/Py 混合后端的 QQ 音乐第三方客户端</h4>
      <small> Version: ${__APP_VERSION__} </small>
    </section>`
    ;

  root.append(wrap);

  const syncSel = (box: HTMLElement, attr: "opt" | "q", active: string) =>
    box.querySelectorAll<HTMLElement>("[data-" + attr + "]").forEach((b) => b.classList.toggle("sel", b.dataset[attr] === active));

  // 外观模式：跟随系统 / 明镜白 / 玄幻黑（prefs 写 html[data-theme]，style.css 响应）
  const themeBox = wrap.querySelector<HTMLElement>("#theme-cards")!;
  const syncTheme = () => syncSel(themeBox, "opt", getTheme());
  themeBox.querySelectorAll<HTMLElement>("[data-opt]").forEach((b) => { b.onclick = () => { setTheme(b.dataset.opt as any); syncTheme(); }; });
  syncTheme();

  // 窗口装饰：CSD（右上角自绘按钮簇）/ SSD（系统标题栏）。Electron 桥重建窗口；浏览器仅隐藏按钮簇。
  const decorBox = wrap.querySelector<HTMLElement>("#decor-cards")!;
  const syncDecor = () => syncSel(decorBox, "opt", getDecor());
  decorBox.querySelectorAll<HTMLElement>("[data-opt]").forEach((b) => { b.onclick = () => { setDecor(b.dataset.opt as any); syncDecor(); }; });
  syncDecor();

  // 关闭按钮行为：缩放到托盘 / 退出程序（Electron 桥同步主进程；浏览器 dev 无效果）
  const closeBox = wrap.querySelector<HTMLElement>("#close-cards")!;
  const syncClose = () => syncSel(closeBox, "opt", getCloseAction());
  closeBox.querySelectorAll<HTMLElement>("[data-opt]").forEach((b) => { b.onclick = () => { setCloseAction(b.dataset.opt as any); syncClose(); }; });
  syncClose();

  // Fallback 排序：默认「不优先全景声」（母带优先，atmos51 压链尾兜底）；改动自下一首协商起生效
  const fbBox = wrap.querySelector<HTMLElement>("#qfallback-cards")!;
  const syncFb = () => syncSel(fbBox, "opt", getFallbackSort());
  fbBox.querySelectorAll<HTMLElement>("[data-opt]").forEach((b) => { b.onclick = () => { setFallbackSort(b.dataset.opt as any); syncFb(); }; });
  syncFb();

  // 淡入淡出预设：持久化 + 立即下发时长（引擎侧做振幅包络；Blink 后端无此项）
  const fadeBox = wrap.querySelector<HTMLElement>("#fade-cards")!;
  const syncFade = () => syncSel(fadeBox, "opt", getFade());
  fadeBox.querySelectorAll<HTMLElement>("[data-opt]").forEach((b) => {
    b.onclick = () => { void player.setFadePreset(b.dataset.opt as FadePreset); syncFade(); };
  });
  syncFade();

  // 字体：下拉给预设，右侧输入框可直接编辑 CSS font-family 列表（不必再去手改配置文件）。
  // 两边互相同步：选预设 → 填进输入框；输入框改成非预设值 → 下拉自动切到「自定义」。输入即时生效。
  const bindFont = (
    sel: HTMLSelectElement,
    input: HTMLInputElement,
    applyList: (css: string) => void,
    pickPreset: (key: string) => void,
    current: string,
  ) => {
    input.value = current;
    sel.value = fontKeyOf(current);
    sel.onchange = () => {
      if (sel.value === FONT_CUSTOM) return; // 「自定义」= 保持输入框现有内容，不动配置
      const css = FONT_PRESETS[sel.value]?.css ?? "";
      input.value = css;
      pickPreset(sel.value);
    };
    input.oninput = () => { applyList(input.value); sel.value = fontKeyOf(input.value); };
    // 失焦时把输入框回写成规范化结果，跟落进配置的值保持一致（多余空格、半截分号都在这里清掉）
    input.onchange = () => {
      const norm = normalizeFontList(input.value);
      if (norm !== input.value) input.value = norm;
      applyList(norm);
      sel.value = fontKeyOf(norm);
    };
  };
  bindFont(
    wrap.querySelector<HTMLSelectElement>("#font-ui")!,
    wrap.querySelector<HTMLInputElement>("#font-ui-list")!,
    setUiFontList, setUiFontPreset, getUiFontList(),
  );
  bindFont(
    wrap.querySelector<HTMLSelectElement>("#font-lyric")!,
    wrap.querySelector<HTMLInputElement>("#font-lyric-list")!,
    setLyricFontList, setLyricFontPreset, getLyricFontList(),
  );

  // 配置文件：展示磁盘路径 + 一键定位 / 重置（浏览器 dev 下没有文件，只提示真相在哪）
  const conf = configInfo();
  const confPath = wrap.querySelector<HTMLInputElement>("#conf-path")!;
  const confHint = wrap.querySelector<HTMLElement>("#conf-hint")!;
  const openBtn = wrap.querySelector<HTMLButtonElement>("#open-conf")!;
  const resetBtn = wrap.querySelector<HTMLButtonElement>("#reset-conf")!;
  if (conf.bridged) {
    confPath.value = conf.path;
    confHint.textContent = conf.writable
      ? "手改后重启应用生效（改坏的值会自动回落默认，不影响启动）。"
      : "⚠️ 配置目录不可写，本次改动只在本进程内生效。";
  } else {
    confPath.value = "（浏览器模式：设置在 localStorage）";
    confHint.textContent = "当前跑在浏览器里，改动只存在本机浏览器存储；用 Electron 壳层启动才会落到 quaver.conf。";
    openBtn.disabled = true;
    resetBtn.disabled = true;
  }
  openBtn.onclick = () => { void revealConfig(); };
  resetBtn.onclick = async () => {
    if (!confirm("用模板重建 quaver.conf？主题 / 字体 / 播放 / 音质等设置会回到默认值，登录凭证不受影响。")) return;
    await resetConfig();
    location.reload(); // 重置后整页重来，省得逐项刷 UI 状态
  };

  // —— 播放引擎：MPV（默认，原生）/ Blink（浏览器 <audio>）。热切换当前曲目换轨续播。
  const radios = wrap.querySelectorAll<HTMLInputElement>("#decode-radios input");
  const devSel = wrap.querySelector<HTMLSelectElement>("#audio-backend")!;
  const devHint = wrap.querySelector<HTMLElement>("#audio-device-hint")!;
  const engNote = wrap.querySelector<HTMLElement>("#engine-note")!;

  /** mpv 来源标签：随包运行时 / 系统 mpv / QUAVER_MPV 指定（排障时一眼看出跑的哪一份） */
  const MPV_SOURCE_LABEL: Record<string, string> = { bundled: "随包运行时", path: "系统 mpv", env: "QUAVER_MPV 指定" };

  async function paintBackend() {
    const st = await player.probeEngine();
    radios.forEach((r) => {
      r.disabled = r.value === "MPV" && !st.available;
      r.checked = r.value === getDecode();
      r.onchange = () => { if (r.checked) void player.setBackend(r.value as "MPV" | "Blink").then(paintAll); };
    });
    const src = MPV_SOURCE_LABEL[st.source] ?? "";
    engNote.textContent = player.backend === "mpv"
      ? `- MPV 运行中${src ? "（" + src + "）" : ""}`
      : st.available ? `- 默认 MPV（${src}），当前浏览器兜底` : "- " + (st.reason || "mpv 不可用，已回退浏览器音频");
  }

  async function paintDevices() {
    devSel.disabled = true;
    devSel.onchange = null;
    const r = await player.listAudioDevices();
    if (!r) {
      devSel.innerHTML = `<option>系统默认</option>`;
      devHint.textContent = "浏览器 <audio> 后端：跟随系统输出设备；切换到 MPV 引擎后可在此直选设备。";
      return;
    }
    devSel.innerHTML = `<option value="auto">系统默认</option>`
      + r.devices.map((d) => `<option value="${escHtml(d.id)}">${escHtml(d.desc)}</option>`).join("");
    const cur = r.devices.some((d) => d.id === r.current) ? r.current : "auto";
    devSel.value = cur;
    devSel.disabled = false;
    devHint.textContent = "切换即时生效，无需重启。";
    devSel.onchange = () => { void player.selectAudioDevice(devSel.value); };
  }

  async function paintAll() { await paintBackend(); await paintDevices(); }
  void paintAll();
  // 引擎传输热切换（启动探测/设置页切换）后刷新设备列表——只在后端真正变化时，别跟着 4Hz notify 空转
  let lastBackend = player.backend;
  player.on(() => {
    if (player.backend !== lastBackend) {
      lastBackend = player.backend;
      void paintBackend();
      void paintDevices();
    }
  });

  // 默认音质：档位由后端按会员等级下发（/stream/tiers）；locked 档画锁标不可选。
  const qBox = wrap.querySelector<HTMLElement>("#quality-grid")!;
  const qNote = wrap.querySelector<HTMLElement>("#q-member-note")!;
  const syncQ = () => syncSel(qBox, "q", getQuality());
  const bindQ = () => {
    qBox.querySelectorAll<HTMLButtonElement>("[data-q]").forEach((b) => {
      if (!b.disabled) b.onclick = () => {
        setQuality(b.dataset.q as any);
        setSessionQuality(null); // 播放条会话覆盖让位给新的默认档（新档自下一首起生效）
        syncQ();
        player.notifyPublic();
      };
    });
  };
  bindQ(); syncQ();
  getStreamTiers(true).then((t) => {
    qNote.textContent = `（当前：${t.membership_label}${t.membership ? "" : "，高档位需会员"}）`;
    for (const tier of t.all_tiers) {
      const btn = document.createElement("button");
      btn.className = "opt-card q";
      btn.dataset.q = tier.id;
      btn.type = "button";
      btn.innerHTML = tier.label + (tier.hi_res ? ' <span class="muted soon">Hi-Res</span>' : "")
        + (tier.locked ? ' <span class="q-lock">🔒会员</span>' : "");
      if (tier.locked) btn.disabled = true;
      qBox.append(btn);
    }
    bindQ(); syncQ();
  }).catch(() => { qNote.textContent = "（音质服务不可用）"; });

  // 调试：日志页面（壳层把 ui/electron-dev.log 经 /api/log 尾部暴露为纯文本，见 relay.ts）
  wrap.querySelector<HTMLElement>("#open-log")!.onclick = () => (location.hash = "#/log");
}

// —— 调试：日志页面（壳层 electron-dev.log 尾部；由 relay.ts /api/log 提供） ——
async function logView(root: HTMLElement) {
  const bar = h("div", "log-bar");
  const pre = h("pre", "log-pre", `<span class="muted">加载中…</span>`);
  const back = h("button", "ghost-btn", "返回设置");
  const refresh = h("button", "ghost-btn", "刷新");
  const meta = h("span", "muted");
  bar.append(back, refresh, meta);
  root.append(bar, pre);
  back.onclick = () => (location.hash = "#/settings");
  async function load() {
    meta.textContent = "读取中…";
    try {
      const r = await fetch("/api/log?tail=800");
      if (!r.ok) throw new Error((await r.json().catch(() => null))?.msg || `HTTP ${r.status}`);
      pre.textContent = await r.text();
      meta.textContent = "来源 ui/electron-dev.log（尾部 800 行）";
      pre.scrollTop = pre.scrollHeight;
    } catch (e: any) {
      pre.innerHTML = "";
      pre.append(h("span", "muted", `读不到日志：${e.message}（Electron 壳层未运行时属正常）`));
      meta.textContent = "";
    }
  }
  refresh.onclick = load;
  await load();
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
    wrap.innerHTML = `
      <div class="avatar-big">${base.avatar ? `<img src="${String(base.avatar).replace(/^http:/, "https:")}" alt=""/>` : ""}</div>
      <h2 style="margin:12px 0 4px">${base.name}</h2>
      <div class="badges" style="justify-content:center">${identityBadges(home, vip)}</div>
      <p class="muted">UID: ${base.encrypted_uin ?? ""}</p>
      <button id="logout" class="ghost-btn danger">退出登录</button>`;
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
      <p class="muted">用手机 QQ 音乐 App 或微信扫码。凭证由本机 sidecar 保存于系统配置目录的 credential.json（0600，Linux 在 ~/.config/quaver-music），不进浏览器。</p>
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

// —— 搜索页（顶部常驻搜索框的落点视图）：热搜词 + 分类标签（歌曲/歌手/专辑/歌单） ——
const SEARCH_TABS = [
  { type: "0", label: "歌曲" },
  { type: "1", label: "歌手" },
  { type: "2", label: "专辑" },
  { type: "3", label: "歌单" },
] as const;

async function searchView(root: HTMLElement, q: URLSearchParams) {
  const kw = (q.get("keyword") || "").trim();
  const tab = SEARCH_TABS.find((t) => t.type === (q.get("type") ?? "0")) ?? SEARCH_TABS[0];
  const head = h("div", "search-head");
  head.innerHTML = `<h1 class="page-title" style="margin:6px 0 4px">${kw ? `“${kw.replace(/</g, "&lt;")}”的搜索结果` : "搜索"}</h1>
    <div class="search-tabs">${SEARCH_TABS.map(
      (t) => `<button class="stab${t.type === tab.type ? " sel" : ""}" data-type="${t.type}" type="button">${t.label}</button>`,
    ).join("")}</div>`;
  const box = h("div", "search-body", `<div class="muted">搜索中…</div>`);
  root.append(head, box);
  head.querySelectorAll<HTMLElement>(".stab").forEach((b) => {
    b.onclick = () => {
      if (b.dataset.type === tab.type) return;
      location.hash = `#/search?keyword=${encodeURIComponent(kw)}&type=${b.dataset.type}`;
    };
  });
  if (!kw) {
    // 空关键词：展示热搜词，点一个即搜
    box.innerHTML = "";
    try {
      const d: any = await api("/search/hotkey");
      const keys: string[] = (d?.vec_hotkey ?? []).map((x: any) => x.title || x.query).filter(Boolean);
      box.innerHTML = keys.length
        ? `<div class="hot-chips">${keys.map((k) => `<button class="chip" type="button">${k.replace(/</g, "&lt;")}</button>`).join("")}</div>`
        : `<div class="muted">输入关键词后回车即可搜索</div>`;
      box.querySelectorAll<HTMLElement>(".chip").forEach((c) => {
        c.onclick = () => {
          pushHistory(c.textContent || "");
          location.hash = `#/search?keyword=${encodeURIComponent(c.textContent || "")}`;
        };
      });
    } catch (e: any) {
      box.innerHTML = `<div class="muted">${e.message}</div>`;
    }
    return;
  }
  const go = (page: number) => {
    location.hash = `#/search?keyword=${encodeURIComponent(kw)}&type=${tab.type}&page=${page}`;
  };
  const page = Math.max(1, parseInt(q.get("page") || "1", 10) || 1);
  try {
    const d: any = await api(`/search?keyword=${encodeURIComponent(kw)}&type=${tab.type}&page=${page}&num=30`);
    box.innerHTML = "";
    // 注意：响应各分类字段恒在（其余类为空数组），必须按当前 tab 显式取，不能用 ?? 链
    const list: any[] = (tab.type === "0" ? d?.song : tab.type === "1" ? d?.singer : tab.type === "2" ? d?.album : d?.songlist) ?? [];
    if (!list.length) { box.innerHTML = `<div class="muted">没有找到相关内容</div>`; return; }
    const noEm = (s: string) => String(s ?? "").replace(/<\/?em>/gi, "");
    if (tab.type === "0") {
      // 高亮标签兜底剥离：后端 highlight=true，name 里可能带 <em>
      for (const s of list) {
        s.name = noEm(s.name);
        for (const g of s.singer ?? []) g.name = noEm(g.name);
        if (s.album) s.album.name = noEm(s.album.name);
      }
      renderSongRows(box, list, { showAlbum: true, onPlay: (s, i, all) => player.playList(all, i) });
    } else if (tab.type === "1") {
      box.classList.add("grid");
      box.innerHTML = list.map((x) => `<a class="card" href="#/singer?mid=${encodeURIComponent(x.mid ?? "")}&name=${encodeURIComponent(noEm(x.name) || "歌手")}">
          <div class="art round">${x.pic ? `<img src="${upPic(x.pic)}" alt="" loading="lazy"/>` : ""}</div>
          <div class="name">${noEm(x.name) || "歌手"}</div><div class="sub">${x.song_num ? `${x.song_num} 首` : ""}</div></a>`).join("");
    } else if (tab.type === "2") {
      box.classList.add("grid");
      box.innerHTML = list.map((x) => `<a class="card" href="#/album?mid=${encodeURIComponent(x.mid ?? "")}">
          <div class="art">${x.pic ? `<img src="${upPic(x.pic)}" alt="" loading="lazy"/>` : ""}</div>
          <div class="name">${noEm(x.name) || "专辑"}</div>
          <div class="sub">${noEm(x.singer)}${x.time_public ? ` · ${x.time_public}` : ""}</div></a>`).join("");
    } else {
      box.className = "grid playlist-grid";
      box.innerHTML = list.map((x) => `<a class="card" href="#/playlist?id=${encodeURIComponent(x.id ?? x.dirid ?? "")}&name=${encodeURIComponent(noEm(x.title) || "歌单")}">
          <div class="art">${x.picurl ? `<img src="${upPic(x.picurl)}" alt="" loading="lazy"/>` : ""}</div>
          <div class="name">${noEm(x.title) || "歌单"}</div>
          <div class="sub">${x.nickname ? noEm(x.nickname) + " 创建" : ""}${x.songnum ? ` · ${x.songnum} 首` : ""}</div></a>`).join("");
    }
    const total: number = d?.total_num ?? 0;
    if (d?.nextpage && d.nextpage !== -1) {
      const more = h("div", "more-bar");
      const btn = h("button", "ghost-btn", `加载更多（共 ${total || "?"} 条）`);
      btn.onclick = () => go(page + 1);
      more.append(btn);
      box.append(more);
    }
  } catch (e: any) {
    box.innerHTML = `<div class="muted">搜索失败：${e.message}</div>`;
  }
}

export const views: Record<string, (root: HTMLElement, q: URLSearchParams) => Promise<(() => void) | void>> = {
  "/": homeView,
  "/search": searchView,
  "/guess": guessView,
  "/daily": dailyView,
  "/liked": likedView,
  "/playlist": playlistView,
  "/singer": singerView,
  "/singer-albums": singerAlbumsView,
  "/album": albumView,
  "/settings": settingsView,
  "/log": logView,
  "/user": userView,
  "/login": loginView,
};
