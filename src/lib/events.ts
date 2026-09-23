// 名寄せ・集計・公開の対象になる「有効な枠」の条件。1か所にまとめて、各処理で同じ条件を使う。
//
// 除くもの
//   - アーカイブが見られなくなった枠（archive_gone_at）
//   - 判定ルールの変更で同時視聴枠でなくなった枠（excluded_at）
//   - 開始が max_days_ahead 日以上先の予定枠（予定表代わりの枠）。日付が近づけば対象に戻る

/** 予定枠の除外の境目（ISO 8601）。これ以降に始まる予定枠は対象外 */
export function farFutureCutoff(maxDaysAhead: number, now: Date = new Date()): string {
  return new Date(now.getTime() + maxDaysAhead * 86_400_000).toISOString();
}

/**
 * 有効な枠の WHERE 句。alias は watch_events の別名。
 * 1つ目のプレースホルダに farFutureCutoff() の値を渡す。
 */
export function activeEventSql(alias = "e"): string {
  return `(${alias}.archive_gone_at IS NULL AND ${alias}.excluded_at IS NULL
    AND NOT (${alias}.status = 'upcoming' AND COALESCE(${alias}.scheduled_start_at, ${alias}.started_at) >= ?))`;
}

export function isFarFutureUpcoming(
  ev: { status: string; scheduled_start_at: string | null; started_at: string | null },
  cutoff: string,
): boolean {
  const t = ev.scheduled_start_at ?? ev.started_at;
  return ev.status === "upcoming" && t !== null && t >= cutoff;
}
