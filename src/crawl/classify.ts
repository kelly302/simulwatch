import type { VideoItem } from "../youtube/api.ts";
import type { EventStatus, StartedAtSource } from "../shared/types.ts";
import { bestThumbnail } from "../youtube/api.ts";

// videos.list の1件から、WatchEvent に入れる状態と時刻を決める（純粋関数）。

export type Classified =
  | {
      kind: "event";
      status: EventStatus;
      started_at: string | null;
      /** started_at にどの値を入れたか */
      started_at_source: StartedAtSource | null;
      scheduled_start_at: string | null;
      ended_at: string | null;
      view_count: number | null;
      thumbnail_url: string | null;
      title: string;
      description: string;
      channel_id: string;
      /** ライブ配信（プレミア公開を含む）か。false は通常投稿（Twitch の同時視聴の再アップなど） */
      is_live: boolean;
    }
  /** ライブ配信ではない。allowNonLive が false のときだけ返す */
  | { kind: "not_live" }
  /** 非公開・限定公開。アーカイブが見られない扱い */
  | { kind: "unavailable"; reason: string };

export interface ClassifyOptions {
  /** ライブ配信でない動画も枠として扱う（config/detect.yaml の reject.require_live の逆） */
  allowNonLive: boolean;
}

export function classifyVideo(v: VideoItem, opts: ClassifyOptions): Classified {
  const privacy = v.status?.privacyStatus;
  if (privacy && privacy !== "public") return { kind: "unavailable", reason: `privacy:${privacy}` };

  const lsd = v.liveStreamingDetails;
  const base = {
    thumbnail_url: bestThumbnail(v.snippet?.thumbnails),
    title: v.snippet?.title ?? "",
    description: v.snippet?.description ?? "",
    channel_id: v.snippet?.channelId ?? "",
  };
  const raw = v.statistics?.viewCount;

  if (!lsd) {
    if (!opts.allowNonLive) return { kind: "not_live" };
    // 通常投稿。actualStartTime が無いので公開日時で代用する
    const views = raw === undefined ? null : Number(raw);
    return {
      kind: "event",
      status: "completed",
      started_at: v.snippet?.publishedAt ?? null,
      started_at_source: v.snippet?.publishedAt ? "published_at" : null,
      scheduled_start_at: null,
      ended_at: null,
      view_count: Number.isFinite(views) ? views : null,
      ...base,
      is_live: false,
    };
  }

  const lbc = v.snippet?.liveBroadcastContent ?? "none";
  let status: EventStatus;
  if (lbc === "live") status = "live";
  else if (lbc === "upcoming") status = "upcoming";
  else status = "completed";

  // 実開始が取れれば実開始、なければ予定時刻、それもなければ公開日時
  let started_at: string | null = null;
  let started_at_source: StartedAtSource | null = null;
  if (lsd.actualStartTime) [started_at, started_at_source] = [lsd.actualStartTime, "actual_start"];
  else if (lsd.scheduledStartTime) [started_at, started_at_source] = [lsd.scheduledStartTime, "scheduled_start"];
  else if (v.snippet?.publishedAt) [started_at, started_at_source] = [v.snippet.publishedAt, "published_at"];

  // 再生数が欠損しているとき（メン限など）は NULL。0 と区別する
  const view_count = status === "upcoming" || raw === undefined ? null : Number(raw);

  return {
    kind: "event",
    status,
    started_at,
    started_at_source,
    scheduled_start_at: lsd.scheduledStartTime ?? null,
    ended_at: lsd.actualEndTime ?? null,
    view_count: Number.isFinite(view_count) ? view_count : null,
    ...base,
    is_live: true,
  };
}
