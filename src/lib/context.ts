import { randomBytes } from "node:crypto";
import type { DB } from "./db.ts";
import { openDb, checkpoint } from "./db.ts";
import { Http } from "./http.ts";
import { RawLog } from "./rawlog.ts";
import { Quota } from "./quota.ts";
import { loadCrawlConfig, loadDetectConfig, loadRosterConfig } from "./config.ts";
import type { CrawlConfig, DetectConfig, RosterConfig } from "./config.ts";
import { YouTubeApi } from "../youtube/api.ts";
import { log, errorMessage } from "./log.ts";
import { nowIso } from "./time.ts";

// ジョブ1回ぶんの実行コンテキスト。
// ステップは runStep で包み、1ステップが失敗しても次のステップへ進む（壊れる前提）。

export interface Ctx {
  db: DB;
  http: Http;
  raw: RawLog;
  quota: Quota;
  /** YOUTUBE_API_KEY が無いときは null。API を使うステップは飛ばす */
  yt: YouTubeApi | null;
  detectCfg: DetectConfig;
  crawlCfg: CrawlConfig;
  rosterCfg: RosterConfig;
  runId: string;
  job: string;
  summary: Record<string, unknown>;
  errors: { step: string; error: string }[];
}

export function createCtx(job: string): Ctx {
  const runId = `${nowIso().replace(/[:.]/g, "-")}-${job}-${randomBytes(2).toString("hex")}`;
  const db = openDb();
  const crawlCfg = loadCrawlConfig();
  const raw = new RawLog(runId);
  const http = new Http(crawlCfg.http, raw);
  const quota = new Quota(db, crawlCfg.quota, runId, job);
  const key = process.env.YOUTUBE_API_KEY;
  const yt = key ? new YouTubeApi(http, quota, key) : null;
  if (!yt) log.warn("YOUTUBE_API_KEY が未設定のため、YouTube Data API を使うステップは飛ばします");
  // 前のジョブがプロセスごと止まった（セッション切れ・強制終了）と、実行記録が running のまま残る。6時間を過ぎたものは中断として閉じる
  db.prepare("UPDATE runs SET status = 'aborted', finished_at = ? WHERE status = 'running' AND started_at < ?")
    .run(nowIso(), new Date(Date.now() - 6 * 3_600_000).toISOString());
  db.prepare("INSERT INTO runs (id, job, started_at, status) VALUES (?, ?, ?, 'running')").run(runId, job, nowIso());
  return {
    db, http, raw, quota, yt,
    detectCfg: loadDetectConfig(),
    crawlCfg,
    rosterCfg: loadRosterConfig(),
    runId, job,
    summary: {},
    errors: [],
  };
}

/** 1ステップを実行する。例外は記録して握りつぶし、false を返す */
export async function runStep<T>(ctx: Ctx, step: string, fn: () => Promise<T>): Promise<T | undefined> {
  const started = Date.now();
  log.info(`▶ ${step}`);
  try {
    const r = await fn();
    log.info(`✔ ${step} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
    return r;
  } catch (e) {
    ctx.errors.push({ step, error: errorMessage(e) });
    log.error(`✖ ${step}`, e);
    return undefined;
  }
}

/**
 * ジョブの後始末。生レスポンスの保存に失敗しても、実行記録・DB の書き戻し・クローズは必ず行う。
 */
export function finishCtx(ctx: Ctx): { status: string; rawPath: string | null } {
  let rawPath: string | null = null;
  try {
    rawPath = ctx.raw.flush();
  } catch (e) {
    ctx.errors.push({ step: "raw log", error: errorMessage(e) });
    log.error("生レスポンスの保存に失敗しました", e);
  }
  const status = ctx.errors.length === 0 ? "ok" : "partial";
  const summary = {
    ...ctx.summary,
    quota: { run_units: ctx.quota.runUsed, today_units: ctx.quota.usedToday() },
    raw_responses: ctx.raw.size,
    raw_path: rawPath,
    errors: ctx.errors,
  };
  try {
    ctx.db
      .prepare("UPDATE runs SET finished_at = ?, status = ?, summary = ? WHERE id = ?")
      .run(nowIso(), status, JSON.stringify(summary), ctx.runId);
  } finally {
    checkpoint(ctx.db);
    ctx.db.close();
  }
  log.info(`run ${ctx.runId} ${status}`, summary);
  return { status, rawPath };
}
