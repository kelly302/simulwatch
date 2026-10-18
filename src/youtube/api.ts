import { Http, HttpError } from "../lib/http.ts";
import { Quota, QuotaExhausted } from "../lib/quota.ts";

// YouTube Data API v3 のうち、使う呼び出しだけを包む。
// すべて逐次で呼び、呼ぶ前にクォータを確かめる。

const BASE = "https://www.googleapis.com/youtube/v3";

export interface Thumbnail {
  url: string;
  width?: number;
  height?: number;
}

export interface VideoItem {
  id: string;
  snippet?: {
    publishedAt: string;
    channelId: string;
    channelTitle?: string;
    title: string;
    description: string;
    thumbnails?: Record<string, Thumbnail>;
    liveBroadcastContent?: "none" | "upcoming" | "live";
  };
  liveStreamingDetails?: {
    actualStartTime?: string;
    actualEndTime?: string;
    scheduledStartTime?: string;
    scheduledEndTime?: string;
    concurrentViewers?: string;
  };
  statistics?: { viewCount?: string };
  status?: { privacyStatus?: "public" | "unlisted" | "private"; uploadStatus?: string };
}

export interface PlaylistItem {
  snippet: {
    publishedAt: string;
    channelId: string;
    title: string;
    description: string;
    resourceId: { videoId: string };
    videoOwnerChannelId?: string;
  };
  contentDetails?: { videoId: string; videoPublishedAt?: string };
}

export interface PlaylistInfo {
  id: string;
  snippet?: { publishedAt: string; channelId: string; channelTitle?: string; title: string; description: string };
}

export interface ChannelItem {
  id: string;
  snippet?: { title: string; customUrl?: string; thumbnails?: Record<string, Thumbnail> };
}

export type PlaylistPage =
  | { ok: true; items: PlaylistItem[]; nextPageToken: string | null }
  | { ok: false; reason: "not_found" | "forbidden" };

export class YouTubeApi {
  private readonly http: Http;
  private readonly quota: Quota;
  private readonly key: string;

  constructor(http: Http, quota: Quota, key: string) {
    this.http = http;
    this.quota = quota;
    this.key = key;
  }

  private async call(endpoint: string, path: string, params: Record<string, string>, allowStatus: number[] = []) {
    this.quota.reserve(endpoint);
    const url = new URL(`${BASE}/${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    url.searchParams.set("key", this.key);
    try {
      const res = await this.http.get(url.toString(), { allowStatus });
      this.quota.record(endpoint);
      return res;
    } catch (e) {
      // 失敗したリクエストもクォータを消費する
      if (e instanceof HttpError) {
        this.quota.record(endpoint);
        if (e.status === 403 && /quotaExceeded|dailyLimitExceeded/.test(e.body)) {
          throw new QuotaExhausted("YouTube API quotaExceeded");
        }
      }
      throw e;
    }
  }

  /** 最大50件の動画の詳細。存在しない・非公開の動画は items に含まれない */
  async videos(ids: string[]): Promise<VideoItem[]> {
    if (ids.length === 0) return [];
    if (ids.length > 50) throw new Error("videos.list accepts at most 50 ids");
    const res = await this.call("videos.list", "videos", {
      part: "snippet,liveStreamingDetails,statistics,status",
      id: ids.join(","),
      maxResults: "50",
    });
    return (JSON.parse(res.body).items ?? []) as VideoItem[];
  }

  async playlistPage(playlistId: string, pageToken: string | null, maxResults: number): Promise<PlaylistPage> {
    const params: Record<string, string> = { part: "snippet,contentDetails", playlistId, maxResults: String(maxResults) };
    if (pageToken) params.pageToken = pageToken;
    const res = await this.call("playlistItems.list", "playlistItems", params, [403, 404]);
    if (res.status === 404) return { ok: false, reason: "not_found" };
    if (res.status === 403) {
      if (/quotaExceeded|dailyLimitExceeded/.test(res.body)) throw new QuotaExhausted("YouTube API quotaExceeded");
      return { ok: false, reason: "forbidden" };
    }
    const j = JSON.parse(res.body);
    return { ok: true, items: (j.items ?? []) as PlaylistItem[], nextPageToken: j.nextPageToken ?? null };
  }

  /** 最大50件の再生リストの題名・持ち主。存在しない・非公開の再生リストは items に含まれない */
  async playlists(ids: string[]): Promise<PlaylistInfo[]> {
    if (ids.length === 0) return [];
    if (ids.length > 50) throw new Error("playlists.list accepts at most 50 ids");
    const res = await this.call("playlists.list", "playlists", { part: "snippet", id: ids.join(","), maxResults: "50" });
    return (JSON.parse(res.body).items ?? []) as PlaylistInfo[];
  }

  /** 最大50件のチャンネル */
  async channels(ids: string[]): Promise<ChannelItem[]> {
    if (ids.length === 0) return [];
    const res = await this.call("channels.list", "channels", { part: "snippet", id: ids.join(","), maxResults: "50" });
    return (JSON.parse(res.body).items ?? []) as ChannelItem[];
  }

  /**
   * 動画のコメント（上位。order=relevance）。AI の判定役に見せる手がかり（視聴者のタイムスタンプ・感想）。
   * メン限の動画・コメントを閉じた動画は 403・404 になり null を返す。1回1ユニット
   */
  async commentThreads(videoId: string, maxResults: number): Promise<string[] | null> {
    const res = await this.call("commentThreads.list", "commentThreads", {
      part: "snippet", videoId, maxResults: String(maxResults), order: "relevance", textFormat: "plainText",
    }, [403, 404]);
    if (res.status === 403) {
      if (/quotaExceeded|dailyLimitExceeded/.test(res.body)) throw new QuotaExhausted("YouTube API quotaExceeded");
      return null;
    }
    if (res.status === 404) return null;
    const items = (JSON.parse(res.body).items ?? []) as { snippet: { topLevelComment: { snippet: { textDisplay: string } } } }[];
    return items.map((i) => i.snippet.topLevelComment.snippet.textDisplay);
  }

  /** @handle からチャンネルを引く */
  async channelByHandle(handle: string): Promise<ChannelItem | null> {
    const res = await this.call("channels.list", "channels", { part: "snippet", forHandle: handle.replace(/^@/, "") });
    const items = (JSON.parse(res.body).items ?? []) as ChannelItem[];
    return items[0] ?? null;
  }
}

/** チャンネルID（UC...）から uploads プレイリスト（UU...）を作る */
export function uploadsPlaylistId(channelId: string): string {
  return "UU" + channelId.slice(2);
}

/** メン限動画のプレイリスト（UUMO...） */
export function membersPlaylistId(channelId: string): string {
  return "UUMO" + channelId.slice(2);
}

export function bestThumbnail(thumbs: Record<string, Thumbnail> | undefined): string | null {
  if (!thumbs) return null;
  for (const k of ["medium", "high", "standard", "default", "maxres"]) {
    if (thumbs[k]?.url) return thumbs[k].url;
  }
  return null;
}

export function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}
