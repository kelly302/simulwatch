import type { DB } from "../lib/db.ts";
import { tx } from "../lib/db.ts";
import type { DetectConfig } from "../lib/config.ts";
import type { YouTubeApi } from "../youtube/api.ts";
import { chunk } from "../youtube/api.ts";
import { classifyVideo } from "../crawl/classify.ts";
import { isMembersTitle } from "../detect/detect.ts";
import type { ExtractConfig } from "../resolve/config.ts";
import { nowIso } from "../lib/time.ts";
import { log } from "../lib/log.ts";
import { selectCandidates, loadSelectInput, loadCandidatesConfig, summarize } from "./select.ts";
import type { Candidate } from "./select.ts";
import type { EventRow } from "../resolve/routing.ts";

// 続きの回の候補の表（candidates。マイグレーション 12）への保存と詳細の取得。docs/ai-ops.md 3-1・3-2、決定 D-04。
//   candidates:select  候補を選んで表に入れる（日次のジョブの手順 6。API を使わない）
//   candidates:fetch   選んだ候補と予定・配信中の候補の詳細を videos.list で取る（同じ手順 6。50本で1ユニット）
// 行は消さない。同じ動画は1回だけ候補にする（2回目からは理由と種の枠を新しくするだけ）

/** 答える前の状態（選び直しで理由と種の枠を新しくする） */
const BEFORE_ANSWER = ["selected", "waiting", "ready"];

export interface SaveStats {
  selected: number;
  inserted: number;
  /** 答える前の候補の理由と種の枠を新しくした */
  updated: number;
  /** 答えた・取れなかった候補（最後に選んだ時刻だけ新しくした） */
  touched: number;
  /** 同時視聴の語で枠になったので判定に回さなくした */
  detected: number;
}

/** 選んだ候補を表に入れる（純粋に DB だけ。並びは selectCandidates のまま） */
export function saveCandidates(db: DB, list: Candidate[], now: string = nowIso()): SaveStats {
  const s: SaveStats = { selected: list.length, inserted: 0, updated: 0, touched: 0, detected: 0 };
  const get = db.prepare("SELECT state FROM candidates WHERE video_id = ?");
  const ins = db.prepare(`INSERT INTO candidates (video_id, streamer_id, state, state_at, reasons, seeds, selected_at, last_selected_at, is_members_only)
    VALUES (?, ?, 'selected', ?, ?, ?, ?, ?, ?)`);
  const upd = db.prepare(`UPDATE candidates SET reasons = ?, seeds = ?, last_selected_at = ?, is_members_only = MAX(is_members_only, ?) WHERE video_id = ?`);
  const touch = db.prepare("UPDATE candidates SET last_selected_at = ?, is_members_only = MAX(is_members_only, ?) WHERE video_id = ?");
  tx(db, () => {
    for (const c of list) {
      const row = get.get(c.videoId) as { state: string } | undefined;
      const reasons = JSON.stringify(c.reasons);
      const seeds = JSON.stringify(c.hits);
      const m = c.members ? 1 : 0;
      if (!row) {
        ins.run(c.videoId, c.streamerId, now, reasons, seeds, now, now, m);
        s.inserted++;
      } else if (BEFORE_ANSWER.includes(row.state)) {
        upd.run(reasons, seeds, now, m, c.videoId);
        s.updated++;
      } else {
        touch.run(now, m, c.videoId);
        s.touched++;
      }
    }
    // 題名が変わって同時視聴の語に当たり、巡回が枠にした候補は判定に回さない（答えは枠の判定として入れる）
    s.detected = Number(db.prepare(`UPDATE candidates SET state = 'detected', state_at = ?,
        watch_event_id = (SELECT e.id FROM watch_events e WHERE e.video_id = candidates.video_id)
      WHERE state IN ('selected', 'waiting', 'ready', 'hold')
        AND EXISTS (SELECT 1 FROM watch_events e WHERE e.video_id = candidates.video_id AND e.excluded_at IS NULL AND e.detect_source != 'ai_candidate')`)
      .run(now).changes);
  });
  return s;
}

/** candidates:select。選んで表に入れ、件数のまとめを返す */
export function candidatesSelect(db: DB, cfg: ExtractConfig, maxDaysAhead: number, now: Date = new Date()): { stats: SaveStats; text: string } {
  const list = selectCandidates(loadSelectInput(db, cfg, maxDaysAhead, now), cfg, loadCandidatesConfig());
  const stats = saveCandidates(db, list, now.toISOString());
  const states = db.prepare("SELECT state, COUNT(*) AS n FROM candidates GROUP BY state ORDER BY state").all() as { state: string; n: number }[];
  const text = [
    ...summarize(list),
    `表: 新しく入れた ${stats.inserted}・理由と種の枠を新しくした ${stats.updated}・答え済みなど ${stats.touched}・同時視聴の語で枠になった ${stats.detected}`,
    `表の状態: ${states.map((r) => `${r.state} ${r.n}`).join("・")}`,
  ].join("\n");
  return { stats, text };
}

export interface FetchStats {
  targets: number;
  /** 対象のうち、判定に回す候補（ready・hold）の取り直し（30日の決まり。D-12） */
  refetched: number;
  requested: number;
  /** 終わった（判定に回す） */
  ready: number;
  /** 保留のまま詳細を取り直した */
  hold: number;
  /** 予定・配信中（次の日にもう一度取る） */
  waiting: number;
  /** 非公開・限定公開・ライブでない */
  unavailable: number;
  /** videos.list が返さなかった（削除など） */
  missing: number;
}

export interface FetchCtx {
  db: DB;
  yt: Pick<YouTubeApi, "videos"> | null;
  detectCfg: DetectConfig;
}

/** 詳細の列（videos.list から写した YouTube のデータ）のうち、終わった候補で消すもの（30日の決まり。D-12。src/retention/purge.ts と同じ） */
export const CLEAR_DETAIL_SQL = "title_raw = NULL, description_raw = NULL, thumbnail_url = NULL, view_count = NULL, view_count_fetched_at = NULL";

/**
 * candidates:fetch。詳細がまだの候補（selected）と予定・配信中だった候補（waiting）の videos.list を引き、watch_events と同じ列に入れる。
 * 終わった動画だけを判定に回す（ready）。50本ごとに書くので、途中でクォータが尽きても取れたぶんは残る（残りは次の日）。
 * refetchBefore を渡すと、判定に回す候補（ready・hold）のうち、詳細をその時刻より前に取った・詳細が無い（取り消しで ready に戻った候補）ものも取り直す
 * （30日の決まり。D-12。状態はそのまま。取れなければ unavailable）。取れない候補（unavailable）は詳細を消す
 */
export async function fetchCandidates(ctx: FetchCtx, opts: { limit?: number; refetchBefore?: string } = {}): Promise<FetchStats> {
  const { db } = ctx;
  const stale = opts.refetchBefore
    ? " OR (state IN ('ready', 'hold') AND (title_raw IS NULL OR fetched_at IS NULL OR fetched_at < ?))"
    : "";
  const targets = db.prepare(`SELECT video_id, state FROM candidates WHERE state IN ('selected', 'waiting')${stale} ORDER BY id${opts.limit ? " LIMIT ?" : ""}`)
    .all(...(opts.refetchBefore ? [opts.refetchBefore] : []), ...(opts.limit ? [opts.limit] : [])) as { video_id: string; state: string }[];
  const ids = targets.map((r) => r.video_id);
  const prior = new Map(targets.map((r) => [r.video_id, r.state]));
  const s: FetchStats = {
    targets: ids.length, refetched: targets.filter((r) => r.state === "ready" || r.state === "hold").length,
    requested: 0, ready: 0, hold: 0, waiting: 0, unavailable: 0, missing: 0,
  };
  if (!ids.length) return s;
  if (!ctx.yt) {
    log.warn(`APIキーが無いため候補 ${ids.length} 本の詳細取得を保留します（次の日に取る）`);
    return s;
  }
  const hint = db.prepare("SELECT is_members_hint FROM videos_seen WHERE video_id = ?");
  // state_at は状態が変わったときだけ新しくする（判定に回す候補の取り直しで状態がそのままなら前の時刻を残す）
  const setDetail = db.prepare(`UPDATE candidates SET state_at = CASE WHEN ? = 1 THEN state_at ELSE ? END, state = ?,
      title_raw = ?, description_raw = ?, thumbnail_url = ?, started_at = ?, started_at_source = ?, scheduled_start_at = ?, ended_at = ?, status = ?,
      is_members_only = MAX(is_members_only, ?), view_count = ?, view_count_fetched_at = ?, fetched_at = ?, fetch_note = NULL
    WHERE video_id = ?`);
  // 取れない（削除・非公開・ライブでない）。前に取った詳細があれば消す（もう判定に回さない。D-12）
  const setGone = db.prepare(`UPDATE candidates SET state = 'unavailable', state_at = ?, fetched_at = ?, fetch_note = ?,
      cleared_at = CASE WHEN title_raw IS NOT NULL OR description_raw IS NOT NULL OR thumbnail_url IS NOT NULL OR view_count IS NOT NULL THEN ? ELSE cleared_at END,
      ${CLEAR_DETAIL_SQL}
    WHERE video_id = ?`);
  const opt = { allowNonLive: !ctx.detectCfg.reject.require_live };
  for (const part of chunk(ids, 50)) {
    s.requested += part.length;
    const items = await ctx.yt.videos(part);
    const now = nowIso();
    const returned = new Set(items.map((v) => v.id));
    tx(db, () => {
      for (const v of items) {
        const c = classifyVideo(v, opt);
        if (c.kind === "not_live") {
          setGone.run(now, now, "not_live", now, v.id);
          s.unavailable++;
          continue;
        }
        if (c.kind === "unavailable") {
          setGone.run(now, now, c.reason, now, v.id);
          s.unavailable++;
          continue;
        }
        // メン限の印: 候補の表の値（選んだときの videos_seen の is_members_hint）・今の is_members_hint・題名のメン限の語（巡回の upsertEvent と同じ）
        const h = (hint.get(v.id) as { is_members_hint: number } | undefined)?.is_members_hint === 1;
        const members = h || isMembersTitle(c.title, ctx.detectCfg) ? 1 : 0;
        // 判定に回す候補（ready・hold）の取り直しは状態をそのままにする（hold を ready に戻さない）
        const was = prior.get(v.id);
        const state = c.status !== "completed" ? "waiting" : was === "hold" ? "hold" : "ready";
        const keep = (was === "ready" || was === "hold") && was === state ? 1 : 0;
        setDetail.run(keep, now, state,
          c.title, c.description, c.thumbnail_url, c.started_at, c.started_at_source, c.scheduled_start_at, c.ended_at, c.status,
          members, c.view_count, c.view_count === null ? null : now, now, v.id);
        s[state]++;
      }
      for (const id of part) {
        if (returned.has(id)) continue;
        setGone.run(now, now, "missing_in_videos_list", now, id);
        s.missing++;
      }
    });
  }
  return s;
}

/** 待ち行列に入れる候補（判定役には候補であることと種の枠を見せ、層は見せない。docs/ai-ops.md 3-3） */
export interface CandidateQueueRow {
  /** watch_events の行の形（枠はまだ無いので id は負の数 = -candidates.id） */
  ev: EventRow;
  rule: null;
  candidate: {
    /** 候補の理由（層）。sealed/ にだけ残し、判定役には見せない */
    reasons: string[];
    /** 候補にした同時視聴の枠（この動画に近い順に最大 5枠を日付順に。日本時間の日付と題名） */
    seeds: { date: string; title: string }[];
  };
}

const SEEDS_SHOWN = 5;
const jstDate = (t: string | null) => (t ? new Date(Date.parse(t) + 9 * 3_600_000).toISOString().slice(0, 10) : "?");

/**
 * 待ち行列の候補。ready（includeHold なら hold も）の候補のうち、一覧に出る枠の無いもの。
 * videos を渡すと、状態に関係なくその動画の候補（終わった動画で、一覧に出る枠の無いもの）を入れる（判定し直し用）
 */
export function candidateQueueRows(db: DB, opts: { includeHold?: boolean; videos?: string[] } = {}): CandidateQueueRow[] {
  const states = opts.includeHold ? ["ready", "hold"] : ["ready"];
  const rows = db.prepare(`SELECT c.id, c.video_id, c.streamer_id, s.name AS streamer, c.state, c.reasons, c.seeds, c.title_raw, c.description_raw,
      c.thumbnail_url, c.started_at, c.started_at_source, c.ended_at, c.is_members_only, vs.is_members_hint
    FROM candidates c JOIN streamers s ON s.id = c.streamer_id LEFT JOIN videos_seen vs ON vs.video_id = c.video_id
    WHERE c.status = 'completed' AND c.title_raw IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM watch_events e WHERE e.video_id = c.video_id AND e.excluded_at IS NULL)
    ORDER BY c.id`).all() as Record<string, string | number | null>[];
  // アーカイブが消えて中身を消した枠（purged_at。D-12）は種の枠として見せない
  const seedOf = db.prepare("SELECT started_at, title_raw FROM watch_events WHERE id = ? AND purged_at IS NULL");
  const out: CandidateQueueRow[] = [];
  for (const r of rows) {
    const vid = String(r.video_id);
    if (opts.videos ? !opts.videos.includes(vid) : !states.includes(String(r.state))) continue;
    const t0 = r.started_at ? Date.parse(String(r.started_at)) : NaN;
    // 弱い語（weak_word）の理由は種の枠を持たない（seed が無い）。種の枠の無い候補は「なし」と見せる
    const ids = [...new Set((JSON.parse(String(r.seeds)) as { seed?: number }[]).flatMap((h) => (typeof h.seed === "number" ? [h.seed] : [])))];
    const seeds = ids.flatMap((id) => {
      const s = seedOf.get(id) as { started_at: string | null; title_raw: string } | undefined;
      return s ? [{ at: s.started_at ? Date.parse(s.started_at) : NaN, date: jstDate(s.started_at), title: s.title_raw }] : [];
    });
    const dist = (x: { at: number }) => (Number.isNaN(x.at) || Number.isNaN(t0) ? Infinity : Math.abs(x.at - t0));
    const near = seeds.sort((a, b) => dist(a) - dist(b) || a.at - b.at).slice(0, SEEDS_SHOWN).sort((a, b) => a.at - b.at);
    out.push({
      ev: {
        id: -Number(r.id), video_id: vid, title_raw: String(r.title_raw), description_raw: r.description_raw as string | null,
        started_at: r.started_at as string | null, streamer_id: Number(r.streamer_id), thumbnail_url: r.thumbnail_url as string | null,
        streamer: String(r.streamer), is_members_only: Number(r.is_members_only) === 1 || Number(r.is_members_hint) === 1 ? 1 : 0,
        started_at_source: r.started_at_source as string | null, ended_at: r.ended_at as string | null,
      },
      rule: null,
      candidate: { reasons: JSON.parse(String(r.reasons)) as string[], seeds: near.map(({ date, title }) => ({ date, title })) },
    });
  }
  return out;
}
