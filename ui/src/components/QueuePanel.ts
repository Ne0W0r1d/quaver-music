// 播放列表面板：点击切歌 / 拖拽排序 / 单曲移除 / 一键清空。
// 双形态自适应（ResizeObserver 驱动）：
//   内容区宽度足够 → 停靠（.dock）在 .content 右缘（.content-body flex 行内），
//                    路由视图区（主页/搜索/歌手页…）自动让宽 = 整页缩放；
//   宽度不够       → 浮窗（.float）固定于窗口右下、悬在内容之上（原行为）。
import { player, type Song } from "../player";
import { coverUrl, songTitle } from "../lib/api";
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

  // —— 形态切换：停靠 / 浮窗（**与开合解耦**，见 applyLayout 的注释）——
  const contentEl = () => document.querySelector<HTMLElement>(".content");
  const contentBody = () => document.querySelector<HTMLElement>(".content-body");
  const npEl = () => document.querySelector<HTMLElement>(".np");
  const dockable = () => { const c = contentEl(); return !!c && c.clientWidth >= DOCK_MIN_CONTENT; };

  /** 定形态（停靠 .dock / 浮窗 .float）并换到对应父节点；返回**是否真的换了父节点**。
   *
   *  关键：形态只看内容区宽度，**跟开关无关 —— 关闭时也要定好**。
   *  早期实现是「打开时才按宽度定形态」，于是首次展开会在同一帧里「换父节点 + 加 .open」，
   *  浏览器把插入与类变更合并成一次样式重算，transition 压根不会启动 ——
   *  表现就是「第一次展开没有动画，之后再展开就正常了」（换过一次父节点之后不再换）。
   *  代价为零：关闭态是 width:0/opacity:0，隐藏着搬节点肉眼看不出。 */
  function applyLayout(): boolean {
    // 正在播放全屏页：一律浮窗（固定右侧的通栏 dock 会把歌词区挤失衡，实测弃用）。
    // float 挂 body、z:70 浮在全屏层（z:50）之上，开关仍由播放条队列按钮驱动；
    // 收回全屏页后走正常逻辑按宽度停靠/浮窗。
    const dock = !(npEl() && player.expanded) && dockable();
    el.classList.toggle("dock", dock);
    el.classList.toggle("float", !dock);
    const want = dock ? contentBody() : document.body;
    if (!want || el.parentElement === want) return false;
    want.append(el);
    return true;
  }

  function applyOpen() {
    const open = player.queueOpen;
    el.classList.toggle("open", open);
    // 关闭态不只是「看不见」：连同 tab 焦点/读屏/「聚焦即滚进视野」一起摘掉。
    // 面板必须常驻 DOM（不能用 display:none，否则没有过渡），不 inert 的话键盘 Tab 能进到里面，
    // 而浏览器会把聚焦元素滚进视野 —— .content 一旦被程序化滚动，整个路由视图就横移
    // （与 scrollIntoView 那起事故同源；见 revealCurrent 的注释）。
    el.toggleAttribute("inert", !open);
  }

  /** 开合 + 形态。刚换过父节点就把 .open 推到下一帧：新插入的节点必须有一帧「关闭态」垫底，
   *  过渡才有的可比（否则从无到有直接落在终态）。 */
  function syncMount() {
    if (applyLayout()) {
      el.classList.remove("open");
      requestAnimationFrame(applyOpen);
      return;
    }
    applyOpen();
  }
  // 关闭时也让形态跟着宽度走：否则窗口尺寸变过之后的下一次展开又会「边换父节点边开」
  const ro = new ResizeObserver(syncMount);
  const contentBox = contentEl();
  if (contentBox) ro.observe(contentBox);
  syncMount();
  // 再补一次：本组件构造时节点**还没进 DOM**（壳层是 `document.body.append(NowPlaying(), QueuePanel())`），
  // 上面那次定完形态后立刻被壳层搬去 body。等一帧再定，让首次展开时形态与父节点都已就位 ——
  // 不补这一次也能靠 syncMount 的 rAF 兜底动画，但那样第一次展开仍会搬节点，不如让它彻底不动。
  requestAnimationFrame(syncMount);

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
    revealCurrent();
  });

  /** 把当前曲滚到列表可见处 —— **只动 .qp-list 自己的 scrollTop**。
   *
   *  千万别用 `row.scrollIntoView()`：它会把**所有**可滚祖先的 scrollport 一起滚。
   *  `.content` 是 `position:relative; overflow:hidden`——overflow:hidden 的盒子**程序化照样能滚**
   *  （scrollLeft 能设），于是路由视图会跟着横移。
   *  浮窗态之所以没暴露：面板 fixed 挂在 body 下，宿主没有可滚祖先，`block:"nearest"` 无事可做；
   *  一旦停靠（.content-body 内）就变成「0 宽 + overflow:hidden 裁切 + translateX(20px)」，
   *  行落在内容区右缘之外 → `.content` 的 scrollLeft 被设上 → **切歌即 ContentView 错位**。
   *  所以这里用 rect 差值自己滚，绝不碰祖先。 */
  function revealCurrent() {
    const row = list.querySelector<HTMLElement>(".cur");
    if (!row) return;
    const lr = list.getBoundingClientRect();
    const rr = row.getBoundingClientRect();
    if (rr.top < lr.top) list.scrollTop -= lr.top - rr.top;
    else if (rr.bottom > lr.bottom) list.scrollTop += rr.bottom - lr.bottom;
  }

  function rowOf(q: Song, i: number): HTMLElement {
    const row = document.createElement("div");
    row.className = "qp-item" + (i === player.index ? " cur" : "");
    const pic = coverUrl(q, 90); // QQ 音乐 CDN 只认 90/150/300/500 等标准尺寸，64 会 404
    row.innerHTML = `
      <span class="qi-grip" title="拖动排序" aria-hidden="true">${icons.grip}</span>
      <span class="qi-thumb">${pic ? `<img src="${pic}" alt="" loading="lazy"/>` : ""}</span>
      <span class="qi-i">${i === player.index ? (player.loading ? "…" : player.playing ? "♪" : "❚❚") : i + 1}</span>
      <span class="qi-main">
        <span class="qi-n">${escapeHtml(songTitle(q))}</span>
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
