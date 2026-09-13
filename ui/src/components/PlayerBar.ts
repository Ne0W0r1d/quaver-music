// 底部播放条（常驻于 SPA 壳层，切视图不销毁；悬浮窗底）
// 左：封面（点击展开/收起「正在播放」页）+ 歌名/歌手
// 中：上一首 · 播放/暂停 · 下一首；右：静音 · 循环 · 红心 · 队列 · 展开
// 进度：整个 Bar 按下去即可拖拽 seek（拖中圆点/时间跟手，松手才真正提交），顶边细线只是视觉指示
// 音量：浮窗形式 —— 悬停/点击静音按钮弹出玻璃小窗，静音图标 + 滑杆 + 读数一体
import { player } from "../player";
import { coverUrl } from "../lib/api";
import { fmtDur } from "../lyric";
import { icons } from "../lib/icons";
import { extractCoverColor, toBarColors } from "../lib/color";

const clamp01 = (f: number) => Math.max(0, Math.min(1, f));

export function PlayerBar(): HTMLElement {
  const el = document.createElement("div");
  el.className = "player";
  el.id = "player-bar";
  el.innerHTML = `
    <div class="pb-fill" id="pb-fill"></div>
    <div class="pb-left">
      <button class="pb-cover" id="pb-cover" title="展开歌词 / 正在播放"></button>
      <div class="now">
        <div class="t" id="pb-title">未在播放</div>
        <div class="s" id="pb-sub">点一首歌试试</div>
      </div>
    </div>
    <div class="pb-mid">
      <button class="pb-btn" id="pb-prev" aria-label="上一首">${icons.prev}</button>
      <button class="pb-btn pb-play" id="pb-play" aria-label="播放/暂停">${icons.play}</button>
      <button class="pb-btn" id="pb-next" aria-label="下一首">${icons.next}</button>
    </div>
    <div class="pb-right">
      <span class="pb-time" id="pb-time">0:00 / 0:00</span>
      <button class="pb-btn pb-ghost" id="pb-mute" aria-label="音量 / 静音"></button>
      <button class="pb-btn pb-ghost" id="pb-loop" aria-label="循环模式"></button>
      <button class="pb-btn pb-ghost" id="pb-love" aria-label="收藏">${icons.heart}</button>
      <button class="pb-btn pb-ghost" id="pb-queue" aria-label="播放队列">${icons.queue}</button>
      <button class="pb-btn pb-ghost" id="pb-expand" aria-label="展开歌词">${icons.chevronUp}</button>
    </div>
    <!-- 音量浮窗：静音控制 + 滑杆 + 读数 -->
    <div class="pb-volpop" id="pb-volpop" role="group" aria-label="音量">
      <button class="pb-btn pb-ghost" id="pb-mute2" aria-label="静音"></button>
      <input class="pb-vol" id="pb-vol" type="range" min="0" max="100" step="1" value="80" aria-label="音量" />
      <span class="pb-volnum" id="pb-volnum">80%</span>
    </div>
  `;

  const $ = <T extends HTMLElement>(id: string) => el.querySelector<T>("#" + id)!;
  const cover = $("pb-cover"), title = $("pb-title"), sub = $("pb-sub");
  const time = $("pb-time"), fill = $("pb-fill");
  const play = $("pb-play"), loop = $("pb-loop"), love = $("pb-love"), expand = $("pb-expand");
  const mute = $("pb-mute"), mute2 = $("pb-mute2");
  const pop = $("pb-volpop");
  const vol = el.querySelector<HTMLInputElement>("#pb-vol")!;
  const volnum = $("pb-volnum");

  const toggleExpand = () => {
    if (!player.current) return;
    player.expanded = !player.expanded;
    player.notifyPublic();
  };
  cover.onclick = toggleExpand;
  expand.onclick = toggleExpand;

  $("pb-prev").onclick = () => player.prev();
  play.onclick = () => player.toggle();
  $("pb-next").onclick = () => player.next(false);
  loop.onclick = () => player.cycleMode();
  love.onclick = () => player.toggleLove(player.current);
  $("pb-queue").onclick = () => { player.queueOpen = !player.queueOpen; player.notifyPublic(); };
  mute.onclick = () => player.toggleMute();
  mute2.onclick = () => player.toggleMute();

  // 音量滑杆（拖动即时生效；拉到 0 静音态，调回自动取消静音）
  vol.addEventListener("input", () => { paintVol(); player.setVolume(Number(vol.value) / 100); });

  // 音量浮窗：悬停静音按钮显示；移开短暂宽限；点击条外关闭
  let hideTimer = 0;
  const showPop = () => { window.clearTimeout(hideTimer); el.classList.add("vol-open"); };
  const queueHide = () => { window.clearTimeout(hideTimer); hideTimer = window.setTimeout(() => el.classList.remove("vol-open"), 220); };
  for (const t of [mute, pop]) {
    t.addEventListener("pointerenter", showPop);
    t.addEventListener("pointerleave", queueHide);
  }
  document.addEventListener("pointerdown", (e) => {
    const t = e.target as HTMLElement;
    if (!el.contains(t) || !t.closest("#pb-mute, #pb-volpop")) el.classList.remove("vol-open");
  });

  // 滚轮在 Bar 上 = 微调音量
  el.addEventListener("wheel", (e) => {
    e.preventDefault();
    player.setVolume(player.volume - Math.sign(e.deltaY) * 0.04);
  }, { passive: false });

  // —— 整条拖拽 seek：pointerdown 于 Bar 任意非控件处起拖；拖中只做视觉预览，松手提交 ——
  let dragging = false;
  let scrubFrac = 0;
  const fracOf = (clientX: number) => {
    const r = el.getBoundingClientRect(); // 染色 fill 即进度条：左右各缩进 10px 与 fill 对齐
    return clamp01((clientX - r.left - 10) / (r.width - 20));
  };
  const paintScrub = () => {
    el.style.setProperty("--pf", String(scrubFrac)); // 无单位：fill 宽度 = calc((100% - 20px) * --pf)
    time.textContent = `${fmtDur(scrubFrac * player.duration)} / ${fmtDur(player.duration)}`;
  };
  el.addEventListener("pointerdown", (e) => {
    const t = e.target as HTMLElement;
    if (t.closest("button, input, .pb-volpop")) return; // 控件区不吞点击
    if (!player.duration) return;
    dragging = true;
    el.classList.add("scrubbing");
    try { el.setPointerCapture(e.pointerId); } catch { /* 合成事件降级 */ }
    scrubFrac = fracOf(e.clientX);
    paintScrub();
    e.preventDefault();
  });
  el.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    scrubFrac = fracOf(e.clientX);
    paintScrub();
  });
  const endScrub = () => {
    if (!dragging) return;
    dragging = false;
    el.classList.remove("scrubbing");
    player.seek(scrubFrac * player.duration);
  };
  el.addEventListener("pointerup", endScrub);
  el.addEventListener("pointercancel", endScrub);

  // 音量浮窗绘制（滑杆填充 --v + 图标档位 + 读数）
  function paintVol() {
    const v = document.activeElement === vol ? Number(vol.value) / 100 : player.muted ? 0 : player.volume;
    vol.style.setProperty("--v", `${Math.round(v * 100)}%`);
    volnum.textContent = `${Math.round(v * 100)}%`;
    vol.classList.toggle("off", player.muted || v === 0);
    const ic = player.muted || v === 0 ? icons.volMute : v < 0.5 ? icons.volLow : v < 0.99 ? icons.volMid : icons.volHigh;
    mute.innerHTML = ic;
    mute2.innerHTML = ic;
    mute.classList.toggle("on", player.muted);
    mute2.classList.toggle("on", player.muted);
  }

  // 封面染色：主色 → Bar 已播区背景即进度指示（fill 宽度 = --p）
  let colorKey = "";
  async function paintTint(pic: string) {
    if (pic === colorKey) return;
    colorKey = pic;
    if (!pic) { el.style.removeProperty("--tint"); el.style.removeProperty("--tint-line"); return; }
    const rgb = await extractCoverColor(pic);
    if (colorKey !== pic) return; // 期间已换曲
    const c = toBarColors(rgb);
    el.style.setProperty("--tint", c.soft);
    el.style.setProperty("--tint-line", c.line);
  }

  // 订阅状态
  player.on(() => {
    const s = player.current;
    title.textContent = s?.name ?? "未在播放";
    sub.textContent = s ? (s.singer ?? []).map((x) => x.name).join(" / ") : "点一首歌试试";
    const pic = s ? coverUrl(s, 150) : "";
    cover.innerHTML = pic ? `<img src="${pic}" alt=""/>` : "";
    void paintTint(pic);
    play.innerHTML = player.playing ? icons.pause : icons.play;
    loop.innerHTML = player.mode === "off" ? icons.loopOff : player.mode === "all" ? icons.loopAll : icons.loopOne;
    loop.classList.toggle("on", player.mode !== "off");
    love.innerHTML = s && player.loved.has(s.mid) ? icons.heartFill : icons.heart;
    love.classList.toggle("on", !!s && player.loved.has(s.mid));
    expand.innerHTML = player.expanded ? icons.chevronDown : icons.chevronUp;
    if (!dragging) {
      const d = player.duration, t = player.time;
      const frac = player.current && d ? Math.min(1, t / d) : 0; // 无当前曲：分数归零，染色条不残留
      el.style.setProperty("--pf", String(frac));
      time.textContent = `${fmtDur(t)} / ${fmtDur(d)}`;
    }
    if (document.activeElement !== vol) vol.value = String(Math.round((player.muted ? 0 : player.volume) * 100));
    paintVol();
    player.markActive();
  });
  return el;
}
