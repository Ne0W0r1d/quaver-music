// 播放列表面板：点击切歌 / 拖拽排序 / 单曲移除 / 一键清空。
// 双形态自适应（ResizeObserver 驱动）：
//   内容区宽度足够 → 停靠（.dock）在 .content 右缘（.content-body flex 行内），
//                    路由视图区（主页/搜索/歌手页…）自动让宽 = 整页缩放；
//   宽度不够       → 浮窗（.float）固定于窗口右下、悬在内容之上（原行为）。
import { player, type Song } from "../player";
import { coverUrl } from "../lib/api";
import { icons } from "../lib/icons";

/** 内容区达到该宽度才停靠（再窄会把视图区挤得放不下卡片网格） */
const DOCK_MIN_CONTENT = 880;

export function QueuePanel(): HTMLElement {
  const el = document.createElement("div");
  el.className = "queue-panel float";
  el.id = "queue-panel";
  el.innerHTML = `
    <div class="qp-head">
      <span class="qp-title">播放列表<i class="qp-cnt" id="qp-cnt"></i></span>
      <span class="qp-actions">
        <button class="qp-act" id="qp-clear" title="清空队列" aria-label="清空队列">${icons.trash}</button>
        <button class="qp-act" id="qp-close" title="收起" aria-label="收起">${icons.chevronDown}</button>
      </span>
    </div>
    <div class="qp-list" id="qp-list"></div>
  `;
  const list = el.querySelector<HTMLElement>("#qp-list")!;
  const cnt = el.querySelector<HTMLElement>("#qp-cnt")!;
  el.querySelector<HTMLElement>("#qp-close")!.onclick = () => { player.queueOpen = false; player.notifyPublic(); };
  el.querySelector<HTMLElement>("#qp-clear")!.onclick = () => player.clearQueue();

  // —— 形态切换：停靠 / 浮窗 ——
  const contentEl = () => document.querySelector<HTMLElement>(".content");
  const contentBody = () => document.querySelector<HTMLElement>(".content-body");
  const npEl = () => document.querySelector<HTMLElement>(".np");
  const dockable = () => { const c = contentEl(); return !!c && c.clientWidth >= DOCK_MIN_CONTENT; };
  function syncMount() {
    const open = player.queueOpen;
    // —— 正在播放全屏页：一律浮窗（固定右侧的通栏 dock 会把歌词区挤失衡，实测弃用）。
    // float 挂 body、z:70 浮在全屏层（z:50）之上，开关仍由播放条队列按钮驱动；
    // 收回全屏页后走下方正常逻辑按宽度停靠/浮窗。
    if (npEl() && player.expanded) {
      el.classList.remove("dock");
      el.classList.add("float");
      if (el.parentElement !== document.body) document.body.append(el);
      el.classList.toggle("open", open);
      return;
    }
    el.classList.toggle("open", open);
    // 关闭时保持原位收起（避免「停靠位 → 右下角」的收起动画瞬移）；打开时按宽度定形态
    const dock = open ? dockable() : el.classList.contains("dock");
    el.classList.toggle("dock", dock);
    el.classList.toggle("float", !dock);
    if (dock) {
      const body = contentBody();
      if (body && el.parentElement !== body) body.append(el); // 停靠：route 自动让宽
    } else if (el.parentElement !== document.body) {
      document.body.append(el); // 浮窗：挂 body，fixed 定位
    }
  }
  const ro = new ResizeObserver(() => { if (player.queueOpen) syncMount(); });
  const contentBox = contentEl();
  if (contentBox) ro.observe(contentBox);
  syncMount();

  // —— 列表渲染（订阅式：队列/指针/播放态变化才重建） ——
  const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
  let suppressClick = false; // 拖拽松手后补发的 click 不切歌
  let sig = "";
  player.on(() => {
    syncMount();
    const s = player.queue.map((q) => q.mid).join(",") + "#" + player.index + "#" + player.playing + "#" + player.loading;
    if (s === sig) return; // 内容没变不重建
    sig = s;
    cnt.textContent = player.queue.length ? `${player.queue.length} 首` : "";
    list.innerHTML = "";
    if (!player.queue.length) {
      list.innerHTML = `<div class="qp-empty">队列为空<span>播放一首歌，或用「下一首播放」加入</span></div>`;
      return;
    }
    player.queue.forEach((q, i) => list.append(rowOf(q, i)));
    list.querySelector(".cur")?.scrollIntoView({ block: "nearest" });
  });

  function rowOf(q: Song, i: number): HTMLElement {
    const row = document.createElement("div");
    row.className = "qp-item" + (i === player.index ? " cur" : "");
    const pic = coverUrl(q, 90); // QQ 音乐 CDN 只认 90/150/300/500 等标准尺寸，64 会 404
    row.innerHTML = `
      <span class="qi-grip" title="拖动排序" aria-hidden="true">${icons.grip}</span>
      <span class="qi-thumb">${pic ? `<img src="${pic}" alt="" loading="lazy"/>` : ""}</span>
      <span class="qi-i">${i === player.index ? (player.loading ? "…" : player.playing ? "♪" : "❚❚") : i + 1}</span>
      <span class="qi-main">
        <span class="qi-n">${escapeHtml(q.name)}</span>
        <span class="qi-a">${escapeHtml((q.singer ?? []).map((x) => x.name).join(" / "))}</span>
      </span>
      <button class="qi-del" title="移出队列" aria-label="移出队列">${icons.close}</button>
    `;
    row.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest(".qi-grip, .qi-del")) return; // 把手/删除钮不触发切歌
      if (suppressClick) return;
      player.jump(i);
    });
    row.querySelector<HTMLElement>(".qi-del")!.addEventListener("click", (e) => {
      e.stopPropagation();
      player.removeAt(i);
    });
    bindDrag(row, i);
    return row;
  }

  // —— 拖拽排序（指针事件，抓把手起拖；行高等高 → 换位即换序）——
  // 原理：行始终留在文档流里（transform 只做视觉位移），指针进入相邻行半格即交换 DOM 位置，
  // 换位后按「视觉顶边贴指针」重算 transform，肉眼无跳变。松手按最终 DOM 序提交 player.moveInQueue。
  function bindDrag(row: HTMLElement, fromIdx: number) {
    const grip = row.querySelector<HTMLElement>(".qi-grip")!;
    const swapUnder = (pointerY: number) => {
      for (const sib of [...list.children] as HTMLElement[]) {
        if (sib === row) continue;
        const r = sib.getBoundingClientRect();
        if (pointerY >= r.top && pointerY < r.bottom) {
          if (pointerY < r.top + r.height / 2) list.insertBefore(row, sib);
          else list.insertBefore(row, sib.nextSibling);
          return;
        }
      }
      const kids = [...list.children] as HTMLElement[];
      if (!kids.length) return;
      const first = kids[0].getBoundingClientRect(), last = kids[kids.length - 1].getBoundingClientRect();
      if (pointerY < first.top) list.insertBefore(row, list.firstElementChild);
      else if (pointerY >= last.bottom) list.append(row); // 拖出列表末端 = 移到队尾
    };
    grip.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      let dragging = false;
      let dy = 0;
      const startY = e.clientY;
      const grabOffset = startY - row.getBoundingClientRect().top; // 指针在行内的抓取偏移
      const pid = e.pointerId;
      try { grip.setPointerCapture(pid); } catch { /* 合成事件降级 */ }
      const layout = (pointerY: number) => {
        const flowTop = row.getBoundingClientRect().top - dy; // rect 含当前 transform，减掉 = 文档流顶边
        dy = pointerY - grabOffset - flowTop; // 视觉顶边始终贴着「指针 - 抓取偏移」
        row.style.transform = `translateY(${dy}px)`;
      };
      const onMove = (ev: PointerEvent) => {
        if (ev.pointerId !== pid) return;
        if (!dragging) {
          if (Math.abs(ev.clientY - startY) < 5) return; // 位移阈值：点了不走不算拖
          dragging = true;
          suppressClick = true;
          row.classList.add("dragging");
        }
        const lr = list.getBoundingClientRect();
        if (ev.clientY < lr.top + 26) list.scrollTop -= 9; // 贴边自动滚动
        else if (ev.clientY > lr.bottom - 26) list.scrollTop += 9;
        swapUnder(ev.clientY);
        layout(ev.clientY);
      };
      const onUp = (ev: PointerEvent) => {
        if (ev.pointerId !== pid) return;
        grip.removeEventListener("pointermove", onMove);
        grip.removeEventListener("pointerup", onUp);
        grip.removeEventListener("pointercancel", onUp);
        if (!dragging) return;
        row.classList.remove("dragging");
        row.style.transform = "";
        const to = [...list.children].indexOf(row);
        if (to !== fromIdx) player.moveInQueue(fromIdx, to);
        setTimeout(() => { suppressClick = false; }, 0); // click 在 pointerup 之后补发，只吞这一发
      };
      grip.addEventListener("pointermove", onMove);
      grip.addEventListener("pointerup", onUp);
      grip.addEventListener("pointercancel", onUp);
    });
  }

  return el;
}
