import type { DB } from "./db.ts";
import type { CrawlConfig } from "./config.ts";
import { nowIso, quotaDay } from "./time.ts";

// YouTube Data API のクォータ管理。
// 呼び出しの前に残量を確かめ、呼んだら quota_usage に1行記録する。

export const QUOTA_COST: Record<string, number> = {
  "videos.list": 1,
  "playlistItems.list": 1,
  "channels.list": 1,
  "playlists.list": 1,
  "commentThreads.list": 1,
  "search.list": 100,
};

export class QuotaExhausted extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "QuotaExhausted";
  }
}

/** AI の判定の取り分（quota.ai_reserve）を残して止めるジョブ（定期実行のジョブ）。人が起動する ai:queue などは stop_at まで使う */
const RESERVE_JOBS = new Set(["hourly", "daily"]);

export class Quota {
  private usedThisRun = 0;
  private readonly db: DB;
  private readonly cfg: CrawlConfig["quota"];
  private readonly runId: string;
  private readonly job: string;
  private readonly runLimit: number;
  /** 1日の使用量がこれに達したら止める。定期実行のジョブは stop_at から AI の判定の取り分を引いた値 */
  private readonly stopAt: number;

  constructor(db: DB, cfg: CrawlConfig["quota"], runId: string, job: string) {
    this.db = db;
    this.cfg = cfg;
    this.runId = runId;
    this.job = job;
    this.runLimit = cfg.per_run[job] ?? cfg.per_run["daily"] ?? cfg.stop_at;
    this.stopAt = cfg.stop_at - (RESERVE_JOBS.has(job) ? cfg.ai_reserve ?? 0 : 0);
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
    return Math.max(0, Math.min(this.stopAt - this.usedToday(), this.runLimit - this.usedThisRun));
  }

  /** 呼び出し前に確認する。足りなければ QuotaExhausted を投げる */
  reserve(endpoint: string): void {
    const cost = QUOTA_COST[endpoint] ?? 1;
    if (this.usedThisRun + cost > this.runLimit) {
      throw new QuotaExhausted(`per-run limit ${this.runLimit} reached (job=${this.job})`);
    }
    const today = this.usedToday();
    if (today + cost > this.stopAt) {
      const why = this.stopAt === this.cfg.stop_at ? "" : ` = stop_at ${this.cfg.stop_at} - ai_reserve ${this.cfg.ai_reserve}`;
      throw new QuotaExhausted(`daily stop ${this.stopAt}${why} reached (used today=${today}, job=${this.job})`);
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
