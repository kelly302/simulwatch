import type { DB } from "../lib/db.ts";
import { tx } from "../lib/db.ts";
import type { CrawlConfig, DetectConfig } from "../lib/config.ts";
import type { YouTubeApi } from "../youtube/api.ts";
import { chunk } from "../youtube/api.ts";
import { detect, descriptionHitLines, isMembersTitle } from "../detect/detect.ts";
import { QuotaExhausted } from "../lib/quota.ts";
import type { Quota } from "../lib/quota.ts";
import { log, errorMessage } from "../lib/log.ts";

// videos_seen（巡回で見た全部の動画。題名を持つ）を30日を超えて持たないための取り直し（YouTube の API の規約 III.E.4。決定 D-12）。
//
// - 日次の retention が、題名を最後に確かめた時刻（refreshed_at）の古いものから videos.list で取り直す。
//   1回の本数は「題名を持つ行 ÷ act_after_days」（ふだん。約25日で一周）と「act_after_days を過ぎた行」の多いほう。上限 videos_seen_max_units（ユニット）。
//   並びは確かめた日（UTC の日付）の古い順、同じ日の中は動画の ID の順（チャンネルが混ざる）。時刻の順だと、遡りで同じ時刻に見た1つのチャンネルの動画が
//   続けて並び（2026-11-13 の写しで最初の750本のうち748本が1チャンネル）、チャンネルごと消えたときにバッチが全部欠けて下の「API の異常」とみなし、いつまでも消せない
// - 巡回（同じ題名を見た）・refresh（同時視聴の枠）も refreshed_at を進めるので、そちらで見た動画は取り直さない
// - 返ってこない・公開でない動画は、題名を消して（空文字。列は NOT NULL）公開日も消し、gone_at を立てる。行と判定の結果は残す。消した行はもう取り直さない
//   （巡回でまた見えたら、題名が変わった動画として判定し直して入れ直す。src/crawl/ingest.ts）。
//   1バッチ（10本以上）の半分超が返ってこなければ API の異常とみなして消さない（refresh と同じ。config/crawl.yaml の refresh）
// - 題名が変わっていたら、巡回（judgeCandidates）と同じく判定し直す。同時視聴の枠がある動画は判定し直さない（巡回も枠は判定し直さず、refresh が枠を取り直す）。
//   判定は題名と概要欄。概要欄の定型文は、この回に取った同じチャンネルの動画の概要欄から作る（巡回はその日の uploads の先頭と同じ並び。数が違うので定型文の見つかり方は少し違う）。
//   新しく当たった動画は 'hit' にし、次の日の巡回（orphan hits）か detect:fetch が枠にする
// - 語彙のバージョンだけが変わった動画は判定し直さない（detect:rerun の仕事。巡回は見たときに判定し直すが、ここは題名の取り直しに限る）

export interface SeenRefreshStats {
  /** 題名を持つ行（消した行を除く） */
  live_rows: number;
  /** act_after_days を過ぎた行（この回の前） */
  due_rows: number;
  /** この回に取り直すと決めた本数 */
  target_rows: number;
  requested: number;
  units: number;
  /** 返ってきて題名を確かめた（変わったものを含む） */
  refreshed: number;
  /** 題名が変わった（同時視聴の枠の動画を含む） */
  title_changed: number;
  /** 題名が変わって判定し直した結果 */
  redetected: { hit: number; miss: number; rejected: number };
  /** 返ってこない・公開でないので題名を消した */
  gone: number;
  gone_skipped_by_guard: number;
  quota_stopped: boolean;
  /** クォータ切れ以外で途中で止まった理由（呼ぶ側がステップの失敗にする） */
  error: string | null;
}

export interface SeenCtx {
  db: DB;
  yt: Pick<YouTubeApi, "videos"> | null;
  quota?: Pick<Quota, "remaining">;
  detectCfg: DetectConfig;
  crawlCfg: Pick<CrawlConfig, "retention" | "refresh">;
}

const DAY = 86_400_000;

/** retention の境目（act_after_days より前に確かめたものは取り直す・消す） */
export function actCutoff(cfg: Pick<CrawlConfig, "retention">, now: Date = new Date()): string {
  return new Date(now.getTime() - cfg.retention.act_after_days * DAY).toISOString();
}

/** 規約の上限の境目（max_age_days より前） */
export function maxAgeCutoff(cfg: Pick<CrawlConfig, "retention">, now: Date = new Date()): string {
  return new Date(now.getTime() - cfg.retention.max_age_days * DAY).toISOString();
}

/** この回に取り直す本数（題名を持つ行 ÷ act_after_days と、境目を過ぎた行の多いほう。上限まで） */
export function seenTarget(db: DB, cfg: Pick<CrawlConfig, "retention">, now: Date, maxUnits: number): { live: number; due: number; target: number } {
  const live = (db.prepare("SELECT COUNT(*) AS n FROM videos_seen WHERE gone_at IS NULL").get() as { n: number }).n;
  const due = (db.prepare("SELECT COUNT(*) AS n FROM videos_seen WHERE gone_at IS NULL AND (refreshed_at IS NULL OR refreshed_at < ?)")
    .get(actCutoff(cfg, now)) as { n: number }).n;
  const spread = Math.ceil(live / Math.max(1, cfg.retention.act_after_days));
  return { live, due, target: Math.min(live, Math.max(spread, due), Math.max(0, maxUnits) * 50) };
}

/** 動画の題名を API で確かめた（同時視聴の枠の動画。判定し直さない）。refresh が使う */
export function confirmSeen(db: DB, videoId: string, title: string, publishedAt: string | null, now: string): void {
  db.prepare("UPDATE videos_seen SET title = ?, published_at = COALESCE(?, published_at), refreshed_at = ?, gone_at = NULL WHERE video_id = ?")
    .run(title, publishedAt, now, videoId);
}

interface Row {
  video_id: string;
  channel_id: string;
  title: string;
  has_event: number;
}

interface Pending {
  row: Row;
  title: string;
  description: string;
  publishedAt: string | null;
}

/**
 * 古いものから取り直す。opts.maxUnits は1回の上限（既定は config の videos_seen_max_units）。
 * クォータが尽きたら止め、取れたぶんは書く（残りは次の日）。途中で別の例外が出ても、取れたぶんの判定し直しを済ませ、理由を error に入れて返す
 */
export async function refreshSeen(ctx: SeenCtx, opts: { maxUnits?: number; now?: Date } = {}): Promise<SeenRefreshStats> {
  const { db, detectCfg, crawlCfg } = ctx;
  const now = opts.now ?? new Date();
  const maxUnits = opts.maxUnits ?? crawlCfg.retention.videos_seen_max_units;
  const plan = seenTarget(db, crawlCfg, now, maxUnits);
  const s: SeenRefreshStats = {
    live_rows: plan.live, due_rows: plan.due, target_rows: 0, requested: 0, units: 0, refreshed: 0, title_changed: 0,
    redetected: { hit: 0, miss: 0, rejected: 0 }, gone: 0, gone_skipped_by_guard: 0, quota_stopped: false, error: null,
  };
  if (!ctx.yt) {
    if (plan.target > 0) log.warn(`APIキーが無いため videos_seen の取り直し（${plan.target} 本）を飛ばします`);
    return s;
  }
  // クォータの残りで決める（定期実行のジョブは AI の判定の取り分を残す。src/lib/quota.ts）
  const room = ctx.quota ? ctx.quota.remaining() * 50 : Infinity;
  s.target_rows = Math.min(plan.target, room);
  if (s.target_rows <= 0) return s;
  const rows = db.prepare(`SELECT v.video_id, v.channel_id, v.title, (e.id IS NOT NULL) AS has_event FROM videos_seen v
      LEFT JOIN watch_events e ON e.video_id = v.video_id
    WHERE v.gone_at IS NULL ORDER BY substr(v.refreshed_at, 1, 10), v.video_id LIMIT ?`).all(s.target_rows) as unknown as Row[];

  const confirm = db.prepare("UPDATE videos_seen SET published_at = COALESCE(?, published_at), refreshed_at = ? WHERE video_id = ?");
  const markGone = db.prepare("UPDATE videos_seen SET title = '', published_at = NULL, gone_at = ? WHERE video_id = ? AND gone_at IS NULL");
  // 定型文を作るための、チャンネルごとの「当たる行」の数（1本の中の重複は1回）
  const lineCount = new Map<string, Map<string, number>>();
  const pending: Pending[] = [];

  for (const part of chunk(rows, 50)) {
    let items;
    try {
      items = await ctx.yt.videos(part.map((r) => r.video_id));
    } catch (e) {
      if (e instanceof QuotaExhausted) s.quota_stopped = true;
      else s.error = errorMessage(e);
      log.warn(`videos_seen の取り直しを止めます（${errorMessage(e)}）。取れたぶんは書きます`);
      break;
    }
    s.requested += part.length;
    s.units++;
    const at = new Date().toISOString();
    const byId = new Map(items.map((v) => [v.id, v]));
    const guard = part.length >= crawlCfg.refresh.min_batch_for_ratio && (part.length - items.length) / part.length > crawlCfg.refresh.max_missing_ratio;
    if (guard) log.warn(`videos.list の欠落が多すぎるため、videos_seen の題名を消しません (${part.length - items.length}/${part.length})`);
    tx(db, () => {
      for (const r of part) {
        const v = byId.get(r.video_id);
        const privacy = v?.status?.privacyStatus;
        if (!v || (privacy && privacy !== "public")) {
          if (guard) { s.gone_skipped_by_guard++; continue; }
          s.gone += Number(markGone.run(at, r.video_id).changes);
          continue;
        }
        const title = v.snippet?.title ?? "";
        const description = v.snippet?.description ?? "";
        const publishedAt = v.snippet?.publishedAt ?? null;
        const lines = lineCount.get(r.channel_id) ?? new Map<string, number>();
        for (const l of descriptionHitLines(description, detectCfg)) lines.set(l, (lines.get(l) ?? 0) + 1);
        lineCount.set(r.channel_id, lines);
        s.refreshed++;
        if (title !== r.title) s.title_changed++;
        if (r.has_event) confirmSeen(db, r.video_id, title, publishedAt, at);
        else if (title === r.title) confirm.run(publishedAt, at, r.video_id);
        else pending.push({ row: r, title, description, publishedAt });
      }
    });
  }

  // 題名が変わった動画を判定し直す（巡回の judgeCandidates と同じ書き方。is_members_hint は題名のメン限の語で上げるだけ）
  const min = detectCfg.description.template_min_repeats;
  const templates = new Map<string, Set<string>>();
  for (const [ch, m] of lineCount) templates.set(ch, new Set(min && min >= 2 ? [...m].filter(([, n]) => n >= min).map(([l]) => l) : []));
  const upd = db.prepare(`UPDATE videos_seen SET title = ?, published_at = COALESCE(?, published_at), refreshed_at = ?, gone_at = NULL,
      detect_result = ?, detect_note = ?, detect_version = ?, is_members_hint = MAX(is_members_hint, ?) WHERE video_id = ?`);
  const at = new Date().toISOString();
  tx(db, () => {
    for (const p of pending) {
      const d = detect({ title: p.title, description: p.description, templateLines: templates.get(p.row.channel_id) }, detectCfg);
      const [result, note] = d.hit ? ["hit", `${d.source}:${d.keyword}`] : d.excludedBy ? ["rejected", `title_exclude:${d.excludedBy}`] : ["miss", null];
      s.redetected[result as "hit" | "miss" | "rejected"]++;
      upd.run(p.title, p.publishedAt, at, result, note, detectCfg.version, isMembersTitle(p.title, detectCfg) ? 1 : 0, p.row.video_id);
    }
  });
  return s;
}
