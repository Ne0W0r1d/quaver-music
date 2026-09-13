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

// 音质档位 = sidecar file_type 整数（映射表见 api-server app.py FILE_TYPES）
export const QUALITIES: Record<string, number> = { "128": 13, "320": 12, flac: 7 };
export type Quality = keyof typeof QUALITIES;

export function getQuality(): Quality {
  const q = localStorage.getItem("quaver.quality.v1");
  return q === "320" || q === "flac" ? q : "128";
}
export function setQuality(q: Quality) {
  localStorage.setItem("quaver.quality.v1", q);
}

interface SongUrlItem { mid: string; url: string; result: number; filename: string }

export async function getPlayUrl(song: any, quality: Quality = getQuality()): Promise<string> {
  const mediaId: string = song.file?.media_mid ?? song.mid;
  const code = QUALITIES[quality] ?? 13;
  const data = await postJson<SongUrlItem[] | { items: SongUrlItem[] }>("/song/urls", {
    file_info: [{ mid: song.mid, media_mid: mediaId }],
    file_type: code,
  });
  const item = (Array.isArray(data) ? data : data.items)?.[0];
  if (!item?.url) throw new Error(item?.result ? `取链接失败 (result=${item.result})` : "暂无播放链接");
  return item.url;
}
