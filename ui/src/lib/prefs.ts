// Quaver — 用户偏好（外观主题 / 字体 / 窗口装饰 CSD·SSD / 解码后端），localStorage 持久化。
// 主题与字体在本模块直接落到 <html>：data-theme 驱动 style.css 的变量组，
// CSS 变量 --font-ui / --font-lyric 分别作用于界面与歌词。

export type ThemeMode = "system" | "light" | "dark";
export type DecorMode = "csd" | "ssd";

const K_THEME = "quaver.theme.v1";
const K_UIFONT = "quaver.font.ui.v1";
const K_LYRFONT = "quaver.font.lyric.v1";
const K_DECOR = "quaver.decor.v1";
const K_DECODE = "quaver.decode.v1";

// —— 外观模式 ——
export function getTheme(): ThemeMode {
  const v = localStorage.getItem(K_THEME);
  return v === "light" || v === "dark" ? v : "system";
}
const mq = window.matchMedia("(prefers-color-scheme: dark)");
export function effectiveTheme(mode: ThemeMode = getTheme()): "light" | "dark" {
  return mode === "system" ? (mq.matches ? "dark" : "light") : mode;
}
export function applyTheme() {
  document.documentElement.dataset.theme = effectiveTheme();
}
export function setTheme(m: ThemeMode) {
  localStorage.setItem(K_THEME, m);
  applyTheme();
}
mq.addEventListener("change", () => { if (getTheme() === "system") applyTheme(); });

// —— 字体（system = 保持默认栈，值写入 CSS 变量） ——
export const FONT_CHOICES: Record<string, string> = {
  system: "系统默认",
  "sans": '"Noto Sans CJK SC", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif',
  "serif": '"Noto Serif CJK SC", "Source Han Serif SC", "Songti SC", SimSun, serif',
  "mono": "ui-monospace, \"JetBrains Mono\", \"Noto Sans Mono CJK SC\", monospace",
};
export const FONT_LABELS: Record<string, string> = {
  system: "系统默认", sans: "黑体（无衬线）", serif: "宋体（衬线）", mono: "等宽",
};

export function getUiFont() { return localStorage.getItem(K_UIFONT) || "system"; }
export function getLyricFont() { return localStorage.getItem(K_LYRFONT) || "system"; }
export function applyFonts() {
  const r = document.documentElement.style;
  const ui = FONT_CHOICES[getUiFont()] ?? "";
  const ly = FONT_CHOICES[getLyricFont()] ?? "";
  if (ui) r.setProperty("--font-ui", ui); else r.removeProperty("--font-ui");
  if (ly) r.setProperty("--font-lyric", ly); else r.removeProperty("--font-lyric");
}
export function setUiFont(v: string) { localStorage.setItem(K_UIFONT, v); applyFonts(); }
export function setLyricFont(v: string) { localStorage.setItem(K_LYRFONT, v); applyFonts(); }

// —— 窗口装饰：CSD=自绘（右上角平铺按钮簇，无标题栏/无浮窗底）；SSD=系统标题栏（Electron 重建窗口生效） ——
export function getDecor(): DecorMode {
  return localStorage.getItem(K_DECOR) === "ssd" ? "ssd" : "csd";
}
export function applyDecor() {
  document.body.classList.toggle("ssd", getDecor() === "ssd");
}
export function setDecor(m: DecorMode) {
  localStorage.setItem(K_DECOR, m);
  applyDecor();
  const bridge = (window as any).quaverCSD;
  if (bridge?.setDecor) bridge.setDecor(m); // Electron：主进程改 frame 并重建窗口
}

// —— 解码后端：MPV=原生引擎（默认，Electron 壳层经主进程 mpv 播放）；
//    Blink=浏览器 <audio>（兜底/对照用）。旧值 FFmpeg 归一为 MPV（该管线已下线）。
//    偏好只决定启动选择；引擎不可用时播放器自动落 Blink 并在设置页提示。 ——
export type DecodeBackend = "MPV" | "Blink";
export function getDecode(): DecodeBackend {
  return localStorage.getItem(K_DECODE) === "Blink" ? "Blink" : "MPV";
}
export function setDecode(v: DecodeBackend) {
  localStorage.setItem(K_DECODE, v);
}

// —— 音频输出设备（MPV 后端）：mpv audio-device 名（"auto" = 系统默认）。
//    渲染层持久化，引擎拉起/重拉后据此应用；Blink 后端不消费此偏好。 ——
const K_ADEV = "quaver.audio.device.v1";
export function getAudioDevice(): string {
  return localStorage.getItem(K_ADEV) || "auto";
}
export function setAudioDevice(id: string) {
  localStorage.setItem(K_ADEV, id || "auto");
}

// —— 淡入淡出（仅 MPV 后端）：起播淡入 / 暂停与切歌淡出。时长交给引擎做振幅包络。 ——
export type FadePreset = "off" | "short" | "normal" | "long";
export const FADE_PRESETS: Record<FadePreset, { inMs: number; outMs: number }> = {
  off: { inMs: 0, outMs: 0 },
  short: { inMs: 150, outMs: 120 },
  normal: { inMs: 400, outMs: 250 },
  long: { inMs: 800, outMs: 500 },
};
const K_FADE = "quaver.fade.v1";
export function getFade(): FadePreset {
  const v = localStorage.getItem(K_FADE);
  return v === "off" || v === "short" || v === "long" ? v : "normal";
}
export function setFade(v: FadePreset) {
  localStorage.setItem(K_FADE, v);
}
export function getFadeMs() { return FADE_PRESETS[getFade()]; }

// —— 音质 Fallback 排序：no-atmos=自动/回退时不优先落到臻品全景声（默认，母带优先），
//    rank=按标准 rank 降序回退（全景声在其 rank 位置自然参与） ——
const K_QFALLBACK = "quaver.qfallback.v1";
export type FallbackSort = "no-atmos" | "rank";
export function getFallbackSort(): FallbackSort {
  return localStorage.getItem(K_QFALLBACK) === "rank" ? "rank" : "no-atmos";
}
export function setFallbackSort(v: FallbackSort) { localStorage.setItem(K_QFALLBACK, v); }

// —— 关闭按钮行为：tray=缩放到托盘（默认）；quit=退出程序。CSD 胶囊与 SSD 标题栏共用。
//    偏好经 Electron 桥同步到主进程（主进程拦截 window close 决定 hide 还是真退出）。 ——
const K_CLOSEACT = "quaver.closeaction.v1";
export type CloseAction = "tray" | "quit";
export function getCloseAction(): CloseAction {
  return localStorage.getItem(K_CLOSEACT) === "quit" ? "quit" : "tray";
}
export function setCloseAction(v: CloseAction) {
  localStorage.setItem(K_CLOSEACT, v);
  const bridge = (window as any).quaverCSD;
  if (bridge?.setCloseAction) bridge.setCloseAction(v);
}
// 启动时把已存偏好推给主进程（Electron 壳层）；浏览器 dev 下为 no-op
export function syncCloseAction() {
  const bridge = (window as any).quaverCSD;
  if (bridge?.setCloseAction) bridge.setCloseAction(getCloseAction());
}
