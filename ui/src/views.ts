// Quaver — 路由视图表（仅内容区渲染；播放器/侧栏常驻）
// 视图函数: async (root, query) => cleanup?
import { api, upPic } from "./lib/api";
import { renderSongRows, loadLiked, type RowHooks } from "./lib/songs";
import { player } from "./player";

const h = (tag: string, cls: string, html = "") => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  el.innerHTML = html;
  return el;
};

// —— 首页：大标题 + 推荐歌单卡片网格（对齐设计稿） ——
async function homeView(root: HTMLElement) {
  root.append(h("h1", "page-title", "首页"));
  const grid = h("div", "grid playlist-grid");
  grid.innerHTML = `<div class="muted">加载中…</div>`;
  root.append(grid);

  const r: any = await api("/getSongLists/1/30");
  const list: any[] = r?.response?.data?.list ?? [];
  grid.innerHTML = "";
  for (const x of list) {
    const a = h("a", "card") as HTMLAnchorElement;
    a.href = `#/playlist?id=${encodeURIComponent(x.dissid ?? "")}&name=${encodeURIComponent(x.dissname ?? "")}`;
    a.innerHTML = `<div class="art"><img src="${upPic(x.imgurl)}" alt="" loading="lazy"/></div>
      <div class="name">${x.dissname ?? "歌单"}</div><div class="sub">${x.introduction ?? "推荐歌单"}</div>`;
    grid.append(a);
  }
  if (!list.length) grid.innerHTML = `<div class="muted">暂无推荐</div>`;
}

// —— 歌单页：信息头（封面/标题/制作人/描述）+ 歌曲列表（设计稿布局） ——
async function playlistView(root: HTMLElement, q: URLSearchParams) {
  const name = q.get("name") || "歌单";
  const id = q.get("id") || "";
  const box = h("div", "rows", `<div class="muted">加载中…</div>`);
  root.append(box);
  if (!id) { box.innerHTML = `<div class="muted">缺少歌单 id</div>`; return; }
  let cd: any;
  try {
    const r: any = await api(`/getSongListDetail/${encodeURIComponent(id)}`);
    cd = r?.response?.cdlist?.[0];
  } catch (e: any) {
    box.innerHTML = `<div class="muted">加载失败：${e.message}</div>`;
    return;
  }
  const songs: any[] = cd?.songlist ?? [];
  root.innerHTML = "";

  // 信息头：左封面 右 标题/制作人/描述（设计稿顶栏的"收藏歌单"星形需上游写接口，本 fork 无——不做假按钮）
  const head = h("div", "pl-head");
  const logo = upPic(cd?.logo || "");
  head.innerHTML = `
    <button class="pl-back" aria-label="返回" title="返回"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 6l-6 6 6 6"/></svg></button>
    <div class="pl-art">${logo ? `<img src="${logo}" alt=""/>` : ""}</div>
    <div class="pl-info">
      <h1 class="pl-name">${cd?.dissname ?? name}</h1>
      <div class="pl-meta">${cd?.nick ? `${cd.nick} 制作` : ""}${cd?.total_song_num ? ` · ${cd.total_song_num} 首` : ""}</div>
      <div class="pl-desc muted">${cd?.desc || cd?.introduction || ""}</div>
    </div>`;
  root.append(head);
  head.querySelector<HTMLElement>(".pl-back")!.onclick = () => history.length > 1 ? history.back() : (location.hash = "#/");

  const rows = h("div", "rows");
  root.append(rows);
  if (!songs.length) {
    rows.innerHTML = `<div class="muted">该歌单暂不可读（上游 check privacy error!，需登录态签名，fork 未覆盖）。已在 docs/spike-1 记录，二期实现。</div>`;
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
    const r: any = await api(`/getSingerHotsong?singermid=${encodeURIComponent(mid)}&limit=50&page=0`);
    const songs: any[] = r?.response?.singer?.data?.songlist ?? [];
    if (!songs.length) { box.innerHTML = `<div class="muted">没有取到热门歌曲</div>`; return; }
    renderSongRows(box, songs, { showAlbum: true, onPlay: (s, i, all) => player.playList(all, i) });
  } catch (e: any) {
    box.innerHTML = `<div class="muted">加载失败：${e.message}</div>`;
  }
}

// —— 专辑页（点击行内专辑跳转的落点）：getAlbumInfo 的 list 项是 songmid/songname 异形，先归一 ——
async function albumView(root: HTMLElement, q: URLSearchParams) {
  const mid = q.get("mid") || "";
  root.append(h("div", "rows", `<div class="muted">加载中…</div>`));
  if (!mid) { (root.querySelector(".rows") as HTMLElement).innerHTML = `<div class="muted">缺少专辑 mid</div>`; return; }
  try {
    const r: any = await api(`/getAlbumInfo?albummid=${encodeURIComponent(mid)}`);
    const data = r?.response?.data ?? {};
    const songs: any[] = (data.list ?? []).map((x: any) => ({
      mid: x.songmid ?? x.mid,
      name: x.songname ?? x.name,
      interval: x.interval,
      singer: x.singer,
      album: { mid: data.mid, pmid: `${data.pic_mid || data.mid || ""}_1` },
    }));
    // 专辑信息头（封面用 getAlbumInfo 的 pic_mid）
    root.innerHTML = "";
    const picMid = data.pic_mid || data.mid || "";
    const head = h("div", "pl-head");
    head.innerHTML = `
      <button class="pl-back" aria-label="返回" title="返回"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 6l-6 6 6 6"/></svg></button>
      <div class="pl-art">${picMid ? `<img src="https://y.gtimg.cn/music/photo_new/T002R300x300M000${picMid}_1.jpg" alt=""/>` : ""}</div>
      <div class="pl-info">
        <h1 class="pl-name">${data.name ?? "专辑"}</h1>
        <div class="pl-meta">${data.singername ?? ""}${data.aDate ? ` · ${data.aDate}` : ""}${data.total_song_num ? ` · ${data.total_song_num} 首` : ""}</div>
        <div class="pl-desc muted">${data.desc || ""}</div>
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
  const box = listPage(root, "猜你喜欢", "fork 未提供个性化推荐端点；先以「我喜欢」随机序呈现，二期接入推荐 CGI。");
  try {
    const pool: any[] = [];
    for (let off = 0; off < 150; off += 30) {
      const p: any = await api(`/user/liked-songs?offset=${off}&limit=30`);
      pool.push(...(p?.songs ?? []));
      if (!p?.more) break;
    }
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    renderSongRows(box, pool.slice(0, 50), { onPlay: (s, i, all) => player.playList(all, i) });
  } catch (e: any) {
    box.innerHTML = `<div class="muted">${e.message} — 需要先登录</div>`;
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
    const pool: any[] = [];
    for (let off = 0; off < 500; off += 30) {
      const p: any = await api(`/user/liked-songs?offset=${off}&limit=30`);
      pool.push(...(p?.songs ?? []));
      if (!p?.more) break;
    }
    const picked: any[] = [];
    const idx = pool.map((_, i) => i);
    while (picked.length < 30 && idx.length) {
      const j = Math.floor(rnd() * idx.length);
      picked.push(pool[idx.splice(j, 1)[0]]);
    }
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
  root.append(h("p", "muted", "占位页。规划：播放音质档位、主题（浅/深）、缓存目录、开机自启、快捷键、日志与诊断（sidecar 健康检查）。"));
}

async function userView(root: HTMLElement) {
  const wrap = h("div", "me");
  root.append(wrap);
  try {
    const me: any = await api("/user/detail");
    const info = me?.profile?.info;
    if (!info?.nick) { location.hash = "#/login"; return; }
    wrap.innerHTML = `
      <div class="avatar-big">${info.logo ? `<img src="${String(info.logo).replace(/^http:/, "https:")}" alt=""/>` : ""}</div>
      <h2 style="margin:12px 0 4px">${info.nick}</h2>
      <div class="badges" style="justify-content:center">${info.intro ? `<i class="badge blue">${info.intro}</i>` : ""}</div>
      <p class="muted">UID: ${me.profile.str_musicid ?? ""}</p>
      <button id="logout" class="ghost-btn">退出登录</button>`;
    wrap.querySelector<HTMLElement>("#logout")!.onclick = async () => {
      await api("/logout");
      await fetch("/api/__save-session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: "" }) }).catch(() => {});
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
      <p class="muted">用 QQ 音乐 App 或微信扫下方二维码。登录态保存在本机 ~/.config/quaver/session.txt。</p>
      <div class="qr-box">
        <div id="qr" class="qr"><div class="muted">正在生成二维码…</div></div>
        <div id="lstate" class="muted"></div>
        <div class="row-btn">
          <select id="channel" aria-label="登录通道">
            <option value="qq">QQ 音乐 App</option>
            <option value="wechat">微信</option>
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
    let unikey = "";
    try {
      const r = await fetch("/api/login/qr/key?channel=" + channel.value);
      const j: any = await r.json();
      if (j.code === 429) { qr.innerHTML = `<div class="muted">操作太快，${Math.ceil((j.retryAfterMs ?? 60000) / 1000)}s 后重试</div>`; return; }
      unikey = j?.data?.unikey;
      if (!unikey) throw new Error("key 获取失败");
    } catch (e: any) { qr.innerHTML = `<div class="muted">${e.message}</div>`; return; }

    const img: any = await api(`/login/qr/create?key=${unikey}`);
    if (stopped) return;
    qr.innerHTML = `<img src="${img.data.qrimg}" alt="登录二维码"/>`;
    lstate.textContent = "等待扫码…";

    timer = window.setInterval(async () => {
      if (stopped) { window.clearInterval(timer); return; }
      try {
        const c: any = await api(`/login/qr/check?key=${unikey}`);
        if (c.code === 801) return;
        if (c.code === 802) { lstate.textContent = "已扫码，请在手机上确认"; return; }
        if (c.code === 800) { lstate.textContent = "二维码已过期"; window.clearInterval(timer); return; }
        if (c.code === 803) {
          window.clearInterval(timer);
          lstate.textContent = "登录成功，保存会话…";
          const cookieStr: string = c.cookie ?? "";
          const token = /^[a-f0-9]{32,128}$/i.test(cookieStr) ? cookieStr : cookieStr.split("=").pop();
          const save = await fetch("/api/__save-session", {
            method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }),
          }).then((r) => r.json());
          if (save?.ok) { lstate.textContent = "✅ 完成，即将返回…"; setTimeout(() => (location.href = "/index.html"), 800); }
          else lstate.textContent = "保存失败：" + (save?.error ?? "?");
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
