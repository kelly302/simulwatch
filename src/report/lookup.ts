import type { Ctx } from "../lib/context.ts";
import type { ExtractConfig } from "../resolve/config.ts";
import { matchKey } from "../resolve/normalize.ts";
import { workMedia, baseTitle } from "../resolve/match.ts";
import { ResolveCache } from "../resolve/cache.ts";
import { AnnictClient } from "../resolve/sources/annict.ts";
import { AniListClient } from "../resolve/sources/anilist.ts";
import { WikipediaClient } from "../resolve/sources/wikipedia.ts";

// 外部作品DBの照会の確認（ローカルの CLI）。規則で決まらなかった枠を人（AI）が判断するときに使う。
// Annict（部分一致）・AniList（あいまい検索。別名 synonyms も出す）・Wikipedia（記事名・全文検索）・Wikidata（ラベルと別名）を並べる。
// 照会結果はキャッシュ（resolve_cache）に入るので、同じ語を何度引いても外部には1回だけ照会する。

export async function lookup(ctx: Ctx, cfg: ExtractConfig, texts: string[], opts: { limit?: number } = {}): Promise<string> {
  const cache = new ResolveCache(ctx.db, 30);
  const token = process.env.ANNICT_TOKEN;
  const annict = token ? new AnnictClient(ctx.http, cache, token, cfg.annict) : null;
  const anilist = new AniListClient(ctx.http, cache, cfg.anilist);
  const wp = new WikipediaClient(ctx.http, cache);
  const limit = opts.limit ?? 8;
  const out: string[] = [];
  for (const text of texts) {
    const key = matchKey(text, cfg);
    out.push(`■ 「${text}」（照合キー ${key}）`);
    if (annict) {
      const r = (await annict.search([text])).get(text) ?? [];
      out.push(`  Annict ${r.length}件`);
      for (const w of r.slice(0, limit)) {
        out.push(`    annict:${w.annictId} ${w.title}〈${w.media ?? "?"},${w.seasonName ?? "?"},${w.episodesCount ?? "?"}話〉${w.titles.slice(1).length ? ` 英題等: ${w.titles.slice(1).join(" / ")}` : ""}${matchKey(w.title, cfg) === key ? " ★一致" : ""}`);
      }
    }
    const al = (await anilist.searchRaw([text])).get(text) ?? [];
    out.push(`  AniList ${al.length}件`);
    for (const m of al.slice(0, limit)) {
      out.push(`    anilist:${m.id} ${m.title.native ?? ""} / ${m.title.romaji ?? ""} / ${m.title.english ?? ""}〈${m.format ?? "?"},${m.seasonYear ?? m.startDate?.year ?? "?"},${m.episodes ?? "?"}話, MAL ${m.idMal ?? "-"}〉${m.synonyms?.length ? ` 別名: ${m.synonyms.slice(0, 6).join(" / ")}` : ""}`);
    }
    const found = await wp.search(text, 10);
    const pages = await wp.pages([text, `${text} (映画)`, ...found]);
    const ents = await wp.entities([...pages.values()].map((p) => p.qid).filter((q): q is string => !!q));
    const show = (t: string) => {
      const p = pages.get(t);
      if (!p || p.missing) return `    ${t}: 記事なし`;
      const e = p.qid ? ents.get(p.qid) : undefined;
      const media = workMedia(e, cfg);
      return `    ${t}${p.redirected ? ` → ${p.title}${p.fragment ? "（節）" : ""}` : ""}${p.disambiguation ? "（曖昧さ回避）" : ""} ${p.qid ?? ""} P31=${(e?.p31 ?? []).map((c) => cfg.wikipedia.not_work_classes[c] ?? c).join(",")} 年=${e?.year ?? "?"} ${media ? `作品(${media})` : "作品ではない"}${matchKey(baseTitle(p.title ?? t), cfg) === key ? " ★一致" : ""}`;
    };
    out.push("  Wikipedia 記事名");
    out.push(show(text));
    out.push(show(`${text} (映画)`));
    out.push(`  Wikipedia 全文検索 ${found.length}件`);
    for (const t of found) out.push(show(t));
    const hits = await wp.searchEntities(text, limit);
    const hitEnts = await wp.entities(hits.map((h) => h.id));
    out.push(`  Wikidata（ラベル・別名） ${hits.length}件`);
    for (const h of hits) {
      const e = hitEnts.get(h.id);
      const media = workMedia(e, cfg);
      out.push(`    ${h.id} ${h.label ?? ""}（${h.description ?? ""}）一致=${h.matchType}:${h.matchText} 年=${e?.year ?? "?"} ${media ? `作品(${media})` : "作品ではない"}`);
    }
  }
  return out.join("\n");
}
