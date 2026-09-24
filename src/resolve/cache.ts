import type { DB } from "../lib/db.ts";
import { nowIso } from "../lib/time.ts";

// 外部作品DBへの照会結果のキャッシュ（resolve_cache テーブル）。
// 抽出ルールを直して何度も再処理する前提なので、同じ照会を繰り返さない。

export class ResolveCache {
  private readonly db: DB;
  private readonly ttlMs: number;
  hits = 0;
  misses = 0;

  constructor(db: DB, ttlDays: number) {
    this.db = db;
    this.ttlMs = ttlDays * 86_400_000;
  }

  get<T>(source: string, query: string): T | undefined {
    const row = this.db.prepare("SELECT response, fetched_at FROM resolve_cache WHERE source = ? AND query = ?").get(source, query) as
      | { response: string; fetched_at: string }
      | undefined;
    if (!row || Date.now() - Date.parse(row.fetched_at) > this.ttlMs) {
      this.misses++;
      return undefined;
    }
    this.hits++;
    return JSON.parse(row.response) as T;
  }

  set(source: string, query: string, value: unknown): void {
    this.db
      .prepare(`INSERT INTO resolve_cache (source, query, response, fetched_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(source, query) DO UPDATE SET response = excluded.response, fetched_at = excluded.fetched_at`)
      .run(source, query, JSON.stringify(value), nowIso());
  }
}
