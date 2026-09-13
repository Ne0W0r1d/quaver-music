// 「正在播放 / 歌词」全屏覆盖页：点击播放条封面展开/收起（唯一入口；播放条不放开关按钮）。
// 歌词 = 整首列表：当前句居中、清晰、染色与进度条同源（--np-hl，未来动态逐字同色）；
// 其余行模糊渐隐。滚轮可自由翻阅全文（翻阅期间暂停自动跟随，播放进度追上行号后恢复跟随）。
// 右侧 = 封面在上，歌名 / 「歌手 - 专辑」在下，文本右对齐且与封面右缘齐平。
// 背景 = 当前封面高斯模糊放大铺满 + 深色渐变压暗；进度与控制由常驻播放条承担。
import { player, type Song } from "../player";
import { coverUrl } from "../lib/api";
import { icons } from "../lib/icons";

export function NowPlaying(): HTMLElement {
  const el = document.createElement("div");
  el.className = "np";
  el.id = "now-playing";
  el.innerHTML = `
    <div class="np-bg" id="np-bg"></div>
    <div class="np-scrim"></div>
    <button class="np-tool" id="np-trans" aria-label="显示/隐藏翻译" title="翻译歌词">文/A</button>
    <div class="np-inner">
      <div class="np-lyrics" id="np-lyrics"></div>
      <div class="np-side">
        <div class="np-cover" id="np-cover"></div>
        <div class="np-meta">
          <div class="np-title" id="np-title">未在播放</div>
          <div class="np-artist" id="np-artist"></div>
        </div>
      </div>
    </div>
  `;

  const $ = <T extends HTMLElement>(id: string) => el.querySelector<T>("#" + id)!;
  const bg = $("np-bg"), lyrics = $("np-lyrics"), cover = $("np-cover");
  const title = $("np-title"), artist = $("np-artist");

  $("np-trans").onclick = () => player.toggleTrans();

  let lastMid = "";        // 歌词行 DOM 只在换曲/状态迁移时重建
  let lastLyricState = "";
  let lastIdx = -1;        // 高亮行索引（避免每帧改 class）
  let lineEls: HTMLElement[] = [];

  // —— 滚轮翻阅：浏览模式暂停自动跟随；3s 无操作回到跟随，或点击任意行立刻跟随该句 ——
  let browsing = false;
  let browseTimer = 0;
  const enterBrowse = () => {
    browsing = true;
    window.clearTimeout(browseTimer);
    browseTimer = window.setTimeout(() => {
      browsing = false;
      followCurrent(); // 回到跟随态：立刻把当前句滚回中心
    }, 3000);
  };
  lyrics.addEventListener("wheel", enterBrowse, { passive: true });
  lyrics.addEventListener("pointerdown", enterBrowse, { passive: true });

  function followCurrent() {
    const line = lineEls[lastIdx];
    if (line) lyrics.scrollTo({ top: line.offsetTop + line.offsetHeight / 2 - lyrics.clientHeight / 2, behavior: "smooth" });
  }

  function buildLyricDom(s: Song | undefined) {
    lastMid = s?.mid ?? "";
    lastIdx = -1;
    browsing = false;
    if (!s) { lyrics.innerHTML = `<div class="np-ly-empty">未在播放</div>`; lineEls = []; return; }
    if (player.lyricState === "loading" || (player.lyricState === "idle" && !player.lyrics.length)) { lyrics.innerHTML = `<div class="np-ly-empty">歌词加载中…</div>`; lineEls = []; return; }
    if (!player.lyrics.length) { lyrics.innerHTML = `<div class="np-ly-empty">暂无歌词</div>`; lineEls = []; return; }
    lyrics.innerHTML = "";
    for (const line of player.lyrics) {
      const d = document.createElement("div");
      d.className = "np-ly-line";
      d.innerHTML = `<span class="l1">${escapeHtml(line.text)}</span>${line.trans ? `<span class="l2">${escapeHtml(line.trans)}</span>` : ""}`;
      d.onclick = () => { player.seek(line.t); browsing = false; }; // 点击跳回该行并恢复跟随
      lyrics.append(d);
    }
    lineEls = [...lyrics.querySelectorAll<HTMLElement>(".np-ly-line")];
  }

  player.on(() => {
    const s = player.current;
    const open = player.expanded;
    el.classList.toggle("open", open);
    el.classList.toggle("no-trans", !player.showTrans);
    $("np-trans").classList.toggle("on", player.showTrans);
    if (!open && !s) return;

    // 背景：封面模糊放大
    const pic = s ? coverUrl(s, 300) : "";
    bg.style.backgroundImage = pic ? `url("${pic}")` : "";
    el.style.setProperty("--np-vis", pic ? "1" : "0");

    // 换曲 或 歌词状态迁移（loading→ok/none 时行 DOM 需要重建，否则占位/歌词丢失）
    const st: "idle" | "loading" | "ok" | "none" = player.lyrics.length ? "ok" : player.lyricState;
    if (s?.mid !== lastMid || st !== lastLyricState) buildLyricDom(s);
    lastLyricState = st;
    title.textContent = s?.name ?? "未在播放";
    const albumName = (s as any)?.album?.name ?? "";
    artist.textContent = s ? [(s.singer ?? []).map((x) => x.name).join(" / "), albumName].filter(Boolean).join(" - ") : "";
    cover.innerHTML = pic ? `<img src="${pic}" alt=""/>` : `<div class="np-cover-ph">${icons.disc ?? ""}</div>`;

    // 高亮当前歌词行 + 滚动居中（翻阅模式暂停自动跟随；3s 静默或点击行号恢复）
    if (lineEls.length) {
      const t = player.time + 0.2;
      let idx = -1;
      for (let i = 0; i < player.lyrics.length; i++) {
        if (player.lyrics[i].t <= t) idx = i; else break;
      }
      if (idx !== lastIdx) {
        if (lastIdx >= 0 && lineEls[lastIdx]) lineEls[lastIdx].classList.remove("cur");
        if (idx >= 0 && lineEls[idx]) lineEls[idx].classList.add("cur");
        lastIdx = idx;
        if (!browsing && idx >= 0) followCurrent();
      }
    }
  });
  return el;
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
