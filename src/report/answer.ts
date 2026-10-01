// AI の答え（候補を見ない判定）の形式と検査。型ごとの検証（audit）と本番の判定（ai:apply）で同じものを使う

export type AuditStatus = "identified" | "not_a_work" | "unidentifiable" | "not_in_db" | "hold";

export interface AuditAnswer {
  video_id: string;
  status: AuditStatus;
  works?: { key: string; also?: string[]; episodes?: number[] }[];
  /** not_in_db の作品名 */
  title?: string;
  /** identified で、ほかにも観ているが外部DBに無い作品の名前（「プリキュア＆X」の X が外部DBに無いなど） */
  missing?: string[];
  confidence: "high" | "medium" | "low";
  evidence: { looked: string[]; queries?: string[]; thumbnail?: string; notes?: string };
  rationale: string;
  seconds?: number;
}

const KEY_RE = /^(annict:\d+|anilist:\d+|wikidata:Q\d+)$/;

/** 答えの形式の検査。問題が無ければ null */
export function validateAnswer(a: AuditAnswer): string | null {
  const STATUS = ["identified", "not_a_work", "unidentifiable", "not_in_db", "hold"];
  if (!STATUS.includes(a.status)) return `status が不正: ${a.status}`;
  if (!["high", "medium", "low"].includes(a.confidence)) return `confidence が不正: ${a.confidence}`;
  if (!a.rationale?.trim()) return "rationale が空";
  if (!Array.isArray(a.evidence?.looked) || a.evidence.looked.length === 0) return "evidence.looked が空";
  if (a.status === "identified" && !(a.works ?? []).length) return "identified なのに works が空";
  if ((a.works ?? []).some((w) => !KEY_RE.test(w.key) || (w.also ?? []).some((k) => !KEY_RE.test(k)))) return "works の key が不正";
  if ((a.status === "not_a_work" || a.status === "not_in_db") && (!a.evidence.looked.includes("lookup") || !(a.evidence.queries ?? []).length)) {
    return `${a.status} なのに外部DBを照会していない（evidence.looked に lookup、queries に照会した語が必要）`;
  }
  if (a.status === "not_in_db" && !a.title?.trim()) return "not_in_db なのに title（作品名）が無い";
  if (a.missing !== undefined && (!Array.isArray(a.missing) || a.missing.some((x) => typeof x !== "string" || !x.trim()))) return "missing は作品名の配列";
  if (a.missing?.length && a.status !== "identified") return "missing は identified のときだけ";
  return null;
}

