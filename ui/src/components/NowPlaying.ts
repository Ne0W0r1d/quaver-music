// 「正在播放 / 歌词」全屏覆盖页：点击播放条封面展开，覆盖整个窗口内容（保留标题栏可收起）。
// 布局对齐设计稿：左侧滚动歌词（当前行高亮、其余淡化），右侧大封面 + 歌名 + 歌手；
// 背景 = 当前封面高斯模糊放大铺满 + 深色渐变压暗；底部进度与控制由常驻播放条承担（展开态浮层化）。
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
    <button class="np-tool np-collapse" id="np-collapse" aria-label="收起">${icons.chevronDown}</button>
    <div class="np-inner">
      <div class="np-lyrics" id="np-lyrics"></div>
      <div class="np-side">
        <div class="np-cover" id="np-cover"></div>
        <div class="np-title" id="np-title">未在播放</div>
        <div class="np-artist" id="np-artist"></div>
      </div>
    </div>
  `;

  const $ = <T extends HTMLElement>(id: string) => el.querySelector<T>("#" + id)!;
  const bg = $("np-bg"), lyrics = $("np-lyrics"), cover = $("np-cover");
  const title = $("np-title"), artist = $("np-artist");

  $("np-collapse").onclick = () => { player.expanded = false; player.notifyPublic(); };
  $("np-trans").onclick = () => player.toggleTrans();

  let lastMid = "";        // 歌词行 DOM 只在换曲/状态迁移时重建
  let lastLyricState = "";
  let lastIdx = -1;        // 高亮行索引（避免每帧改 class）
  let lineEls: HTMLElement[] = [];

  function buildLyricDom(s: Song | undefined) {
    lastMid = s?.mid ?? "";
    lastIdx = -1;
    if (!s) { lyrics.innerHTML = `<div class="np-ly-empty">未在播放</div>`; lineEls = []; return; }
    if (player.lyricState === "loading" || (player.lyricState === "idle" && !player.lyrics.length)) { lyrics.innerHTML = `<div class="np-ly-empty">歌词加载中…</div>`; lineEls = []; return; }
    if (!player.lyrics.length) { lyrics.innerHTML = `<div class="np-ly-empty">暂无歌词</div>`; lineEls = []; return; }
    lyrics.innerHTML = "";
    for (const line of player.lyrics) {
      const d = document.createElement("div");
      d.className = "np-ly-line";
      d.innerHTML = `<span class="l1">${escapeHtml(line.text)}</span>${line.trans ? `<span class="l2">${escapeHtml(line.trans)}</span>` : ""}`;
      d.onclick = () => player.seek(line.t);
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
    artist.textContent = s ? (s.singer ?? []).map((x) => x.name).join(" / ") : "";
    cover.innerHTML = pic ? `<img src="${pic}" alt=""/>` : `<div class="np-cover-ph">${icons.disc ?? ""}</div>`;

    // 高亮当前歌词行 + 滚动居中（容器 offsetTop 计算，兼容首尾 spacer）
    if (lineEls.length) {
      const t = player.time + 0.2;
      let idx = -1;
      for (let i = 0; i < player.lyrics.length; i++) {
        if (player.lyrics[i].t <= t) idx = i; else break;
      }
      if (idx !== lastIdx) {
        if (lastIdx >= 0 && lineEls[lastIdx]) lineEls[lastIdx].classList.remove("cur");
        if (idx >= 0 && lineEls[idx]) {
          lineEls[idx].classList.add("cur");
          const line = lineEls[idx];
          lyrics.scrollTo({ top: line.offsetTop + line.offsetHeight / 2 - lyrics.clientHeight / 2, behavior: "smooth" });
        }
        // 按与当前行的距离做透明度衰减（平滑渐隐，替代一刀切的淡化）
        for (let i = 0; i < lineEls.length; i++) {
          const d = Math.abs(i - idx);
          lineEls[i].style.opacity = idx < 0 ? "0.5" : String(i === idx ? 1 : Math.max(0.16, 0.85 - d * 0.12));
        }
        lastIdx = idx;
      }
    }
  });
  return el;
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
