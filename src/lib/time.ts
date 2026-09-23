/** 現在時刻（ISO 8601, UTC） */
export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * YouTube Data API のクォータ日（太平洋時間の日付）。
 * クォータは太平洋時間の0時にリセットされるため、使用量はこの日付で集計する。
 */
export function quotaDay(d: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

export function hoursAgo(iso: string | null, now: Date = new Date()): number {
  if (!iso) return Number.POSITIVE_INFINITY;
  return (now.getTime() - Date.parse(iso)) / 3_600_000;
}
