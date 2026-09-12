// Quaver — 浏览器侧 API 封装（全部走同源 /api 中继，dev 由 server route 转发 :3200）
export const api = <T = any>(path: string): Promise<T> =>
  fetch("/api" + path).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status} ${path}`);
    return r.json();
  });

export const songArtists = (s: any) => (s.singer ?? []).map((x: any) => x.name).join(" / ");

export const coverUrl = (s: any, size = 300) =>
  s.album?.pmid
    ? `https://y.gtimg.cn/music/photo_new/T002R${size}x${size}M000${s.album.pmid.split("_")[0]}_1.jpg`
    : "";

// 上游 picUrl 常是 http，https 同域可用则升级
export const upPic = (u?: string) => (u ?? "").replace(/^http:/, "https:");

export const fmtTime = (sec: number) => {
  if (!isFinite(sec)) return "0:00";
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
};

export function getPlayUrl(song: any, quality = "128mp3") {
  const mediaId = song.file?.media_mid ?? song.mid;
  return api(`/getMusicPlay/${song.mid}?quality=${encodeURIComponent(quality)}&mediaId=${mediaId}`).then(
    (r: any) => {
      const entry = r?.data?.playUrl?.[song.mid];
      if (!entry?.url) throw new Error(entry?.error ?? "暂无播放链接");
      return entry.url as string;
    },
  );
}

export const play = async (song: any) => getPlayUrl(song).then((url) => window.QuaverPlayer?.playUrl(url, song));
