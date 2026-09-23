import type { VideoItem } from "../youtube/api.ts";
import type { EventStatus } from "../shared/types.ts";
import { bestThumbnail } from "../youtube/api.ts";

// videos.list の1件から、WatchEvent に入れる状態と時刻を決める（純粋関数）。

export type Classified =
  | {
      kind: "event";
      status: EventStatus;
      started_at: string | null;
      scheduled_start_at: string | null;
      ended_at: string | null;
      view_count: number | null;
      thumbnail_url: string | null;
      title: string;
      description: string;
      channel_id: string;
    }
  /** ライブ配信（プレミア公開を含む）ではない。切り抜きや通常投稿 */
  | { kind: "not_live" }
  /** 非公開・限定公開。アーカイブが見られない扱い */
  | { kind: "unavailable"; reason: string };

export function classifyVideo(v: VideoItem): Classified {
  const privacy = v.status?.privacyStatus;
  if (privacy && privacy !== "public") return { kind: "unavailable", reason: `privacy:${privacy}` };

  const lsd = v.liveStreamingDetails;
  if (!lsd) return { kind: "not_live" };

  const lbc = v.snippet?.liveBroadcastContent ?? "none";
  let status: EventStatus;
  if (lbc === "live") status = "live";
  else if (lbc === "upcoming") status = "upcoming";
  else status = "completed";

  // 実開始が取れれば実開始、なければ予定時刻、それもなければ公開日時
  const started_at = lsd.actualStartTime ?? lsd.scheduledStartTime ?? v.snippet?.publishedAt ?? null;

  // 再生数が欠損しているとき（メン限など）は NULL。0 と区別する
  const raw = v.statistics?.viewCount;
  const view_count = status === "upcoming" || raw === undefined ? null : Number(raw);

  return {
    kind: "event",
    status,
    started_at,
    scheduled_start_at: lsd.scheduledStartTime ?? null,
    ended_at: lsd.actualEndTime ?? null,
    view_count: Number.isFinite(view_count) ? view_count : null,
    thumbnail_url: bestThumbnail(v.snippet?.thumbnails),
    title: v.snippet?.title ?? "",
    description: v.snippet?.description ?? "",
    channel_id: v.snippet?.channelId ?? "",
  };
}
