// 播放队列面板：从播放条「队列」按钮弹出，列出当前队列，点击切歌。
import { player } from "../player";
import { icons } from "../lib/icons";

export function QueuePanel(): HTMLElement {
  const el = document.createElement("div");
  el.className = "queue-panel";
  el.id = "queue-panel";
  el.innerHTML = `
    <div class="qp-head"><span>播放队列</span><button class="qp-close" aria-label="关闭">${icons.close}</button></div>
    <div class="qp-list" id="qp-list"></div>
  `;
  const list = el.querySelector<HTMLElement>("#qp-list")!;
  el.querySelector<HTMLElement>(".qp-close")!.onclick = () => { player.queueOpen = false; player.notifyPublic(); };

  let sig = "";
  player.on(() => {
    el.classList.toggle("open", player.queueOpen);
    if (!player.queueOpen) return;
    const s = player.queue.map((q) => q.mid).join(",") + "#" + player.index + "#" + player.playing + "#" + player.loading;
    if (s === sig) return; // 内容没变不重建
    sig = s;
    list.innerHTML = "";
    player.queue.forEach((q, i) => {
      const row = document.createElement("div");
      row.className = "qp-item" + (i === player.index ? " cur" : "");
      row.innerHTML = `<span class="qi-i">${i === player.index ? (player.loading ? "…" : player.playing ? "♪" : "❚❚") : i + 1}</span>
        <span class="qi-n">${escapeHtml(q.name)}</span>
        <span class="qi-a">${escapeHtml((q.singer ?? []).map((x) => x.name).join(" / "))}</span>`;
      row.onclick = () => player.jump(i);
      list.append(row);
    });
    if (!player.queue.length) list.innerHTML = `<div class="qp-empty">队列为空</div>`;
    list.querySelector(".cur")?.scrollIntoView({ block: "nearest" });
  });
  return el;
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
