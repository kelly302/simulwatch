import type { Ctx } from "../lib/context.ts";
import { runStep } from "../lib/context.ts";
import type { Candidate } from "./ingest.ts";
import { judgeCandidates, fetchAndUpsert, orphanHits, emptyStats, emptyUpsertStats } from "./ingest.ts";
import type { PendingHit } from "./ingest.ts";
import { collectRss, collectPlaylistHeads, collectMembersPlaylists, collectBackfill } from "./sources.ts";
import { refreshEvents } from "./refresh.ts";

// 巡回ジョブ。各ステップは独立して失敗できる（1ステップが落ちても次へ進む）。
// 定期実行は日次だけ（2026-10-27 の決定 D-01。crawl:daily → refresh）。crawl:hourly は流さないが、2時間ごとに戻すときのために残す（docs/workflows.md の付録）
//
// こまめな巡回 crawl:hourly（今は流さない）
//   1. RSS で投稿済み動画の差分（クォータ0）
//   2. playlistItems を一部のチャンネルずつ（予定枠の検知を API で担保する）
//   3. 判定 → ヒットだけ videos.list で詳細 → WatchEvent
//   4. 予定枠・配信中の枠の状態を videos.list で取り直す
//
// 日次 crawl:daily
//   1. 全チャンネルの uploads 先頭ページ（RSS の取りこぼし回収）
//   2. メン限プレイリスト
//   3. 判定 → 詳細 → WatchEvent
//   4. 過去分の遡り（予算内）
//
// 日次 refresh
//   全 WatchEvent の再生数・状態の取り直しとアーカイブ死活チェック

async function judgeAndUpsert(ctx: Ctx, cands: Candidate[], label: string): Promise<void> {
  const stats = emptyStats();
  const up = emptyUpsertStats();
  let pending = new Map<string, PendingHit>();
  await runStep(ctx, `${label}: detect`, async () => {
    pending = judgeCandidates(ctx, cands, stats);
  });
  await runStep(ctx, `${label}: videos.list → WatchEvent`, async () => fetchAndUpsert(ctx, pending, up));
  ctx.summary[`${label}_detect`] = stats;
  ctx.summary[`${label}_upsert`] = up;
}

export async function crawlHourly(ctx: Ctx): Promise<void> {
  const cands: Candidate[] = [];
  const rss = await runStep(ctx, "rss", () => collectRss(ctx, cands));
  ctx.summary.rss = rss && { ...rss, failures: rss.failures.slice(0, 10) };
  const pl = await runStep(ctx, "playlist (rotate)", () => collectPlaylistHeads(ctx, cands, "rotate"));
  ctx.summary.playlist_rotate = pl && { ...pl, failures: pl.failures.slice(0, 10) };
  await judgeAndUpsert(ctx, cands, "hourly");
  ctx.summary.refresh_active = await runStep(ctx, "refresh upcoming/live", () => refreshEvents(ctx, "active"));
}

export async function crawlDaily(ctx: Ctx): Promise<void> {
  const cands: Candidate[] = [];
  const pl = await runStep(ctx, "playlist (all channels)", () => collectPlaylistHeads(ctx, cands, "all"));
  ctx.summary.playlist_all = pl && { ...pl, failures: pl.failures.slice(0, 10) };
  const mem = await runStep(ctx, "members playlist", () => collectMembersPlaylists(ctx, cands));
  ctx.summary.members_playlist = mem && { ...mem, failures: mem.failures.slice(0, 10) };
  await judgeAndUpsert(ctx, cands, "daily");

  // 前回までに詳細を取り損ねたヒットを拾い直す
  const orphanUp = emptyUpsertStats();
  await runStep(ctx, "orphan hits → WatchEvent", () => fetchAndUpsert(ctx, orphanHits(ctx), orphanUp));
  ctx.summary.orphan_upsert = orphanUp;

  // 遡りはページごとに判定し、ヒットだけを溜める
  const bfStats = emptyStats();
  const bfUp = emptyUpsertStats();
  const bfPending = new Map<string, PendingHit>();
  ctx.summary.backfill = await runStep(ctx, "backfill", () =>
    collectBackfill(ctx, (page) => {
      for (const [k, v] of judgeCandidates(ctx, page, bfStats)) bfPending.set(k, v);
    }),
  );
  await runStep(ctx, "backfill: videos.list → WatchEvent", () => fetchAndUpsert(ctx, bfPending, bfUp));
  ctx.summary.backfill_detect = bfStats;
  ctx.summary.backfill_upsert = bfUp;
}

/** 判定ではヒットしたが WatchEvent が無い動画の詳細を取る（語彙を変えて detect:rerun したあとに使う） */
export async function fetchOrphans(ctx: Ctx): Promise<void> {
  const up = emptyUpsertStats();
  await runStep(ctx, "orphan hits → WatchEvent", () => fetchAndUpsert(ctx, orphanHits(ctx), up));
  ctx.summary.orphan_upsert = up;
}

export async function refreshAll(ctx: Ctx, videoIds?: string[]): Promise<void> {
  if (videoIds) ctx.summary.refresh_videos = await runStep(ctx, `refresh ${videoIds.length} videos`, () => refreshEvents(ctx, "all", videoIds));
  else ctx.summary.refresh_all = await runStep(ctx, "refresh all events", () => refreshEvents(ctx, "all"));
}
