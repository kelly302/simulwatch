import type { DB } from "../lib/db.ts";
import type { WorkCandidate, UnresolvedReason } from "./types.ts";
import { nowIso } from "../lib/time.ts";

// 名寄せ結果の保存（works / episodes / event_works / unresolved / event_resolution）。
// 同じ作品が照会先ごとに別の行にならないよう、Annict・AniList・Wikidata の ID と MyAnimeList の ID で名寄せする。

interface WorkRow {
  id: number;
  annict_id: number | null;
  anilist_id: number | null;
  wikidata_id: string | null;
  mal_id: number | null;
}

const WORK_COLS = "id, annict_id, anilist_id, wikidata_id, mal_id";

/**
 * 2つの行が別の作品だと分かるか。同じ照会先の ID がどちらにも付いていて、しかも違えば別の作品。
 * （例: Annict の「劇場総集編ぼっち・ざ・ろっく！ Re:」と「Re:Re:」は MyAnimeList の ID が同じだが別の作品）
 */
function conflicts(a: Pick<WorkRow, "annict_id" | "anilist_id" | "wikidata_id">, b: Pick<WorkRow, "annict_id" | "anilist_id" | "wikidata_id">): boolean {
  const differ = <T>(x: T | null, y: T | null) => x !== null && y !== null && x !== y;
  return differ(a.annict_id, b.annict_id) || differ(a.anilist_id, b.anilist_id) || differ(a.wikidata_id, b.wikidata_id);
}

function asRow(c: WorkCandidate): Pick<WorkRow, "annict_id" | "anilist_id" | "wikidata_id"> {
  return { annict_id: c.annictId, anilist_id: c.anilistId, wikidata_id: c.wikidataId };
}

function findWork(db: DB, c: WorkCandidate): WorkRow | undefined {
  const q = (col: string, v: unknown) =>
    v === null || v === undefined ? undefined : (db.prepare(`SELECT ${WORK_COLS} FROM works WHERE ${col} = ?`).get(v as string | number) as WorkRow | undefined);
  const direct = q("annict_id", c.annictId) ?? q("anilist_id", c.anilistId) ?? q("wikidata_id", c.wikidataId);
  if (direct) return direct;
  // MyAnimeList の ID は照会先をまたいで同じ作品をまとめるためだけに使う。別の作品だと分かる行とはまとめない
  if (c.malId === null) return undefined;
  // 同じ MyAnimeList の ID を持つ作品が複数ある（総集編の Re: と Re:Re: など）ときは、どれか決められないのでまとめない
  const rows = db.prepare(`SELECT ${WORK_COLS} FROM works WHERE mal_id = ?`).all(c.malId) as unknown as WorkRow[];
  const ok = rows.filter((r) => !conflicts(r, asRow(c)));
  return rows.length === 1 && ok.length === 1 ? ok[0] : undefined;
}

/** 作品を作る・更新する。既存の値は空で上書きしない */
export function upsertWork(db: DB, c: WorkCandidate): number {
  const now = nowIso();
  const ex = findWork(db, c);
  if (!ex) {
    const r = db
      .prepare(`INSERT INTO works (annict_id, anilist_id, wikidata_id, title, title_kana, media, season_name, series_id,
        episodes_count, image_url, mal_id, release_year, source, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(c.annictId, c.anilistId, c.wikidataId, c.title, c.titleKana, c.media, c.seasonName, c.seriesId,
        c.episodesCount, c.imageUrl, c.malId, c.releaseYear, c.source, now, now);
    return Number(r.lastInsertRowid);
  }
  // 同じ作品を指す別の行（別の照会先で先に作られたもの）があれば、先にまとめる（一意制約で落ちないように）。
  // 別の作品だと分かる行とはまとめず、その行が持っている ID はこちらに付けない
  const ids: { annict_id: number | null; anilist_id: number | null; wikidata_id: string | null } = {
    annict_id: c.annictId, anilist_id: c.anilistId, wikidata_id: c.wikidataId,
  };
  for (const col of ["annict_id", "anilist_id", "wikidata_id"] as const) {
    const v = ids[col];
    if (v === null) continue;
    const other = db.prepare(`SELECT ${WORK_COLS} FROM works WHERE ${col} = ? AND id != ?`).get(v, ex.id) as WorkRow | undefined;
    if (!other) continue;
    const cur = db.prepare(`SELECT ${WORK_COLS} FROM works WHERE id = ?`).get(ex.id) as unknown as WorkRow;
    if (conflicts(cur, other)) ids[col] = null;
    else mergeWorks(db, ex.id, other.id);
  }
  // 主軸（Annict）の作品名・種別・話数を優先し、補完側（AniList）は空欄だけを埋める
  const primary = c.source === "annict";
  db.prepare(`UPDATE works SET
      annict_id = COALESCE(annict_id, ?), anilist_id = COALESCE(anilist_id, ?), wikidata_id = COALESCE(wikidata_id, ?),
      mal_id = COALESCE(mal_id, ?),
      title = CASE WHEN ? THEN ? ELSE title END,
      title_kana = COALESCE(title_kana, ?),
      media = CASE WHEN ? THEN COALESCE(?, media) ELSE COALESCE(media, ?) END,
      season_name = COALESCE(season_name, ?), series_id = COALESCE(series_id, ?),
      episodes_count = CASE WHEN ? THEN COALESCE(?, episodes_count) ELSE COALESCE(episodes_count, ?) END, image_url = COALESCE(image_url, ?),
      release_year = COALESCE(release_year, ?),
      source = CASE WHEN ? THEN 'annict' ELSE source END,
      updated_at = ?
    WHERE id = ?`).run(
    ids.annict_id, ids.anilist_id, ids.wikidata_id, c.malId,
    primary ? 1 : 0, c.title, c.titleKana,
    primary ? 1 : 0, c.media, c.media,
    c.seasonName, c.seriesId, primary ? 1 : 0, c.episodesCount, c.episodesCount, c.imageUrl, c.releaseYear,
    primary ? 1 : 0, now, ex.id,
  );
  return ex.id;
}

/** 2つの作品行を1つにまとめる（drop の参照を keep に付け替えて drop を消す） */
export function mergeWorks(db: DB, keepId: number, dropId: number): void {
  if (keepId === dropId) return;
  const eps = db.prepare("SELECT id, number FROM episodes WHERE work_id = ?").all(dropId) as { id: number; number: number | null }[];
  for (const e of eps) {
    const same = db.prepare("SELECT id FROM episodes WHERE work_id = ? AND number IS ?").get(keepId, e.number) as { id: number } | undefined;
    if (same) {
      db.prepare("UPDATE OR IGNORE event_works SET episode_id = ? WHERE episode_id = ?").run(same.id, e.id);
      db.prepare("DELETE FROM event_works WHERE episode_id = ?").run(e.id);
      db.prepare("DELETE FROM episodes WHERE id = ?").run(e.id);
    } else {
      db.prepare("UPDATE episodes SET work_id = ? WHERE id = ?").run(keepId, e.id);
    }
  }
  db.prepare("UPDATE OR IGNORE event_works SET work_id = ? WHERE work_id = ?").run(keepId, dropId);
  db.prepare("DELETE FROM event_works WHERE work_id = ?").run(dropId);
  const d = db.prepare("SELECT anilist_id, wikidata_id, image_url FROM works WHERE id = ?").get(dropId) as
    | { anilist_id: number | null; wikidata_id: string | null; image_url: string | null }
    | undefined;
  db.prepare("DELETE FROM works WHERE id = ?").run(dropId);
  if (d) {
    db.prepare("UPDATE works SET anilist_id = COALESCE(anilist_id, ?), wikidata_id = COALESCE(wikidata_id, ?), image_url = COALESCE(image_url, ?) WHERE id = ?")
      .run(d.anilist_id, d.wikidata_id, d.image_url, keepId);
  }
}

export function getOrCreateEpisode(db: DB, workId: number, number: number, numberText: string, title: string | null): number {
  const ex = db.prepare("SELECT id FROM episodes WHERE work_id = ? AND number = ?").get(workId, number) as { id: number } | undefined;
  if (ex) {
    db.prepare("UPDATE episodes SET title = COALESCE(title, ?) WHERE id = ?").run(title, ex.id);
    return ex.id;
  }
  return Number(db.prepare("INSERT INTO episodes (work_id, number, number_text, title) VALUES (?, ?, ?, ?)").run(workId, number, numberText, title).lastInsertRowid);
}

export interface EventWorkRow {
  workId: number;
  episodeId: number | null;
  confidence: number;
  method: string;
  extractedText: string;
}

/** 枠の EventWork を入れ替える（再処理でルールが変わっても古い紐付けを残さない） */
export function replaceEventWorks(db: DB, eventId: number, rows: EventWorkRow[], ruleVersion: string): void {
  const now = nowIso();
  db.prepare("DELETE FROM event_works WHERE watch_event_id = ?").run(eventId);
  const ins = db.prepare(`INSERT OR IGNORE INTO event_works (watch_event_id, work_id, episode_id, confidence, match_method, extracted_text, rule_version, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const r of rows) ins.run(eventId, r.workId, r.episodeId, r.confidence, r.method, r.extractedText, ruleVersion, now);
}

export function markUnresolved(db: DB, eventId: number, reason: UnresolvedReason, text: string | null, detail: unknown, ruleVersion: string): void {
  const now = nowIso();
  db.prepare("DELETE FROM event_works WHERE watch_event_id = ?").run(eventId);
  db.prepare(`INSERT INTO unresolved (watch_event_id, extracted_text, reason, detail, rule_version, created_at, updated_at, resolved_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
    ON CONFLICT(watch_event_id) DO UPDATE SET extracted_text = excluded.extracted_text, reason = excluded.reason,
      detail = excluded.detail, rule_version = excluded.rule_version, updated_at = excluded.updated_at, resolved_at = NULL`)
    .run(eventId, text, reason, JSON.stringify(detail), ruleVersion, now, now);
  setResolution(db, eventId, "unresolved", ruleVersion);
}

export function markResolved(db: DB, eventId: number, ruleVersion: string): void {
  db.prepare("UPDATE unresolved SET resolved_at = ?, updated_at = ? WHERE watch_event_id = ? AND resolved_at IS NULL").run(nowIso(), nowIso(), eventId);
  setResolution(db, eventId, "resolved", ruleVersion);
}

function setResolution(db: DB, eventId: number, status: "resolved" | "unresolved", ruleVersion: string): void {
  db.prepare(`INSERT INTO event_resolution (watch_event_id, status, rule_version, processed_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(watch_event_id) DO UPDATE SET status = excluded.status, rule_version = excluded.rule_version, processed_at = excluded.processed_at`)
    .run(eventId, status, ruleVersion, nowIso());
}
