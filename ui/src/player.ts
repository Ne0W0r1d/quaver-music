// Quaver — 全局播放器状态机（常驻于 SPA 壳层，跨视图不销毁，音频不中断）
// 订阅式：任何状态变化 notify 所有 UI（播放条 / 正在播放页 / 队列面板）。
import { api, getPlayUrl, coverUrl } from "./lib/api";
import { parseLrc, type LyricLine } from "./lyric";

export type Song = {
  mid: string;
  id?: number;
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

// base64 -> UTF-8 文本（上游 lyric CGI 的 trans 字段是 base64；relay 合并路径可能已解码成明文——
// 只在"看起来像纯 base64 且解出来含 [ 时间戳"时才解码，否则原样返回）
function b64utf8(s: string): string {
  if (!s) return "";
  if (s.includes("[") || !/^[A-Za-z0-9+/=\s]+$/.test(s)) return s;
  try {
    const bin = atob(s.trim());
    const dec = new TextDecoder("utf-8").decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
    return dec.includes("[") ? dec : "";
  } catch {
    return "";
  }
}

class Player {
  audio = new Audio();
  queue: Song[] = [];
  index = -1;
  mode: Mode = "all";
  loved = new Set<string>(JSON.parse(localStorage.getItem(LS_KEY) ?? "[]"));
  lyrics: LyricLine[] = [];
  lyricState: "idle" | "loading" | "ok" | "none" = "idle";
  expanded = false; // 正在播放页是否展开
  queueOpen = false;
  showTrans = localStorage.getItem(TRANS_KEY) !== "0"; // 歌词翻译显示开关（默认开）
  private _vol = 0.8;    // 0..1（静音前保留）
  private _muted = false;
  private listeners = new Set<Listener>();
  private lyricSeq = 0;

  constructor() {
    this.audio.preload = "auto";
    // 音量持久化：quaver.volume.v1 (0..1) + quaver.muted.v1 ("1")
    const stored = parseFloat(localStorage.getItem(VOL_KEY) ?? "");
    this._vol = isFinite(stored) ? Math.max(0, Math.min(1, stored)) : 0.8;
    this._muted = localStorage.getItem(MUTE_KEY) === "1";
    this.applyVolume();
    this.audio.addEventListener("timeupdate", () => this.notify());
    this.audio.addEventListener("durationchange", () => this.notify());
    this.audio.addEventListener("play", () => this.notify());
    this.audio.addEventListener("pause", () => this.notify());
    this.audio.addEventListener("ended", () => this.onEnded());
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

  /** 用新列表替换队列并从 i 播放（整队列替换：视图语义一致） */
  async playList(songs: Song[], i = 0) {
    this.queue = songs.filter((s) => s?.mid);
    this.index = Math.max(0, Math.min(i, this.queue.length - 1));
    await this.startCurrent();
  }

  enqueueNext(song: Song) {
    if (!song?.mid) return;
    if (this.index < 0) { void this.playList([song], 0); return; }
    this.queue.splice(this.index + 1, 0, song);
    this.notify();
  }

  jump(i: number) {
    if (i < 0 || i >= this.queue.length) return;
    this.index = i;
    void this.startCurrent();
  }

  private async startCurrent() {
    const s = this.current;
    this.lyrics = [];
    this.lyricState = "idle";
    this.notify();
    if (!s) return;
    try {
      const url = await getPlayUrl(s);
      if (this.current !== s) return; // 期间又切了歌
      this.audio.src = url;
      await this.audio.play();
    } catch (e: any) {
      if (this.current === s) this.error = String(e?.message ?? e);
    }
    this.fetchLyric(s);
    this.notify();
  }

  error = "";

  /** 拉取并解析当前歌曲歌词（startCurrent 内部调用；也供外部预热/测试） */
  async fetchLyric(s: Song) {
    const seq = ++this.lyricSeq;
    this.lyricState = "loading";
    this.notify();
    try {
      const r: any = await api(`/getLyric?songmid=${encodeURIComponent(s.mid)}`);
      if (seq !== this.lyricSeq) return;
      const resp = r?.response ?? {};
      const lines = parseLrc(resp.lyric ?? "", b64utf8(resp.trans ?? ""));
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
    if (this.audio.paused) void this.audio.play().catch(() => {});
    else this.audio.pause();
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

  toggleLove(mid?: string) {
    if (!mid) return;
    if (this.loved.has(mid)) this.loved.delete(mid); else this.loved.add(mid);
    localStorage.setItem(LS_KEY, JSON.stringify([...this.loved]));
    this.notify();
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
