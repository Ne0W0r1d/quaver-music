// 歌单行渲染 + 点击播放（跨页复用；布局样式在 AppLayout 全局）
import { api, songArtists, coverUrl, getPlayUrl, fmtTime } from "./api";

const P: any = () => (window as any).QuaverPlayer;

export function keyOf(s: any) {
  return s.mid ?? String(s.id ?? Math.random());
}

export function renderSongRows(box: HTMLElement, songs: any[], startIdx = 1) {
  box.innerHTML = "";
  for (const [i, s] of songs.entries()) {
    s._key = keyOf(s);
    const row = document.createElement("div");
    row.className = "row";
    row.dataset.songkey = s._key;
    const pic = coverUrl(s);
    row.innerHTML = `<span class="idx">${startIdx + i}</span>
      <span class="rthumb">${pic ? `<img src="${pic}" alt="" loading="lazy"/>` : ""}</span>
      <span style="min-width:0;flex:1"><span class="rt" style="display:block">${s.name}</span><span class="ra">${songArtists(s)}</span></span>
      <span class="dur">${fmtTime(s.interval)}</span>`;
    row.onclick = () => playSong(s, songs, i);
    box.append(row);
  }
}

export async function playSong(s: any, queue: any[] = [], index = 0) {
  const p = P();
  if (!p) return;
  p._queue = queue; p._i = index;
  try {
    const url = await getPlayUrl(s);
    p.playUrl(url, s);
  } catch (e: any) {
    const hint = document.getElementById("pb-hint");
    if (hint) hint.textContent = e.message;
  }
}

// 分页加载我喜欢（30/页）
export async function loadLiked(box: HTMLElement, limit = 300) {
  box.innerHTML = `<div class="muted">加载中…</div>`;
  const all: any[] = [];
  for (let off = 0; off < limit; off += 30) {
    const r: any = await api(`/user/liked-songs?offset=${off}&limit=30`);
    const batch = r?.songs ?? [];
    all.push(...batch);
    if (!r?.more || batch.length === 0) break;
  }
  box.innerHTML = "";
  renderSongRows(box, all);
}
