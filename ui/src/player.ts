// Quaver — 全局播放器状态机（常驻于 SPA 壳层，跨视图不销毁，音频不中断）
// 订阅式：任何状态变化 notify 所有 UI（播放条 / 正在播放页 / 队列面板）。
import { api, postJson, coverUrl, resolveStreamUrl, effectiveQuality, getSessionQuality, setSessionQuality, setLastStream, writeSongType, type StreamResult } from "./lib/api";
import { parseLrc, type LyricLine } from "./lyric";

export type Song = {
  mid: string;
  id?: number;
  type?: number;
  name: string;
  singer?: { name: string }[];
  album?: { pmid?: string };
  interval?: number;
  _key?: string;
};

export type Mode = "off" | "all" | "one";

type Listener = () => void;

const LS_KEY = "quaver.loved.v1";
const VOL_KEY = "quaver.volume.v1";
const MUTE_KEY = "quaver.muted.v1";
const TRANS_KEY = "quaver.showTrans.v1";

// 「我喜欢」(dirid=201) 预载：每页条数 + 总上限（防超大歌单一口气拉爆首屏），
// 以及预载结果的新鲜期——期内视图直接吃缓存，过期才回源对账。
// 页尽量大：上游分页读带缓存，跨页拼接偶发「页码错位少一首」，单请求拿全最稳（500 首 ≈ 700KB）。
const LOVED_PAGE = 500;
const LOVED_MAX = 1000;
const LOVED_TTL = 60_000;

class Player {
  audio = new Audio();
  queue: Song[] = [];
  index = -1;
  mode: Mode = "all";
  loved = new Set<string>(JSON.parse(localStorage.getItem(LS_KEY) ?? "[]"));
  /** 红心态版本号：每次变更 +1（UI 侧据此去重，避免 notify 空转重画几百行） */
  loveVersion = 0;
  /** 「我喜欢」预载的歌曲列表（视图首帧直接渲染，不再空转一轮分页拉取） */
  likedCache: Song[] | null = null;
  /** 我喜欢总曲数（服务端 total；被 LOVED_MAX 截断时用于展示） */
  likedTotal = 0;
  /** mid → 收藏写接口所需引用：song_id + 读接口的 song_type（预载回填；行对象缺 id 时兜底） */
  private lovedRef = new Map<string, { id: number; type: number }>();
  private likedAt = 0;                       // 预载完成时刻（LOVED_TTL 判新鲜）
  private likedFlight: Promise<boolean> | null = null; // 飞行中的预载（并发共享）
  lyrics: LyricLine[] = [];
  lyricState: "idle" | "loading" | "ok" | "none" = "idle";
  loading = false; // 正在取链/缓冲（UI 画加载指示）
  expanded = false; // 正在播放页是否展开
  queueOpen = false;
  showTrans = localStorage.getItem(TRANS_KEY) !== "0"; // 歌词翻译显示开关（默认开）
  private _vol = 0.8;    // 0..1（静音前保留）
  private _muted = false;
  private listeners = new Set<Listener>();
  private lyricSeq = 0;
  private playSeq = 0;   // startCurrent 竞态令牌：换曲即作废上一轮
  private prefetch = new Map<string, Promise<StreamResult>>(); // mid+档 → 已协商流（单击预热，双击秒起播）
  private pendingSeek = 0; // 换音质续播：新流 metadata 就绪后跳到旧进度

  constructor() {
    this.audio.preload = "auto";
    // 音量持久化：quaver.volume.v1 (0..1) + quaver.muted.v1 ("1")
    const stored = parseFloat(localStorage.getItem(VOL_KEY) ?? "");
    this._vol = isFinite(stored) ? Math.max(0, Math.min(1, stored)) : 0.8;
    this._muted = localStorage.getItem(MUTE_KEY) === "1";
    this.applyVolume();
    this.audio.addEventListener("timeupdate", () => this.notify());
    this.audio.addEventListener("durationchange", () => this.consumePendingSeek());
    this.audio.addEventListener("loadedmetadata", () => this.consumePendingSeek());
    this.audio.addEventListener("play", () => this.notify());
    this.audio.addEventListener("pause", () => this.notify());
    this.audio.addEventListener("ended", () => this.onEnded());
    // 起播后仍需缓冲（网络卡顿）→ 保持加载指示；playing 事件说明已能出声
    this.audio.addEventListener("waiting", () => { if (this.current) { this.loading = true; this.notify(); } });
    this.audio.addEventListener("playing", () => { if (this.loading) { this.loading = false; this.error = ""; this.notify(); } });
    this.audio.addEventListener("canplay", () => { if (this.loading && !this.audio.paused) { this.loading = false; this.notify(); } });
    this.audio.addEventListener("stalled", () => { if (this.current && !this.audio.paused) { this.loading = true; this.notify(); } });
    this.audio.addEventListener("error", () => {
      // src 加载/解码失败（含 token 过期、上游断流）→ 可重试错误态，避免永久转圈
      if (!this.current || !this.audio.src) return;
      this.loading = false;
      this.error = "音频流加载失败，可能已过期：再次点击播放或换一首";
      this.notify();
    });
  }

  on(fn: Listener) {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }
  private notify() { for (const fn of [...this.listeners]) { try { fn(); } catch (e) { console.warn(e); } } }
  /** UI 组件反向驱动状态（展开/收起等）后广播 */
  notifyPublic() { this.notify(); }

  get current(): Song | undefined { return this.queue[this.index]; }
  get playing() { return !this.audio.paused; }
  get time() { return this.audio.currentTime || 0; }
  get duration() { return this.audio.duration || this.current?.interval || 0; }

  // —— 音量 ——
  get volume() { return this._vol; }        // 0..1（静音时保留原值）
  get muted() { return this._muted; }
  private applyVolume() {
    this.audio.volume = this._muted ? 0 : this._vol;
    this.audio.muted = false; // 统一走 volume，避免双通道状态不一致
  }
  setVolume(v: number, unmute = true) {
    this._vol = Math.max(0, Math.min(1, v));
    if (unmute && this._muted && this._vol > 0) this._muted = false;
    localStorage.setItem(VOL_KEY, String(this._vol));
    if (!this._muted) localStorage.removeItem(MUTE_KEY);
    this.applyVolume();
    this.notify();
  }
  toggleMute() {
    this._muted = !this._muted;
    localStorage.setItem(MUTE_KEY, this._muted ? "1" : "0");
    this.applyVolume();
    this.notify();
  }

  toggleTrans() {
    this.showTrans = !this.showTrans;
    localStorage.setItem(TRANS_KEY, this.showTrans ? "1" : "0");
    this.notify();
  }

  /** 用新列表替换队列并从 i 播放（整队列替换：视图语义一致）。不 await：双击即刻打断切歌。 */
  playList(songs: Song[], i = 0) {
    this.queue = songs.filter((s) => s?.mid);
    this.index = Math.max(0, Math.min(i, this.queue.length - 1));
    void this.startCurrent();
  }

  enqueueNext(song: Song) {
    if (!song?.mid) return;
    if (this.index < 0) { this.playList([song], 0); return; }
    this.queue.splice(this.index + 1, 0, song);
    this.notify();
  }

  jump(i: number) {
    if (i < 0 || i >= this.queue.length) return;
    this.index = i;
    void this.startCurrent();
  }

  private consumePendingSeek() {
    if (this.pendingSeek > 1 && isFinite(this.audio.duration) && this.audio.duration > this.pendingSeek) {
      const t = this.pendingSeek;
      this.pendingSeek = 0;
      try { this.audio.currentTime = t; } catch { /* 稍后 timeupdate 再补 */ this.pendingSeek = t; }
    } else if (this.pendingSeek > 1 && !isFinite(this.audio.duration)) {
      /* 元数据未就绪：保留 pendingSeek 等下一次 durationchange/loadedmetadata */
    } else {
      this.pendingSeek = 0;
    }
    this.notify();
  }

  /** 立即打断当前取链/缓冲并跳转（双击新歌用：旧 audio.src 的排队 play promise 一并作废） */
  private interrupt() {
    this.playSeq++;
    this.loading = false;
    this.error = "";
    this.pendingSeek = 0;
    try { this.audio.pause(); } catch { /* noop */ }
    this.audio.removeAttribute("src"); // 断开旧流下载（token 中继无 Range 请求即停）
    try { this.audio.load(); } catch { /* noop */ } // 让旧 play() promise 以 AbortError 结束
  }

  private async startCurrent(resumeTo = 0) {
    const s = this.current;
    this.interrupt();
    this.lyrics = [];
    this.lyricState = "idle";
    if (!s) { this.notify(); return; }
    this.loading = true;
    this.notify();
    const seq = this.playSeq;
    try {
      const r = await this.getStream(s); // 命中单击预取的链接 → 直接跳过取链
      if (seq !== this.playSeq || this.current !== s) return; // 期间又切了歌：本轮作废
      setLastStream({ tier: r.tier, label: r.label, degraded: r.degraded });
      this.applyStream(r.url);
      if (resumeTo > 1) this.pendingSeek = resumeTo; // 换音质等场景：元数据就绪后从旧进度续播
      try {
        await this.audio.play();
      } catch (pe: any) {
        // AbortError = play 被更新的 load 打断。旧轮次直接弃；新轮次重试一次再放弃。
        if (pe?.name === "AbortError") {
          if (seq !== this.playSeq || this.current !== s) return;
          await this.audio.play(); // load 竞态后的补播（此时资源选定应已稳定）
        } else throw pe;
      }
      if (seq !== this.playSeq) return;
      this.loading = false;
      this.error = "";
    } catch (e: any) {
      if (seq === this.playSeq && this.current === s) {
        this.loading = false;
        this.error = String(e?.message ?? e);
      }
    }
    if (seq === this.playSeq && this.current === s) this.fetchLyric(s); // 被作废的轮次不拉歌词，防竞态覆盖
    this.notify();
  }

  /** 挂 URL 到 audio。注意：src 赋值本身就会触发媒体 load 算法，绝不能再补 load()——
   *  双 load 会把随后的 play() 以 AbortError 打断（"play() request was interrupted by a new load request"）。 */
  private applyStream(url: string) {
    this.audio.src = url;
  }

  // —— 单击预加载：行点击即后台协商播放链接（含上游取链+嗅探这两次慢 RTT），
  //    双击起播时命中缓存即刻开流。单击新内容就清旧预取再预载新的（只留一份，释放内存/后端 token 表）。
  private prefetchedMid = "";

  prefetchSong(song: Song | undefined) {
    if (!song?.mid) return;
    const q = String(effectiveQuality());
    if (song.mid === this.prefetchedMid && this.prefetch.has(q + "|" + song.mid)) return;
    this.prefetch.clear(); // 清理旧预加载链接引用（token 由后端 TTL 回收；前端不再持有下载）
    this.prefetchedMid = song.mid;
    const key = q + "|" + song.mid;
    const p = resolveStreamUrl(song, q as any);
    p.catch(() => { if (this.prefetch.get(key) === p) this.prefetch.delete(key); });
    this.prefetch.set(key, p);
  }

  /** getPlayUrl 语义的内部入口：预取命中用预取结果，否则现场协商 */
  private async getStream(s: Song): Promise<StreamResult> {
    const q = String(effectiveQuality());
    const hit = this.prefetch.get(q + "|" + s.mid);
    this.prefetch.clear(); // 用后即弃：链接是一次性上下文（会员/曲库状态可能变化），不跨切歌复用
    if (hit) {
      try { return await hit; } catch { /* 预取失败 → 现场重来 */ }
    }
    return resolveStreamUrl(s, q as any);
  }

  error = "";

  /** 拉取并解析当前歌曲歌词（startCurrent 内部调用；也供外部预热/测试） */
  async fetchLyric(s: Song) {
    const seq = ++this.lyricSeq;
    this.lyricState = "loading";
    this.notify();
    try {
      const d: any = await api(`/song/${encodeURIComponent(s.mid)}/lyric?trans=1`);
      if (seq !== this.lyricSeq) return;
      const lines = parseLrc(d?.lyric ?? "", d?.trans ?? "");
      // 纯音乐占位行（"[00:00.00]此歌曲为没有填词…"）也照常显示
      this.lyrics = lines;
      this.lyricState = lines.length ? "ok" : "none";
    } catch {
      if (seq === this.lyricSeq) this.lyricState = "none";
    }
    this.notify();
  }

  toggle() {
    if (!this.current) return;
    // 上轮取链/加载失败或流已断开 → 重新协商起播（重试语义）
    if (this.error || (!this.audio.src && !this.loading)) { void this.startCurrent(this.audio.currentTime > 1 ? this.audio.currentTime : 0); return; }
    if (this.loading) { this.interrupt(); this.notify(); return; } // 加载中再点 = 取消
    if (this.audio.paused) void this.audio.play().catch(() => {});
    else this.audio.pause();
  }

  // —— 播放条音质切换（会话级：不持久化；带 Fallback 协商，切档即从当前进度重挂流） ——
  switchQuality(q: Parameters<typeof setSessionQuality>[0]) {
    const cur = getSessionQuality();
    if ((q ?? null) === cur && this.current && this.audio.src && !this.error) { this.notify(); return; } // 同档重复点：不打断
    const at = this.audio.currentTime;
    setSessionQuality(q);
    this.prefetch.clear();
    this.prefetchedMid = "";
    if (this.current) void this.startCurrent(at > 1 ? at : 0);
    else this.notify();
  }

  next(auto = false) {
    if (!this.queue.length) return;
    if (auto && this.mode === "one") { this.audio.currentTime = 0; void this.audio.play(); return; }
    this.jump((this.index + 1) % this.queue.length);
  }

  prev() {
    if (!this.queue.length) return;
    if (this.time > 3) { this.audio.currentTime = 0; return; }
    this.jump((this.index - 1 + this.queue.length) % this.queue.length);
  }

  private onEnded() {
    this.error = "";
    if (this.mode === "off" && this.index === this.queue.length - 1) { this.notify(); return; }
    this.next(true);
  }

  cycleMode() {
    this.mode = this.mode === "off" ? "all" : this.mode === "all" ? "one" : "off";
    this.notify();
  }

  seek(sec: number) {
    if (isFinite(this.audio.duration) && this.audio.duration) {
      this.audio.currentTime = Math.max(0, Math.min(sec, this.audio.duration));
    }
    this.notify();
  }

  // —— 单曲收藏（红心）：本地「我喜欢」是全站红心的唯一真相源 ——

  private persistLoved() {
    localStorage.setItem(LS_KEY, JSON.stringify([...this.loved]));
  }

  /** 红心态唯一写入口（渲染读 this.loved，落盘走这里） */
  private setLoved(mid: string, on: boolean, ref?: { id: number; type: number }) {
    if (on) {
      this.loved.add(mid);
      if (ref) this.lovedRef.set(mid, ref);
    } else this.loved.delete(mid);
    this.loveVersion++;
    this.persistLoved();
  }

  /** 「我喜欢」预载：分页拉全收藏的单曲 → 灌满红心态（各视图默认点亮）+ 缓存列表。
   *  - 幂等：飞行中共享同一次请求；fresh=false 且缓存未过期（LOVED_TTL）直接复用。
   *  - 拉全了整体以服务端为准；被 LOVED_MAX 截断时只做并集，不误灭本地已亮红心。
   *  - 失败不清空红心态（未登录/上游抖动时保留本地缓存），返回是否成功。 */
  loadLoved(fresh = false): Promise<boolean> {
    if (this.likedFlight) return this.likedFlight;
    if (!fresh && this.likedCache && Date.now() - this.likedAt < LOVED_TTL) return Promise.resolve(true);
    let flight!: Promise<boolean>;
    flight = (async () => {
      const all: Song[] = [];
      let total = 0;
      for (let page = 1; all.length < LOVED_MAX; page++) {
        const r: any = await api(`/user/liked?page=${page}&num=${LOVED_PAGE}`);
        const batch: Song[] = r?.songs ?? [];
        if (page === 1) total = Number(r?.total ?? 0);
        all.push(...batch);
        if (!r?.hasmore || !batch.length) break;
      }
      const mids = new Set<string>();
      for (const s of all) {
        if (!s?.mid) continue;
        mids.add(s.mid);
        if (s.id) this.lovedRef.set(s.mid, { id: s.id, type: s.type ?? 1 }); // 存读侧原值，写时再转写侧枚举
      }
      if (all.length >= total) this.loved = mids;
      else for (const m of mids) this.loved.add(m);
      this.likedCache = all;
      this.likedTotal = total || all.length;
      this.likedAt = Date.now();
      this.loveVersion++;
      this.persistLoved();
      this.notify();
      return true;
    })()
      .catch((e) => {
        console.warn("「我喜欢」预载失败（保留本地红心态）", e);
        return false;
      })
      .finally(() => { if (this.likedFlight === flight) this.likedFlight = null; });
    this.likedFlight = flight;
    return flight;
  }

  /** 切换单曲收藏（红心）：乐观更新、失败回滚，返回写接口终态（null = 缺少 song_id 无从下手）。
   *  取消收藏同样走在线 unlike 接口，「我喜欢」缓存同步移出该曲。 */
  async toggleLove(song?: Song): Promise<boolean | null> {
    const mid = song?.mid;
    if (!mid) return null;
    // 行对象可能来自不带数字 id 的上下文（如专辑曲目）：回落到预载时记下的 song_id
    const ref = song.id ? { id: song.id, type: song.type ?? 1 } : this.lovedRef.get(mid);
    if (!ref) return null;
    const on = !this.loved.has(mid);
    this.setLoved(mid, on, ref);
    this.notify();
    try {
      await postJson(on ? "/song/like" : "/song/unlike",
        { song_id: ref.id, song_type: writeSongType(ref.type) });
    } catch (e: any) {
      console.warn("收藏同步失败", e);
      this.setLoved(mid, !on, ref); // 回滚
      this.error = "收藏失败：" + (e?.message ?? e);
      this.notify();
      return !on;
    }
    // 缓存与列表计数跟进（写接口已确认，视图据此即时自洽）
    if (on) {
      if (this.likedCache && !this.likedCache.some((x) => x.mid === mid)) this.likedCache.unshift(song!);
      this.likedTotal++;
    } else {
      if (this.likedCache) this.likedCache = this.likedCache.filter((x) => x.mid !== mid);
      if (this.likedTotal > 0) this.likedTotal--;
    }
    return on;
  }

  /** 高亮当前页面对应的歌曲行（.playing 类），与旧行为一致 */
  markActive() {
    document.querySelectorAll(".card.playing,.row.playing").forEach((e) => e.classList.remove("playing"));
    const key = this.current?.mid;
    if (!key) return;
    document.querySelectorAll(`[data-songkey="${CSS.escape(key)}"]`).forEach((e) => e.classList.add("playing"));
  }
}

export const player = new Player();
export { coverUrl };

// 开发/自动化测试钩子：shell 挂载时暴露单例（生产构建里 vite define 会剔除）
declare global { interface Window { __quaverPlayer?: Player } }
if (import.meta.env?.DEV) window.__quaverPlayer = player;
