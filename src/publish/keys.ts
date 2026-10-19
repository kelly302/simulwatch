import type { DB } from "../lib/db.ts";
import { publicKeyOf, workPath } from "../shared/site.ts";

// 作品の URL の公開キー（2026-10-19 の決定 C）。
//
//   キーは外部DBの ID（annict-1234 / anilist-5678 / wikidata-Q123。annict > anilist > wikidata）から作り、一度出したら変えない。
//   works の行は名寄せで消して作り直されるので、出したキーと、そのときの ID を work_public_keys に覚えておく。
//
//   1. 今の作品の優先のキーが表にあれば、それを使う
//   2. 無ければ、ID が重なる表のキー（まだ今の作品に付いていないもの）を使う。重なるキーが複数なら優先の順（annict > anilist > wikidata）、同じなら古いほう
//      （Wikidata だけで出した作品にあとで Annict の ID が付いても、URL は変えない）
//   3. どれも無ければ優先のキーを新しく出す
//   今の作品に付かなかった表のキーは、ID が重なる今の作品へ 301 で転送する（行がまとまったとき）。重なる作品が無ければ転送しない（404）

export interface KeyedWork {
  id: number;
  annictId: number | null;
  anilistId: number | null;
  wikidataId: string | null;
}

interface KeyRow {
  public_key: string;
  annict_id: number | null;
  anilist_id: number | null;
  wikidata_id: string | null;
  first_published_at: string;
}

const PRIORITY: Record<string, number> = { annict: 0, anilist: 1, wikidata: 2 };
const rank = (k: string) => PRIORITY[k.slice(0, k.indexOf("-"))] ?? 9;

function overlaps(r: KeyRow, w: KeyedWork): boolean {
  return (r.annict_id != null && r.annict_id === w.annictId)
    || (r.anilist_id != null && r.anilist_id === w.anilistId)
    || (r.wikidata_id != null && r.wikidata_id === w.wikidataId);
}

/**
 * 作品に公開キーを付け、表を更新する。works は作品ページを作る作品だけを渡す。
 * 戻り値は作品の行の id → キーと、転送（古いキーのパス → 今のキーのパス）
 */
export function assignPublicKeys(db: DB, works: KeyedWork[], now: string): { keys: Map<number, string>; redirects: { from: string; to: string }[] } {
  const rows = db.prepare("SELECT public_key, annict_id, anilist_id, wikidata_id, first_published_at FROM work_public_keys").all() as unknown as KeyRow[];
  const byKey = new Map(rows.map((r) => [r.public_key, r]));
  const taken = new Set<string>();
  const keys = new Map<number, string>();
  const sorted = [...works].sort((a, b) => a.id - b.id);

  // 1. 優先のキーが表にある作品
  for (const w of sorted) {
    const k = publicKeyOf(w);
    if (k && byKey.has(k) && !taken.has(k)) {
      keys.set(w.id, k);
      taken.add(k);
    }
  }
  // 2・3. ID が重なる表のキー、無ければ新しいキー
  for (const w of sorted) {
    if (keys.has(w.id)) continue;
    const cands = rows.filter((r) => !taken.has(r.public_key) && overlaps(r, w))
      .sort((a, b) => rank(a.public_key) - rank(b.public_key) || a.first_published_at.localeCompare(b.first_published_at));
    const k = cands[0]?.public_key ?? publicKeyOf(w);
    if (!k || taken.has(k)) continue; // ID が無い作品（無いはず）・キーの衝突（起きないはず）は出さない
    keys.set(w.id, k);
    taken.add(k);
  }

  // 表を更新する。キーの ID は今の作品の ID で埋める（無い ID は前の値を残す）
  const upsert = db.prepare(`INSERT INTO work_public_keys (public_key, annict_id, anilist_id, wikidata_id, first_published_at, last_published_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(public_key) DO UPDATE SET
      annict_id = COALESCE(excluded.annict_id, annict_id),
      anilist_id = COALESCE(excluded.anilist_id, anilist_id),
      wikidata_id = COALESCE(excluded.wikidata_id, wikidata_id),
      last_published_at = excluded.last_published_at`);
  const byId = new Map(works.map((w) => [w.id, w]));
  for (const [id, k] of keys) {
    const w = byId.get(id)!;
    upsert.run(k, w.annictId, w.anilistId, w.wikidataId, now, now);
  }

  // 今の作品に付かなかったキーの転送
  const redirects: { from: string; to: string }[] = [];
  for (const r of rows) {
    if (taken.has(r.public_key)) continue;
    const to = sorted.find((w) => keys.has(w.id) && overlaps(r, w));
    if (to) redirects.push({ from: workPath(r.public_key), to: workPath(keys.get(to.id)!) });
  }
  redirects.sort((a, b) => a.from.localeCompare(b.from));
  return { keys, redirects };
}
