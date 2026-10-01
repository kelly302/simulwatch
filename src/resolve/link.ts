import type { Ctx } from "../lib/context.ts";
import { tx } from "../lib/db.ts";
import { log } from "../lib/log.ts";
import type { ExtractConfig } from "./config.ts";
import { ResolveCache } from "./cache.ts";
import { AnnictClient } from "./sources/annict.ts";
import { AniListClient } from "./sources/anilist.ts";
import { WikipediaClient } from "./sources/wikipedia.ts";
import { mergeWorks, upsertWork } from "./store.ts";
import type { WorkCandidate } from "./types.ts";
import { matchKey } from "./normalize.ts";

// Wikidata で引いたアニメの作品を、アニメのDB（Annict が主軸）の行にまとめる（2026-10-02）。
// Wikipedia の記事名のリダイレクト（「グレンラガン」→「天元突破グレンラガン」）やラベルで当たると Wikidata の行ができ、
// 同じ作品の Annict の行と2行に分かれていた（作品一覧・配信者ページに同じ作品が2行並ぶ）。
// Wikidata の項目の MyAnimeList の ID（P4086）と AniList の ID（P8729）が、どちらも1つ以下で少なくとも片方あるときだけ:
//   1. 同じ ID を持つ行が DB に1つだけあれば、その行にまとめる（Wikidata の ID はまとめた行に付く）
//   2. 無ければ Annict を作品名で検索し、MyAnimeList の ID が同じ作品が1つだけなら、その Annict の作品にする（Annict を正にする）
//   3. それも無ければ ID だけを付ける（あとで Annict・AniList の行ができたときにまとまる。AniList の画像も付く）
// ID を複数持つ項目（期をまとめた項目）はまとめない（どの期か決められない）。
// ID の無い項目（海外のアニメ、ID の付いていない項目）は、アニメーションの項目で、照合キーが同じ作品名・映画かシリーズかが同じ・公開年の差が1年以内の
// アニメのDBの行が1つだけなら、その行にまとめる（「ナイトメアー・ビフォア・クリスマス」は Wikidata が1993年、Annict が日本公開の1994年。
// 「ホワット・イフ…？」は Annict が web、Wikidata が tv。tv・web・ova はシリーズとして同じに見る）。
// 名寄せ（resolve）の最後と ai:apply のあとに行う

type Row = { id: number; title: string; wikidata_id: string; series_id: string | null; media: string | null; release_year: number | null };

export async function linkAnimeIds(ctx: Ctx, cfg: ExtractConfig): Promise<{ checked: number; merged: number; converted: number; idsOnly: number; multi: number; byTitle: number }> {
  const db = ctx.db;
  const out = { checked: 0, merged: 0, converted: 0, idsOnly: 0, multi: 0, byTitle: 0 };
  // Wikidata だけで引いて、アニメのDBの ID がまだ無い行
  const rows = db.prepare("SELECT id, title, wikidata_id, series_id, media, release_year FROM works WHERE source = 'wikidata' AND wikidata_id IS NOT NULL AND annict_id IS NULL AND anilist_id IS NULL AND mal_id IS NULL").all() as Row[];
  if (rows.length === 0) return out;
  const cache = new ResolveCache(db, 30);
  const wp = new WikipediaClient(ctx.http, cache);
  const attrs = await wp.attrs(rows.map((r) => r.wikidata_id));
  const all = rows.map((r) => ({ r, a: attrs.get(r.wikidata_id) }));
  const todo = all.filter((x) => x.a && (x.a.mal.length > 0 || x.a.anilist.length > 0));
  out.checked = todo.length;
  // ID の無いアニメーションの項目は作品名でまとめる
  const animation = new Set([...(cfg.wikipedia.anime_classes ?? []), ...(cfg.wikipedia.animation_genres ?? [])]);
  const noIds = all.filter((x) => x.a && x.a.mal.length === 0 && x.a.anilist.length === 0 && (x.a.p31.some((c) => animation.has(c)) || x.a.p136.some((g) => animation.has(g))));
  if (noIds.length) {
    const series = (m: string | null) => (m === "movie" ? "movie" : m ? "series" : null);
    const animeRows = db.prepare("SELECT id, title, media, release_year, wikidata_id FROM works WHERE source IN ('annict', 'anilist')").all() as { id: number; title: string; media: string | null; release_year: number | null; wikidata_id: string | null }[];
    const byKey = new Map<string, typeof animeRows>();
    for (const w of animeRows) { const k = matchKey(w.title, cfg); byKey.set(k, [...(byKey.get(k) ?? []), w]); }
    tx(db, () => {
      for (const { r } of noIds) {
        const hits = (byKey.get(matchKey(r.title, cfg)) ?? []).filter((w) =>
          series(w.media) === series(r.media) && w.release_year !== null && r.release_year !== null && Math.abs(w.release_year - r.release_year) <= 1);
        if (hits.length !== 1 || (hits[0]!.wikidata_id !== null && hits[0]!.wikidata_id !== r.wikidata_id)) continue;
        mergeWorks(db, hits[0]!.id, r.id);
        out.byTitle++;
      }
    });
  }
  const single = todo.filter((x) => x.a!.mal.length <= 1 && x.a!.anilist.length <= 1);
  out.multi = todo.length - single.length;
  if (single.length === 0) {
    if (out.byTitle) log.info(`Wikidata のアニメ: 作品名でアニメのDBの行にまとめた ${out.byTitle}`);
    return out;
  }

  const anilist = new AniListClient(ctx.http, cache, cfg.anilist);
  const token = process.env.ANNICT_TOKEN;
  const annict = token ? new AnnictClient(ctx.http, cache, token, cfg.annict) : null;
  const num = (v: string | undefined) => (v && /^\d+$/.test(v) ? Number(v) : null);
  const items = single.map(({ r, a }) => ({ r, mal: num(a!.mal[0]), al: num(a!.anilist[0]) }));

  // 2 の照会: Annict を作品名（Wikidata のラベルと AniList の原題）で検索して、MyAnimeList の ID が同じ作品
  const byMal = await anilist.byMalIds(items.map((x) => x.mal).filter((m): m is number => m !== null));
  const terms = (x: (typeof items)[number]) => [x.r.title, ...(x.mal !== null && byMal.get(x.mal) ? [byMal.get(x.mal)!.title] : [])];
  const found = annict ? await annict.search(items.flatMap(terms)) : new Map<string, WorkCandidate[]>();

  tx(db, () => {
    for (const x of items) {
      const { r, mal, al } = x;
      // 1. 同じ ID を持つ行
      const targets = db.prepare("SELECT id, wikidata_id FROM works WHERE id != ? AND ((? IS NOT NULL AND anilist_id = ?) OR (? IS NOT NULL AND mal_id = ?))")
        .all(r.id, al, al, mal, mal) as { id: number; wikidata_id: string | null }[];
      if (targets.length === 1 && (targets[0]!.wikidata_id === null || targets[0]!.wikidata_id === r.wikidata_id)) {
        mergeWorks(db, targets[0]!.id, r.id);
        out.merged++;
        continue;
      }
      if (targets.length > 0) continue; // 同じ ID の行が複数（総集編の Re: と Re:Re: など）か、別の Wikidata の項目が付いた行。まとめない
      // 2. Annict の作品（MyAnimeList の ID が同じものが1つだけ）
      const hits = new Map<number, WorkCandidate>();
      if (mal !== null) for (const t of terms(x)) for (const c of found.get(t) ?? []) if (c.malId === mal && c.annictId) hits.set(c.annictId, c);
      db.prepare("UPDATE works SET mal_id = ?, anilist_id = ?, updated_at = ? WHERE id = ?").run(mal, al, new Date().toISOString(), r.id);
      if (hits.size === 1) {
        const c = [...hits.values()][0]!;
        // Annict のシリーズ・作品の属性で付け直す
        db.prepare("UPDATE works SET series_id = CASE WHEN series_id LIKE 'wikidata:%' THEN NULL ELSE series_id END, attrs_at = NULL WHERE id = ?").run(r.id);
        const id = upsertWork(db, { ...c, anilistId: c.anilistId ?? al });
        if (id !== r.id) mergeWorks(db, id, r.id);
        out.converted++;
        continue;
      }
      // 3. ID だけ
      out.idsOnly++;
    }
  });
  log.info(`Wikidata のアニメ ${out.checked} 件: アニメのDBの行にまとめた ${out.merged}・Annict の作品にした ${out.converted}・ID だけ付けた ${out.idsOnly}・ID が複数で見送り ${out.multi}・ID が無く作品名でまとめた ${out.byTitle}`);
  return out;
}
