import type { DB } from "../lib/db.ts";
import type { CrawlConfig } from "../lib/config.ts";
import { actCutoff, maxAgeCutoff, seenTarget } from "./seen.ts";

// retention:status。30日の決まり（D-12）で DB の中に古いものがどれだけ残っているか（API を使わない。DB は読むだけ）

export interface RetentionStatus {
  at: string;
  act_after_days: number;
  max_age_days: number;
  videos_seen: { rows: number; gone: number; live: number; due: number; over: number; next_target: number; next_units: number };
  watch_events: { rows: number; gone: number; purge_due: number; purged: number; stale_checked: number };
  candidates: { state: string; rows: number; with_detail: number; stale_detail: number; over_detail: number; cleared: number }[];
  streamers: { rows: number; inactive: number; meta_unknown: number; meta_due: number; no_icon: number };
}

export function retentionStatus(db: DB, cfg: Pick<CrawlConfig, "retention">, now: Date = new Date()): RetentionStatus {
  const act = actCutoff(cfg, now);
  const over = maxAgeCutoff(cfg, now);
  const one = <T>(sql: string, ...p: (string | number)[]) => db.prepare(sql).get(...p) as T;
  const vs = one<{ rows: number; gone: number; over: number }>(
    "SELECT COUNT(*) AS rows, COALESCE(SUM(gone_at IS NOT NULL), 0) AS gone, COALESCE(SUM(gone_at IS NULL AND (refreshed_at IS NULL OR refreshed_at < ?)), 0) AS over FROM videos_seen", over);
  const plan = seenTarget(db, cfg, now, (cfg.retention.videos_seen_max_units));
  const we = one<{ rows: number; gone: number; purge_due: number; purged: number; stale_checked: number }>(`SELECT COUNT(*) AS rows,
      COALESCE(SUM(archive_gone_at IS NOT NULL), 0) AS gone,
      COALESCE(SUM(archive_gone_at IS NOT NULL AND archive_gone_at < ? AND purged_at IS NULL), 0) AS purge_due,
      COALESCE(SUM(purged_at IS NOT NULL), 0) AS purged,
      COALESCE(SUM(archive_gone_at IS NULL AND (last_checked_at IS NULL OR last_checked_at < ?)), 0) AS stale_checked
    FROM watch_events`, act, act);
  const detail = "(title_raw IS NOT NULL OR description_raw IS NOT NULL OR thumbnail_url IS NOT NULL OR view_count IS NOT NULL)";
  const cands = db.prepare(`SELECT state, COUNT(*) AS rows, COALESCE(SUM(${detail}), 0) AS with_detail,
      COALESCE(SUM(${detail} AND (fetched_at IS NULL OR fetched_at < ?)), 0) AS stale_detail,
      COALESCE(SUM(${detail} AND (fetched_at IS NULL OR fetched_at < ?)), 0) AS over_detail,
      COALESCE(SUM(cleared_at IS NOT NULL), 0) AS cleared
    FROM candidates GROUP BY state ORDER BY state`).all(act, over) as RetentionStatus["candidates"];
  const st = one<RetentionStatus["streamers"]>(`SELECT COUNT(*) AS rows, COALESCE(SUM(is_active = 0), 0) AS inactive,
      COALESCE(SUM(channel_meta_at IS NULL), 0) AS meta_unknown, COALESCE(SUM(channel_meta_at < ?), 0) AS meta_due,
      COALESCE(SUM(icon_url IS NULL), 0) AS no_icon FROM streamers`, act);
  return {
    at: now.toISOString(), act_after_days: cfg.retention.act_after_days, max_age_days: cfg.retention.max_age_days,
    videos_seen: { rows: vs.rows, gone: vs.gone, live: plan.live, due: plan.due, over: vs.over, next_target: plan.target, next_units: Math.ceil(plan.target / 50) },
    watch_events: we, candidates: cands, streamers: st,
  };
}

export function formatRetentionStatus(s: RetentionStatus): string {
  const n = (x: number) => x.toLocaleString("en-US");
  const v = s.videos_seen;
  const w = s.watch_events;
  const lines = [
    `30日の決まり（D-12）: 取り直す・消すのは最後に API で確かめてから ${s.act_after_days}日を過ぎたもの。上限 ${s.max_age_days}日。基準 ${s.at}`,
    `videos_seen: 行 ${n(v.rows)}（題名を消した ${n(v.gone)}）。題名を持つ ${n(v.live)} のうち ${s.act_after_days}日を過ぎた ${n(v.due)}・${s.max_age_days}日を過ぎた ${n(v.over)}。` +
      `次の retention で取り直す ${n(v.next_target)} 本（約 ${n(v.next_units)} ユニット）`,
    `watch_events: 行 ${n(w.rows)}。アーカイブが消えた ${n(w.gone)}（${s.act_after_days}日を過ぎて次の retention で中身を消す ${n(w.purge_due)}・中身を消した ${n(w.purged)}）。` +
      `アーカイブが見られるのに ${s.act_after_days}日以上 refresh で取り直していない ${n(w.stale_checked)}${w.stale_checked ? "（refresh が止まっている。決まりを超える前に直す）" : ""}`,
    `candidates: ${s.candidates.length ? s.candidates.map((c) => `${c.state} ${c.rows}（詳細あり ${c.with_detail}・${s.act_after_days}日を過ぎた ${c.stale_detail}・${s.max_age_days}日を過ぎた ${c.over_detail}・消した ${c.cleared}）`).join("、") : "行なし"}`,
    `streamers: 行 ${s.streamers.rows}（巡回を止めた ${s.streamers.inactive}）。チャンネルの情報を確かめた時刻が無い ${s.streamers.meta_unknown}・${s.act_after_days}日を過ぎた ${s.streamers.meta_due}・アイコンが無い ${s.streamers.no_icon}`,
  ];
  return lines.join("\n");
}
