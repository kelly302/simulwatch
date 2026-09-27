import type { DB } from "../lib/db.ts";
import { nowIso } from "../lib/time.ts";
import type { WorkCandidate } from "./types.ts";
import { upsertWork, getOrCreateEpisode, markUnresolved, markResolved } from "./store.ts";

// AI の判定の反映。判定は人が起動するコマンド（ai:apply）でだけ入る。定期実行のジョブからは入れない。
//
//   確定: 取り消されていない判定（hold 以外）の枠は、resolve が上書きしない（resolve の対象から外し、最後にこの判定を入れ直す）
//   hold: AI も決められなかった枠。ルールの結果（未同定）のまま残す。判定済みとして次の ai:queue に出さない
//   確度: high / medium / low。low はサイトに出さない（EventWork の match_method が ai:low）

export type AiStatus = "identified" | "not_a_work" | "unidentifiable" | "hold";
export type AiConfidence = "high" | "medium" | "low";

export interface AiWork {
  /** 外部DBのキー（annict:123 / anilist:456 / wikidata:Q789） */
  key: string;
  /** 反映に使う作品の情報（ai:apply が外部DBから引いて入れる） */
  work?: WorkCandidate;
  episodes?: number[];
}

export const AI_CONFIDENCE_SCORE: Record<AiConfidence, number> = { high: 0.9, medium: 0.75, low: 0.5 };

/** 確定した枠（取り消されていない hold 以外の判定がある枠）の SQL 条件 */
export const AI_LOCKED_SQL = `(SELECT watch_event_id FROM ai_decisions WHERE revoked_at IS NULL AND status != 'hold')`;

interface Row {
  id: number;
  watch_event_id: number;
  status: AiStatus;
  works: string | null;
  confidence: AiConfidence;
  rationale: string;
  batch: string;
}

/** 取り消されていない判定を DB に入れ直す（何度実行しても同じ結果）。eventIds を渡せばその枠だけ */
export function applyAiDecisions(db: DB, ruleVersion: string, eventIds?: number[]): { identified: number; not_a_work: number; unidentifiable: number } {
  const out = { identified: 0, not_a_work: 0, unidentifiable: 0 };
  const where = eventIds ? `AND watch_event_id IN (${eventIds.map(() => "?").join(",") || "NULL"})` : "";
  const rows = db.prepare(`SELECT id, watch_event_id, status, works, confidence, rationale, batch FROM ai_decisions
    WHERE revoked_at IS NULL AND status != 'hold' ${where}`).all(...(eventIds ?? [])) as unknown as Row[];
  const now = nowIso();
  for (const r of rows) {
    const ev = r.watch_event_id;
    const info = { ai_decision: r.id, batch: r.batch, confidence: r.confidence, rationale: r.rationale };
    if (r.status === "identified") {
      const works = (JSON.parse(r.works ?? "[]") as AiWork[]).filter((w) => w.work);
      if (works.length === 0) continue;
      db.prepare("DELETE FROM event_works WHERE watch_event_id = ?").run(ev);
      const ins = db.prepare(`INSERT OR IGNORE INTO event_works (watch_event_id, work_id, episode_id, confidence, match_method, extracted_text, rule_version, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const w of works) {
        const workId = upsertWork(db, w.work!);
        const eps = w.work!.media === "movie" ? [] : (w.episodes ?? []);
        const score = AI_CONFIDENCE_SCORE[r.confidence];
        if (eps.length) {
          for (const x of eps) ins.run(ev, workId, getOrCreateEpisode(db, workId, x, `第${x}話`, null), score, `ai:${r.confidence}`, "(AI の判定)", ruleVersion, now);
        } else ins.run(ev, workId, null, score, `ai:${r.confidence}`, "(AI の判定)", ruleVersion, now);
      }
      markResolved(db, ev, ruleVersion);
      out.identified++;
    } else if (r.status === "not_a_work" || r.status === "unidentifiable") {
      markUnresolved(db, ev, r.status, "(AI の判定)", { ai: info }, ruleVersion);
      out[r.status]++;
    }
  }
  return out;
}
