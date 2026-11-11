import type { Ctx } from "../lib/context.ts";
import { classifyVideo } from "./classify.ts";
import { upsertEvent, classifyOptions } from "./ingest.ts";
import { chunk } from "../youtube/api.ts";
import { tx } from "../lib/db.ts";
import { nowIso } from "../lib/time.ts";
import { log } from "../lib/log.ts";

// 既知の WatchEvent を videos.list で取り直す。
// - 状態（upcoming → live → completed）・開始時刻・再生数を上書きする
// - videos.list に返ってこない・非公開になった枠はアーカイブ消失として一覧から消す（行は残す）
// - 1バッチの大半が欠けたときは API 側の異常とみなし、消失判定を見送る

export interface RefreshStats {
  targets: number;
  updated: number;
  status_changed: Record<string, number>;
  gone_marked: number;
  revived: number;
  gone_skipped_by_guard: number;
}

export type RefreshScope = "active" | "all";

export async function refreshEvents(ctx: Ctx, scope: RefreshScope): Promise<RefreshStats> {
  const stats: RefreshStats = { targets: 0, updated: 0, status_changed: {}, gone_marked: 0, revived: 0, gone_skipped_by_guard: 0 };
  if (!ctx.yt) return stats;
  const { db, crawlCfg } = ctx;

  // active: こまめな巡回（crawl:hourly。今は流さない）。予定枠と配信中の枠だけ
  // all:    日次。消失済みも含めて全件（一時的に非公開だった枠の復活を拾う）
  const where =
    scope === "active"
      ? "archive_gone_at IS NULL AND status IN ('upcoming', 'live')"
      : "1 = 1";
  const rows = db
    .prepare(`SELECT id, video_id, streamer_id, status, archive_gone_at FROM watch_events WHERE ${where} ORDER BY id`)
    .all() as { id: number; video_id: string; streamer_id: number; status: string; archive_gone_at: string | null }[];
  stats.targets = rows.length;
  const byVideo = new Map(rows.map((r) => [r.video_id, r]));
  const markGone = db.prepare("UPDATE watch_events SET archive_gone_at = COALESCE(archive_gone_at, ?), last_checked_at = ?, updated_at = ? WHERE id = ?");

  for (const ids of chunk([...byVideo.keys()], 50)) {
    const items = await ctx.yt.videos(ids);
    const now = nowIso();
    const returned = new Map(items.map((v) => [v.id, v]));
    const missingRatio = (ids.length - items.length) / ids.length;
    const guard = ids.length >= crawlCfg.refresh.min_batch_for_ratio && missingRatio > crawlCfg.refresh.max_missing_ratio;
    if (guard) log.warn(`videos.list の欠落が多すぎるため消失判定を見送ります (${ids.length - items.length}/${ids.length})`);

    tx(db, () => {
      for (const id of ids) {
        const row = byVideo.get(id)!;
        const v = returned.get(id);
        const c = v ? classifyVideo(v, classifyOptions(ctx)) : null;
        if (!c || c.kind === "unavailable") {
          if (guard) {
            stats.gone_skipped_by_guard++;
            continue;
          }
          if (!row.archive_gone_at) stats.gone_marked++;
          markGone.run(now, now, now, row.id);
          continue;
        }
        if (c.kind !== "event") continue; // ライブでなくなることは通常ない。既存値を保つ
        if (row.archive_gone_at) stats.revived++;
        if (row.status !== c.status) {
          const k = `${row.status}->${c.status}`;
          stats.status_changed[k] = (stats.status_changed[k] ?? 0) + 1;
        }
        upsertEvent(ctx, id, row.streamer_id, c, null, now);
        stats.updated++;
      }
    });
  }
  return stats;
}
