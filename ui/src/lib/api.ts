// Quaver — 浏览器侧 API 封装（全部走同源 /api 中继 → Python sidecar :3200）
// 响应信封：{code:0,msg:"ok",data:...}；错误 {code:-1,msg:...} + HTTP 状态。
export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export const api = async <T = any>(path: string, init?: RequestInit): Promise<T> => {
  const r = await fetch("/api" + path, init);
  let j: any = null;
  try {
    j = await r.json();
  } catch {
    throw new ApiError(r.status, `HTTP ${r.status} ${path}`);
  }
  if (!r.ok || (typeof j?.code === "number" && j.code !== 0)) {
    throw new ApiError(r.status, j?.msg ?? `HTTP ${r.status} ${path}`);
  }
  return j.data as T;
};

export const postJson = <T = any>(path: string, body: unknown): Promise<T> =>
  api<T>(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

export const songArtists = (s: any) => (s.singer ?? []).map((x: any) => x.name).join(" / ");

export const coverUrl = (s: any, size = 300) => {
  const pmid: string = s.album?.pmid ?? "";
  const base = pmid ? pmid.split("_")[0] : (s.album?.mid ?? "");
  return base ? `https://y.gtimg.cn/music/photo_new/T002R${size}x${size}M000${base}.jpg` : "";
};

// 上游 picUrl 常是 http，https 同域可用则升级
export const upPic = (u?: string) => (u ?? "").replace(/^http:/, "https:");

export const fmtTime = (sec: number) => {
  if (!isFinite(sec)) return "0:00";
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
};

// 身份徽章（侧栏/我的页共用）：会员只展示最高档（超级会员 > 豪华绿钻 > 绿钻），
// 音乐人（IsSinger 认证）独立一枚蓝色徽章；非音乐人不展示。
// 配色约定：绿=豪华绿钻/绿钻，橙=超级会员，蓝=音乐人（.badge.green/.orange/.blue）。
export function identityBadges(me: any, vip: any): string {
  const badges: string[] = [];
  if (vip?.svip) badges.push(`<i class="badge orange">超级会员</i>`);
  else if (vip?.identity?.huge_vip) badges.push(`<i class="badge green">豪华绿钻</i>`);
  else if (vip?.identity?.vip) badges.push(`<i class="badge green">绿钻</i>`);
  if (me?.base_info?.is_singer) badges.push(`<i class="badge blue">音乐人</i>`);
  return badges.join("");
}

// 音质档位 = Typhoeus TierId（vendor/Typhoeus/typhoeus/quality.py；后端按会员门控+回退协商）
// 旧整数表（128/320/flac → file_type）随 /song/urls 直连路径保留兼容，播放主链路已走 /stream/*。
export const QUALITIES = {
  "128": "标准音质",
  "320": "高品质 HQ",
  flac: "无损 SQ",
  "640ogg": "无损 SQ (OGG)",
  atmos2: "臻品音质",
  atmos51: "臻品全景声",
  master: "臻品母带",
} as const;
export type Quality = keyof typeof QUALITIES;

export function getQuality(): Quality | "auto" {
  const q = localStorage.getItem("quaver.quality.v1");
  if (q === "auto" || (q && q in QUALITIES)) return q as Quality | "auto";
  return "128";
}
export function setQuality(q: Quality | "auto") {
  localStorage.setItem("quaver.quality.v1", q);
}

// —— Typhoeus 播放流：resolve 协商（会员门控 403 / 加密档 451 / 回退降级 degraded）→ token 中继 ——
interface StreamResolved { token: string; path: string; tier: string; tier_label: string; degraded: boolean; mime: string; size: number }
interface StreamTierView { id: string; label: string; rank: number; hi_res: boolean; locked?: boolean; requires?: number }
interface StreamTiers { membership: number; membership_label: string; tiers: StreamTierView[]; all_tiers: StreamTierView[]; max: string | null }

let tiersCache: StreamTiers | null = null;
export async function getStreamTiers(force = false): Promise<StreamTiers> {
  if (!tiersCache || force) tiersCache = await api<StreamTiers>("/stream/tiers");
  return tiersCache;
}
export const invalidateStreamTiers = () => (tiersCache = null);

// 最近一次协商结果（播放条音质徽章数据源）
export interface LastStream { tier: string; label: string; degraded: boolean }
let lastStream: LastStream | null = null;
export const getLastStream = () => lastStream;

export async function getPlayUrl(song: any, quality: Quality | "auto" = getQuality()): Promise<string> {
  const mediaId: string = song.file?.media_mid ?? song.media_mid ?? song.mid;
  let tier = quality as string;
  let auto = false;
  if (tier === "auto") {
    const t = await getStreamTiers();
    tier = t.max ?? "128";
    auto = true;
  }
  try {
    const r = await postJson<StreamResolved>("/stream/resolve", { mid: song.mid, media_mid: mediaId, tier, auto });
    lastStream = { tier: r.tier, label: r.tier_label, degraded: r.degraded };
    return "/api" + r.path;
  } catch (e: any) {
    // 自动模式 / 上游无资源(502) → 兜底回标准档保证可播；
    // 用户显式选高档但会员不足(403) → 原样抛出，UI 提示开通会员（勿静默降档）
    if ((auto || e?.status === 502) && tier !== "128") {
      const r = await postJson<StreamResolved>("/stream/resolve", { mid: song.mid, media_mid: mediaId, tier: "128", auto: true });
      lastStream = { tier: "128", label: "标准音质", degraded: true };
      return "/api" + r.path;
    }
    throw e;
  }
}
