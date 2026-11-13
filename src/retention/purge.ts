import type { DB } from "../lib/db.ts";
import { tx } from "../lib/db.ts";
import { CLEAR_DETAIL_SQL } from "../candidates/store.ts";

// 30日の決まり（YouTube の API の規約 III.E.4。決定 D-12）で、取り直さないものの中身を消す。API を使わない。
//
// - candidates: 終わった候補（unavailable・detected・framed・not_watchalong）の詳細（題名・概要欄・サムネの URL・再生数）を、詳細を取ってから act_after_days を過ぎたら消す。
//   unavailable は日数を待たない（動画が見られない。取れなくなったときに candidates:fetch が消すので、ここは前からあるものの片づけ）。
//   判定に回す候補（ready・hold）は消さずに candidates:fetch が取り直す。選んだだけ（selected）・予定と配信中（waiting）は詳細が無いか毎日取り直す。
//   枠を作った・語で枠になった候補の中身は watch_events にあり、日次の refresh が取り直す。取り消しで ready に戻った候補は candidates:fetch が詳細を取り直す
// - watch_events: アーカイブが消えて（archive_gone_at）act_after_days を過ぎた枠の題名（空文字。列は NOT NULL）・概要欄・サムネの URL・再生数を消し、purged_at を立てる。
//   行・判定（ai_decisions・unresolved）・作品の結び付き（event_works）は残す。消えた枠も refresh が毎日見に行き、見られるようになったら upsertEvent が中身を入れ直す
//   （題名を消す前の最後の取り直しは archive_gone_at より前なので、中身の古さは archive_gone_at からの日数より少し長い。余白の5日で吸収する）

export interface CandidateClearStats {
  /** 詳細を消した候補（状態ごと） */
  cleared: Record<string, number>;
}

/** 終わった候補の詳細を消す。before は act_after_days の境目（ISO） */
export function clearCandidates(db: DB, before: string, now: string = new Date().toISOString()): CandidateClearStats {
  const s: CandidateClearStats = { cleared: {} };
  const rows = db.prepare(`SELECT state, COUNT(*) AS n FROM candidates
    WHERE state IN ('unavailable', 'detected', 'framed', 'not_watchalong')
      AND (title_raw IS NOT NULL OR description_raw IS NOT NULL OR thumbnail_url IS NOT NULL OR view_count IS NOT NULL)
      AND (state = 'unavailable' OR fetched_at IS NULL OR fetched_at < ?)
    GROUP BY state`).all(before) as { state: string; n: number }[];
  if (!rows.length) return s;
  tx(db, () => {
    db.prepare(`UPDATE candidates SET ${CLEAR_DETAIL_SQL}, cleared_at = ?
      WHERE state IN ('unavailable', 'detected', 'framed', 'not_watchalong')
        AND (title_raw IS NOT NULL OR description_raw IS NOT NULL OR thumbnail_url IS NOT NULL OR view_count IS NOT NULL)
        AND (state = 'unavailable' OR fetched_at IS NULL OR fetched_at < ?)`).run(now, before);
  });
  for (const r of rows) s.cleared[r.state] = r.n;
  return s;
}

export interface EventPurgeStats {
  /** アーカイブが消えた枠（中身を消したものを含む） */
  gone: number;
  /** この回に中身を消した枠 */
  purged: number;
  /** 前に中身を消した枠（まだ消えたまま） */
  already: number;
}

/** アーカイブが消えて日数がたった枠の中身を消す。before は act_after_days の境目（ISO） */
export function purgeGoneEvents(db: DB, before: string, now: string = new Date().toISOString()): EventPurgeStats {
  const gone = (db.prepare("SELECT COUNT(*) AS n FROM watch_events WHERE archive_gone_at IS NOT NULL").get() as { n: number }).n;
  const already = (db.prepare("SELECT COUNT(*) AS n FROM watch_events WHERE archive_gone_at IS NOT NULL AND purged_at IS NOT NULL").get() as { n: number }).n;
  const purged = tx(db, () => Number(db.prepare(`UPDATE watch_events SET title_raw = '', description_raw = NULL, thumbnail_url = NULL,
      view_count = NULL, view_count_fetched_at = NULL, purged_at = ?, updated_at = ?
    WHERE archive_gone_at IS NOT NULL AND archive_gone_at < ? AND purged_at IS NULL`).run(now, now, before).changes));
  return { gone, purged, already };
}
