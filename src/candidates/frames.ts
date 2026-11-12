import type { DB } from "../lib/db.ts";
import { nowIso } from "../lib/time.ts";

// 候補から枠を作る・AI が足した枠を外す（docs/ai-ops.md 3-4。決定 D-04）。
// 答えの取り込み（src/report/ai.ts の aiApply）と取り消し（ai:revoke）から呼ぶ。トランザクションは呼ぶ側が持つ。
//
// - 枠は判定より先に作る（ai_decisions.watch_event_id は NOT NULL）
// - 枠の列は候補の表の詳細（videos.list）をそのまま写す。detect_source = 'ai_candidate'、detect_keyword に候補の理由（層を + でつなぐ）
// - is_members_only は候補の表の値と videos_seen の is_members_hint の大きいほう（渡さないとメン限の続きの回が公開の枠になる）
// - ai_candidate の枠は語彙で判定し直さない（巡回の fetchAndUpsert・detect:rerun）。外すのは ai:revoke だけ（excluded_reason = 'ai_revoked'。行は消さない）

export type FrameResult =
  | {
    ok: true;
    eventId: number;
    /**
     * created: 新しく作った / restored: 取り消しで外した ai_candidate の枠を戻した /
     * adopted: 語彙の変更で外れていた枠（detect_rule）を ai_candidate の枠として戻した / existing: すでに一覧に出る枠がある（変えない）
     */
    how: "created" | "restored" | "adopted" | "existing";
  }
  | { ok: false; why: string };

interface CandRow {
  video_id: string;
  streamer_id: number;
  state: string;
  reasons: string;
  title_raw: string | null;
  description_raw: string | null;
  thumbnail_url: string | null;
  started_at: string | null;
  started_at_source: string | null;
  scheduled_start_at: string | null;
  ended_at: string | null;
  status: string | null;
  is_members_only: number;
  view_count: number | null;
  view_count_fetched_at: string | null;
  fetched_at: string | null;
}

/** 候補の答え（identified / not_in_db / unidentifiable / not_a_work）で枠を作る。作れなければ理由を返す（DB は変えない） */
export function frameFromCandidate(db: DB, videoId: string, now: string = nowIso()): FrameResult {
  const c = db.prepare("SELECT * FROM candidates WHERE video_id = ?").get(videoId) as CandRow | undefined;
  if (!c) return { ok: false, why: "候補に無い" };
  if (c.title_raw === null || c.fetched_at === null) return { ok: false, why: "候補の詳細（videos.list）がまだ無い" };
  if (c.status !== "completed") return { ok: false, why: `候補の動画が終わっていない（${c.status}）` };
  const seen = db.prepare("SELECT first_seen_via, is_members_hint FROM videos_seen WHERE video_id = ?").get(videoId) as
    { first_seen_via: string; is_members_hint: number } | undefined;
  const members = c.is_members_only === 1 || seen?.is_members_hint === 1 ? 1 : 0;
  const keyword = (JSON.parse(c.reasons) as string[]).join("+");
  const ev = db.prepare("SELECT id, detect_source, excluded_at FROM watch_events WHERE video_id = ?").get(videoId) as
    { id: number; detect_source: string; excluded_at: string | null } | undefined;
  let eventId: number;
  let how: "created" | "restored" | "adopted" | "existing";
  if (!ev) {
    const r = db.prepare(`
      INSERT INTO watch_events (streamer_id, video_id, title_raw, description_raw, thumbnail_url, url,
        started_at, started_at_source, scheduled_start_at, ended_at, status, is_members_only, view_count, view_count_fetched_at,
        detected_at, detect_source, detect_keyword, found_via, archive_gone_at, last_checked_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ai_candidate', ?, ?, NULL, ?, ?)`).run(
      c.streamer_id, videoId, c.title_raw, c.description_raw, c.thumbnail_url, `https://www.youtube.com/watch?v=${videoId}`,
      c.started_at, c.started_at_source, c.scheduled_start_at, c.ended_at, c.status, members, c.view_count, c.view_count_fetched_at,
      now, keyword, seen?.first_seen_via ?? "playlist", c.fetched_at, now,
    );
    eventId = Number(r.lastInsertRowid);
    how = "created";
  } else if (ev.excluded_at !== null) {
    // 行は1動画1行（video_id は UNIQUE）。外れていた行を ai_candidate の枠として戻す。列は巡回・refresh が取った値のまま（新しいほう）
    db.prepare(`UPDATE watch_events SET excluded_at = NULL, excluded_reason = NULL, detect_source = 'ai_candidate', detect_keyword = ?,
      is_members_only = MAX(is_members_only, ?), updated_at = ? WHERE id = ?`).run(keyword, members, now, ev.id);
    eventId = ev.id;
    how = ev.detect_source === "ai_candidate" ? "restored" : "adopted";
  } else {
    eventId = ev.id;
    how = "existing";
    if (members) db.prepare("UPDATE watch_events SET is_members_only = 1, updated_at = ? WHERE id = ? AND is_members_only = 0").run(now, ev.id);
  }
  const isCand = how !== "existing" || ev?.detect_source === "ai_candidate";
  db.prepare("UPDATE candidates SET state = ?, state_at = ?, watch_event_id = ? WHERE video_id = ?").run(isCand ? "framed" : "detected", now, eventId, videoId);
  return { ok: true, eventId, how };
}

/**
 * AI が足した枠（detect_source = 'ai_candidate'）を外す（ai:revoke。判定の取り消しは呼ぶ側）。行は消さず excluded_at を立てる（理由 ai_revoked）。
 * 候補は判定に回す状態（ready）に戻す。ai_candidate でない枠は変えずに返す（呼ぶ側がルールで名寄せし直す）
 */
export function revokeCandidateFrames(db: DB, eventIds: number[], now: string = nowIso()): { revoked: number[]; others: number[] } {
  const out = { revoked: [] as number[], others: [] as number[] };
  const get = db.prepare("SELECT detect_source, excluded_at FROM watch_events WHERE id = ?");
  const exclude = db.prepare("UPDATE watch_events SET excluded_at = ?, excluded_reason = 'ai_revoked', updated_at = ? WHERE id = ?");
  const back = db.prepare("UPDATE candidates SET state = 'ready', state_at = ? WHERE watch_event_id = ? AND state = 'framed'");
  for (const id of eventIds) {
    const ev = get.get(id) as { detect_source: string; excluded_at: string | null } | undefined;
    if (!ev || ev.detect_source !== "ai_candidate") {
      out.others.push(id);
      continue;
    }
    if (ev.excluded_at === null) exclude.run(now, now, id);
    back.run(now, id);
    out.revoked.push(id);
  }
  return out;
}
