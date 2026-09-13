// 歌单行渲染（跨视图复用；对齐设计稿：三行文字 + 单曲心形 + 双击播放 + 歌手/专辑跳转）
import { api, songArtists, coverUrl, fmtTime } from "./api";
import { player } from "../player";

export interface RowHooks {
  onPlay?: (song: any, index: number, all: any[]) => void;
  // 点击行内歌手/专辑链接跳视图
  showArtist?: boolean;
  showAlbum?: boolean;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function linkTo(kind: "singer" | "album", o: any, label: string): string {
  if (!o?.mid) return esc(label);
  return `<a class="meta-link" data-link="${kind}:${esc(o.mid)}:${esc(o.name ?? label)}" title="${esc(label)}">${esc(label)}</a>`;
}

export function renderSongRows(box: HTMLElement, songs: any[], hooks: RowHooks = {}) {
  box.innerHTML = "";
  for (const [i, s] of songs.entries()) {
    s._key = s.mid ?? String(s.id ?? Math.random());
    const row = document.createElement("div");
    row.className = "row";
    row.dataset.songkey = s._key;
    row.title = "双击播放";
    const pic = coverUrl(s, 150);
    const artistLine = hooks.showArtist === false ? "" :
      `<span class="ra">${(s.singer ?? []).length ? linkTo("singer", s.singer[0], songArtists(s)) : ""}</span>`;
    const albumLine = hooks.showAlbum ? `<span class="ral">${s.album?.name ? linkTo("album", s.album, s.album.name) : ""}</span>` : "";
    const loved = player.loved.has(s.mid);
    row.innerHTML = `<span class="idx">${i + 1}</span>
      <span class="rthumb">${pic ? `<img src="${pic}" alt="" loading="lazy"/>` : ""}</span>
      <span class="rmeta"><span class="rt" style="display:block">${esc(s.name ?? "")}</span>${artistLine}${albumLine}</span>
      <button class="row-love${loved ? " on" : ""}" data-love aria-label="收藏">${loved ? "♥" : "♡"}</button>
      <span class="dur">${fmtTime(s.interval)}</span>`;

    // 单击选中（视觉反馈留给 dblclick；单击不触发播放避免误触），双击播放整队列
    row.addEventListener("dblclick", (e) => {
      if ((e.target as HTMLElement).closest("[data-love],a")) return;
      hooks.onPlay?.(s, i, songs);
    });
    // 触屏/快速点按场景兜底：单击封面也直接播放
    row.querySelector(".rthumb")!.addEventListener("click", () => hooks.onPlay?.(s, i, songs));
    row.querySelector("[data-love]")!.addEventListener("click", (e) => {
      e.stopPropagation();
      player.toggleLove(s.mid);
      const on = player.loved.has(s.mid);
      const btn = e.currentTarget as HTMLElement;
      btn.textContent = on ? "♥" : "♡";
      btn.classList.toggle("on", on);
    });
    // 歌手/专辑跳转（事件委托到行；拼 hash 进对应视图）
    row.addEventListener("click", (e) => {
      const a = (e.target as HTMLElement).closest<HTMLElement>("[data-link]");
      if (!a) return;
      e.stopPropagation();
      const v = a.dataset.link!;
      const c1 = v.indexOf(":"), c2 = v.indexOf(":", c1 + 1);
      const kind = v.slice(0, c1), mid = v.slice(c1 + 1, c2), name = v.slice(c2 + 1);
      location.hash = `#/${kind}?mid=${encodeURIComponent(mid)}&name=${encodeURIComponent(name ?? "")}`;
    });
    box.append(row);
  }
}

// 分页加载我喜欢（30/页），返回歌曲数组（供视图计数/播放）
export async function loadLiked(box: HTMLElement, hooks: RowHooks = {}, limit = 300): Promise<any[]> {
  box.innerHTML = `<div class="muted">加载中…</div>`;
  const all: any[] = [];
  for (let off = 0; off < limit; off += 30) {
    const r: any = await api(`/user/liked-songs?offset=${off}&limit=30`);
    const batch = r?.songs ?? [];
    all.push(...batch);
    if (!r?.more || batch.length === 0) break;
  }
  box.innerHTML = "";
  renderSongRows(box, all, hooks);
  return all;
}
