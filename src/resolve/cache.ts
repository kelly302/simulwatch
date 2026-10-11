import type { DB } from "../lib/db.ts";
import { nowIso } from "../lib/time.ts";

// 外部作品DBへの照会結果のキャッシュ（resolve_cache テーブル）。
// 抽出ルールを直して何度も再処理する前提なので、同じ照会を繰り返さない。
//
// 期限（2026-10-11 決定）:
// - 新しい枠の照会は ttlDays（30日）で切れる。外部DBの更新（新しい作品の登録・記事の新設）を拾うため
// - ルールを直したあとのやり直し（resolve --all など）と、毎回 DB 全体で付け直す型分けは、期限切れの結果も使う（stale）。
//   期限で全部が切れると、やり直しのたびに全部を聞き直すことになる（見積もり約5時間）
// - stale でも freshSources の照会は期限どおりに取り直す（Annict のシリーズの一覧・話の一覧。新しい期・新しい話が足されるため）

/** 期限切れを使うときも、期限どおりに取り直す照会（新しい期・新しい話が足される一覧） */
export const ALWAYS_FRESH = ["annict_series", "annict_series_name", "annict_episodes"];

export class ResolveCache {
  private readonly db: DB;
  private readonly ttlMs: number;
  private readonly stale: boolean;
  private readonly fresh: Set<string>;
  hits = 0;
  misses = 0;
  /** hits のうち、期限切れの結果を使った回数 */
  staleHits = 0;

  constructor(db: DB, ttlDays: number, opts: { stale?: boolean; freshSources?: string[] } = {}) {
    this.db = db;
    this.ttlMs = ttlDays * 86_400_000;
    this.stale = opts.stale ?? false;
    this.fresh = new Set(opts.freshSources ?? ALWAYS_FRESH);
  }

  get<T>(source: string, query: string): T | undefined {
    const row = this.db.prepare("SELECT response, fetched_at FROM resolve_cache WHERE source = ? AND query = ?").get(source, query) as
      | { response: string; fetched_at: string }
      | undefined;
    const expired = !!row && Date.now() - Date.parse(row.fetched_at) > this.ttlMs;
    if (!row || (expired && !(this.stale && !this.fresh.has(source)))) {
      this.misses++;
      return undefined;
    }
    this.hits++;
    if (expired) this.staleHits++;
    return JSON.parse(row.response) as T;
  }

  set(source: string, query: string, value: unknown): void {
    this.db
      .prepare(`INSERT INTO resolve_cache (source, query, response, fetched_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(source, query) DO UPDATE SET response = excluded.response, fetched_at = excluded.fetched_at`)
      .run(source, query, JSON.stringify(value), nowIso());
  }
}
