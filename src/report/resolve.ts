import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DB } from "../lib/db.ts";
import { DATA_DIR } from "../lib/paths.ts";
import type { ExtractConfig } from "../resolve/config.ts";
import { matchKey } from "../resolve/normalize.ts";
import { UNRESOLVED_REASON_LABEL } from "../resolve/types.ts";
import type { UnresolvedReason } from "../resolve/types.ts";

// 名寄せの確認用レポート（ローカルの CLI）。unresolved は公開サイトに出さない。

function table(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "  (なし)";
  const cols = Object.keys(rows[0]!);
  const w = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? "").length)));
  const line = (vals: string[]) => "  " + vals.map((v, i) => v.padEnd(w[i]!)).join("  ");
  return [line(cols), line(w.map((n) => "-".repeat(n))), ...rows.map((r) => line(cols.map((c) => String(r[c] ?? ""))))].join("\n");
}

// 一覧に出ない枠（判定ルールで外した・アーカイブが消えた）は数えない
const OPEN = "u.resolved_at IS NULL AND u.watch_event_id IN (SELECT id FROM watch_events WHERE excluded_at IS NULL AND archive_gone_at IS NULL)";
const ACTIVE = "watch_event_id IN (SELECT id FROM watch_events WHERE excluded_at IS NULL AND archive_gone_at IS NULL)";

/** 頻出パターンの集計キー。数字をまとめ、照合キーでそろえる */
function patternKey(text: string | null, cfg: ExtractConfig): string {
  if (!text) return "(空)";
  return matchKey(text, cfg).replace(/\d+/g, "#") || "(空)";
}

export function resolveSummary(db: DB): string {
  const out: string[] = [];
  const q = (sql: string, ...p: (string | number)[]) => db.prepare(sql).all(...p) as Record<string, unknown>[];
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM event_resolution WHERE ${ACTIVE}`).get() as { n: number }).n;
  const resolved = (db.prepare(`SELECT COUNT(*) AS n FROM event_resolution WHERE status = 'resolved' AND ${ACTIVE}`).get() as { n: number }).n;
  const naw = (db.prepare(`SELECT COUNT(*) AS n FROM unresolved u WHERE ${OPEN} AND reason = 'not_a_work'`).get() as { n: number }).n;
  out.push("■ 名寄せの結果");
  out.push(`  処理した枠 ${total} / 同定 ${resolved} / 未同定 ${total - resolved}（うち作品ではない ${naw}）`);
  out.push(`  成功率（全体）        ${total ? ((resolved / total) * 100).toFixed(1) : "-"}%`);
  out.push(`  成功率（作品ではない枠を除く） ${total - naw ? ((resolved / (total - naw)) * 100).toFixed(1) : "-"}%`);
  out.push("\n■ 未同定の理由");
  out.push(table(q(`SELECT reason, COUNT(*) AS n FROM unresolved u WHERE ${OPEN} GROUP BY reason ORDER BY n DESC`).map((r) => ({
    ...r, label: UNRESOLVED_REASON_LABEL[r.reason as UnresolvedReason] ?? "",
  }))));
  out.push("\n■ 同定の方法（EventWork の枠数）");
  out.push(table(q(`SELECT match_method, COUNT(DISTINCT watch_event_id) AS events, ROUND(AVG(confidence), 2) AS confidence
    FROM event_works WHERE ${ACTIVE} GROUP BY match_method ORDER BY events DESC`)));
  out.push("\n■ 作品");
  out.push(table(q(`SELECT source, COALESCE(media, '?') AS media, COUNT(*) AS works, SUM(image_url IS NOT NULL) AS with_image
    FROM works GROUP BY source, media ORDER BY works DESC`)));
  out.push(table(q(`SELECT COUNT(DISTINCT watch_event_id) AS events_with_episodes, COUNT(*) AS rows FROM event_works WHERE episode_id IS NOT NULL`)));
  return out.join("\n");
}

export function unresolvedStats(db: DB, cfg: ExtractConfig, limit: number): string {
  const out: string[] = [];
  const rows = db
    .prepare(`SELECT u.reason, u.extracted_text, e.title_raw FROM unresolved u JOIN watch_events e ON e.id = u.watch_event_id WHERE ${OPEN}`)
    .all() as { reason: UnresolvedReason; extracted_text: string | null; title_raw: string }[];
  const byReason = new Map<UnresolvedReason, typeof rows>();
  for (const r of rows) byReason.set(r.reason, [...(byReason.get(r.reason) ?? []), r]);
  out.push(`■ unresolved ${rows.length} 件`);
  for (const [reason, rs] of [...byReason].sort((a, b) => b[1].length - a[1].length)) {
    out.push(`\n■ ${reason}（${UNRESOLVED_REASON_LABEL[reason]}）${rs.length} 件 — 頻出パターン上位${limit}`);
    const groups = new Map<string, { n: number; example: string; text: string }>();
    for (const r of rs) {
      const k = reason === "not_a_work" ? r.extracted_text ?? "" : patternKey(r.extracted_text, cfg);
      const g = groups.get(k) ?? { n: 0, example: r.title_raw, text: r.extracted_text ?? "" };
      g.n++;
      groups.set(k, g);
    }
    out.push(table([...groups.values()].sort((a, b) => b.n - a.n).slice(0, limit).map((g) => ({
      n: g.n, extracted: g.text.slice(0, 40), example: g.example.slice(0, 50),
    }))));
  }
  return out.join("\n");
}

export function unresolvedList(db: DB, reason: string | undefined, limit: number): string {
  const rows = db
    .prepare(`SELECT e.video_id, u.reason, u.extracted_text, e.title_raw, u.detail FROM unresolved u JOIN watch_events e ON e.id = u.watch_event_id
      WHERE ${OPEN} ${reason ? "AND u.reason = ?" : ""} ORDER BY u.reason, u.extracted_text LIMIT ?`)
    .all(...(reason ? [reason, limit] : [limit])) as { video_id: string; reason: string; extracted_text: string | null; title_raw: string; detail: string | null }[];
  return table(rows.map((r) => {
    const d = r.detail ? JSON.parse(r.detail) : {};
    const note = Object.values(d.notes ?? {})[0] ?? (d.candidates?.length ? `候補: ${d.candidates.slice(0, 2).join(" | ")}` : "");
    return { video_id: r.video_id, reason: r.reason, extracted: (r.extracted_text ?? "").slice(0, 36), note: String(note).slice(0, 60), title: r.title_raw.slice(0, 50) };
  }));
}

/** R2 に置く unresolved の JSON（Phase 4 でアップロードする）。ローカルでは data/unresolved.json */
export function exportUnresolved(db: DB): string {
  const rows = db
    .prepare(`SELECT e.video_id, e.url, e.title_raw, e.started_at, s.name AS streamer, u.reason, u.extracted_text, u.detail, u.rule_version, u.updated_at
      FROM unresolved u JOIN watch_events e ON e.id = u.watch_event_id JOIN streamers s ON s.id = e.streamer_id
      WHERE ${OPEN} ORDER BY u.reason, u.extracted_text`)
    .all() as Record<string, unknown>[];
  const path = join(DATA_DIR, "unresolved.json");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ generated_at: new Date().toISOString(), count: rows.length,
    items: rows.map((r) => ({ ...r, detail: r.detail ? JSON.parse(String(r.detail)) : null })) }, null, 1));
  return path;
}

/**
 * 誤同定の疑いを洗い出す。取りこぼしより誤同定のほうが害が大きいので、同定済みの中から怪しいものを並べる。
 *   - 公開（放送）年より前に行われた枠（ありえない）
 *   - 「劇場版・映画」の枠がテレビ作品に、話数付きの枠が映画に同定されている
 *   - 1つの枠に複数の作品が付いている
 *   - 小区間・概要欄・全文検索・リダイレクト経由の同定
 *   - 区間が短い（3文字以下）
 */
export function resolveAudit(db: DB, cfg: ExtractConfig, limit: number): string {
  const out: string[] = [];
  const rows = db
    .prepare(`SELECT e.video_id, e.title_raw, e.started_at, ew.match_method, ew.confidence, ew.extracted_text, ew.episode_id,
        w.title AS work_title, w.media, w.release_year, w.source, w.id AS work_id,
        (SELECT COUNT(DISTINCT work_id) FROM event_works x WHERE x.watch_event_id = e.id) AS works_in_event
      FROM event_works ew JOIN watch_events e ON e.id = ew.watch_event_id JOIN works w ON w.id = ew.work_id
      GROUP BY e.id, w.id`)
    .all() as {
      video_id: string; title_raw: string; started_at: string | null; match_method: string; confidence: number; extracted_text: string;
      episode_id: number | null; work_title: string; media: string | null; release_year: number | null; source: string; work_id: number; works_in_event: number;
    }[];
  const flags = new Map<string, string[]>();
  const add = (k: string, why: string) => flags.set(k, [...(flags.get(k) ?? []), why]);
  for (const r of rows) {
    const k = `${r.video_id}|${r.work_id}`;
    const year = r.started_at ? Number(r.started_at.slice(0, 4)) : null;
    if (year && r.release_year && r.release_year > year) add(k, `公開${r.release_year}年 > 枠${year}年`);
    if (/劇場版|映画/.test(r.title_raw) && r.media === "tv") add(k, "劇場版の枠→テレビ作品");
    if (r.episode_id === null && /\d+\s*話/.test(r.title_raw) && r.media === "movie") add(k, "話数付きの枠→映画");
    if (r.works_in_event > 1) add(k, `1枠に${r.works_in_event}作品`);
    if (/sub|description|search|redirect|suffix|\+/.test(r.match_method) || r.confidence < 0.9) add(k, `同定方法 ${r.match_method}`);
    if (matchKey(r.extracted_text, cfg).length <= 3) add(k, "区間が3文字以下");
  }
  const flagged = rows.filter((r) => flags.has(`${r.video_id}|${r.work_id}`));
  out.push(`■ 誤同定の疑い ${flagged.length} 件（同定済み ${rows.length} 組のうち）`);
  const count = new Map<string, number>();
  for (const f of flags.values()) for (const w of f) {
    const key = w.replace(/\d+/g, "N");
    count.set(key, (count.get(key) ?? 0) + 1);
  }
  out.push(table([...count].sort((a, b) => b[1] - a[1]).map(([flag, n]) => ({ flag, n }))));
  out.push(`\n■ 例（最大${limit}件）`);
  out.push(table(flagged.slice(0, limit).map((r) => ({
    video_id: r.video_id,
    flags: flags.get(`${r.video_id}|${r.work_id}`)!.join(" / ").slice(0, 40),
    extracted: r.extracted_text.slice(0, 24),
    work: `${r.work_title.slice(0, 24)} (${r.media ?? "?"},${r.release_year ?? "?"})`,
    title: r.title_raw.slice(0, 44),
  }))));
  // 1つの区間の文字列が、枠によって別の作品に同定されている（本来は同じ作品のはず）
  const split = db
    .prepare(`SELECT ew.extracted_text, COUNT(DISTINCT ew.work_id) AS works, GROUP_CONCAT(DISTINCT w.title) AS titles
      FROM event_works ew JOIN works w ON w.id = ew.work_id GROUP BY ew.extracted_text HAVING works > 1 ORDER BY works DESC LIMIT ?`)
    .all(limit) as Record<string, unknown>[];
  out.push("\n■ 同じ区間が別々の作品に同定されている");
  out.push(table(split));
  return out.join("\n");
}
