import type { DB } from "./db.ts";
import type { CrawlConfig } from "./config.ts";
import { nowIso, quotaDay } from "./time.ts";

// YouTube Data API のクォータ管理。
// 呼び出しの前に残量を確かめ、呼んだら quota_usage に1行記録する。

export const QUOTA_COST: Record<string, number> = {
  "videos.list": 1,
  "playlistItems.list": 1,
  "channels.list": 1,
  "search.list": 100,
};

export class QuotaExhausted extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "QuotaExhausted";
  }
}

export class Quota {
  private usedThisRun = 0;
  private readonly db: DB;
  private readonly cfg: CrawlConfig["quota"];
  private readonly runId: string;
  private readonly job: string;
  private readonly runLimit: number;

  constructor(db: DB, cfg: CrawlConfig["quota"], runId: string, job: string) {
    this.db = db;
    this.cfg = cfg;
    this.runId = runId;
    this.job = job;
    this.runLimit = cfg.per_run[job] ?? cfg.per_run["daily"] ?? cfg.stop_at;
  }

  usedToday(): number {
    const r = this.db.prepare("SELECT COALESCE(SUM(units), 0) AS u FROM quota_usage WHERE quota_day = ?").get(quotaDay()) as { u: number };
    return r.u;
  }

  get runUsed(): number {
    return this.usedThisRun;
  }

  /** このジョブであと何ユニット使えるか */
  remaining(): number {
    return Math.max(0, Math.min(this.cfg.stop_at - this.usedToday(), this.runLimit - this.usedThisRun));
  }

  /** 呼び出し前に確認する。足りなければ QuotaExhausted を投げる */
  reserve(endpoint: string): void {
    const cost = QUOTA_COST[endpoint] ?? 1;
    if (this.usedThisRun + cost > this.runLimit) {
      throw new QuotaExhausted(`per-run limit ${this.runLimit} reached (job=${this.job})`);
    }
    const today = this.usedToday();
    if (today + cost > this.cfg.stop_at) {
      throw new QuotaExhausted(`daily stop_at ${this.cfg.stop_at} reached (used today=${today})`);
    }
  }

  record(endpoint: string): void {
    const cost = QUOTA_COST[endpoint] ?? 1;
    this.usedThisRun += cost;
    this.db
      .prepare("INSERT INTO quota_usage (quota_day, at, run_id, job, endpoint, units) VALUES (?, ?, ?, ?, ?, ?)")
      .run(quotaDay(), nowIso(), this.runId, this.job, endpoint, cost);
  }
}
