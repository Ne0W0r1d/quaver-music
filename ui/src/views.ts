// Quaver — 路由视图表（仅内容区渲染；播放器/侧栏常驻）
// 视图函数: async (root, query) => cleanup?
import { api, upPic, getQuality, setQuality, setSessionQuality, getStreamTiers, identityBadges } from "./lib/api";
import { renderSongRows, loadLiked, type RowHooks } from "./lib/songs";
import { player } from "./player";
import {
  getTheme, setTheme, getDecor, setDecor, getUiFont, setUiFont, getLyricFont, setLyricFont,
  getDecode, setDecode, FONT_LABELS,
} from "./lib/prefs";

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

// —— 设置页（对齐设计稿：外观设置 / 播放设置 / 调试 三区；不触碰侧栏与播放条） ——
async function settingsView(root: HTMLElement) {
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  const fontOptions = Object.entries(FONT_LABELS).map(([k, v]) => `<option value="${k}">${v}</option>`).join("");
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

      <div class="set-sub">字体设置</div>
      <label class="set-field"><span>界面字体</span>
        <select id="font-ui">${fontOptions}</select></label>
      <label class="set-field"><span>歌词字体</span>
        <select id="font-lyric">${fontOptions}</select></label>
    </section>

    <section class="set-sec">
      <h2>播放设置</h2>
      <p class="muted set-note">在这里，可以设置 Quaver 的播放设置</p>

      <div class="set-sub">后端模式</div>
      <p class="muted set-note">如果播放音频出现问题可在这设置</p>
      <div id="backend-device"${isMac ? " hidden" : ""}>
        <label class="set-field"><span>音频后端/设备</span>
          <select id="audio-backend" disabled><option>系统默认</option></select></label>
        <p class="muted set-hint">Windows 默认 WASAPI，Linux 默认 PipeWire，macOS 走 CoreAudio 不显示该设置。当前播放管线为 Chromium Web Audio，接入原生后端后这里会列出真实设备。</p>
      </div>
      <div class="set-sub set-sub2">解码后端 <span class="muted set-subnote">- 默认 FFmpeg，可选 MPV/Blink</span></div>
      <div class="opt-radios" id="decode-radios">
        ${decodeRow("FFmpeg", "FFmpeg")}${decodeRow("MPV", "MPV", true)}${decodeRow("Blink", "Blink", true)}
      </div>

      <div class="set-sub">默认音质 <span class="muted set-subnote" id="q-member-note"></span></div>
      <div class="opt-cards" id="quality-grid">
        <button class="opt-card q" data-q="auto" type="button">自动</button>
      </div>
      <p class="muted set-hint">档位即时生效（下一首起按新音质协商取链）。臻品母带/全景声等高档位仅限会员；本后端只流播明文档，不提供加密档（QMC）解密。</p>
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
      <small> Version: Prototype </small>
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

  // 窗口装饰：CSD（自绘悬浮胶囊）/ SSD（系统标题栏）。Electron 桥重建窗口；浏览器仅隐藏胶囊。
  const decorBox = wrap.querySelector<HTMLElement>("#decor-cards")!;
  const syncDecor = () => syncSel(decorBox, "opt", getDecor());
  decorBox.querySelectorAll<HTMLElement>("[data-opt]").forEach((b) => { b.onclick = () => { setDecor(b.dataset.opt as any); syncDecor(); }; });
  syncDecor();

  // 字体：界面 / 歌词两族，写 CSS 变量即时生效
  const fu = wrap.querySelector<HTMLSelectElement>("#font-ui")!;
  const fl = wrap.querySelector<HTMLSelectElement>("#font-lyric")!;
  fu.value = getUiFont(); fu.onchange = () => setUiFont(fu.value);
  fl.value = getLyricFont(); fl.onchange = () => setLyricFont(fl.value);

  // 解码后端：当前管线只有 FFmpeg（Web Audio 解码）可用；选择持久化，多后端接入后生效
  const radios = wrap.querySelectorAll<HTMLInputElement>("#decode-radios input");
  const decode = getDecode();
  radios.forEach((r) => { r.checked = r.value === decode; r.onchange = () => { if (r.checked) setDecode(r.value); }; });

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
  "/log": logView,
  "/user": userView,
  "/login": loginView,
};
