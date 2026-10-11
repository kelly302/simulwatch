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
  // ルールの作品クラスに無くても、AI の判定でだけ受け付けるクラス（テレビ番組など。ai_extra_work_classes）なら key に使ってよい
  const extra = cfg.wikipedia.ai_extra_work_classes ?? {};
  const kind = (e: { p31: string[] } | undefined, media: string | null) => {
    if (media) return `作品(${media})`;
    const x = (e?.p31 ?? []).map((c) => extra[c]).find((m) => !!m);
    return x ? `作品(${x}・AI の判定でだけ受け付ける)` : "作品ではない";
  };
  const out: string[] = [];
  for (const text of texts) {
    const key = matchKey(text, cfg);
    out.push(`■ 「${text}」（照合キー ${key}）`);
    if (annict) {
      // 1語だけで照会する（名寄せのキャッシュは、まとめて照会した別の語の作品が混ざる）。照合キーが一致・前方一致する作品を先に出す
      const rank = (w: { title: string }) => { const k = matchKey(w.title, cfg); return k === key ? 0 : k.startsWith(key) ? 1 : 2; };
      const r = [...(await annict.searchOne(text))].sort((a, b) => rank(a) - rank(b));
      // 話の番号の範囲（分割クールの後半は通し番号のまま。水星の魔女 Season2 は第13話〜第24話）
      const eps = await annict.episodes(r.slice(0, limit).filter((w) => w.media !== "movie" && w.annictId).map((w) => w.annictId!));
      const range = (id: number | null) => {
        const es = id ? eps.get(id) ?? [] : [];
        return es.length ? ` 話の番号: ${es[0]!.numberText ?? es[0]!.number}〜${es[es.length - 1]!.numberText ?? es[es.length - 1]!.number}` : "";
      };
      out.push(`  Annict ${r.length}件`);
      for (const w of r.slice(0, limit)) {
        out.push(`    annict:${w.annictId} ${w.title}〈${w.media ?? "?"},${w.seasonName ?? "?"},${w.episodesCount ?? "?"}話〉${range(w.annictId)}${w.titles.slice(1).length ? ` 英題等: ${w.titles.slice(1).join(" / ")}` : ""}${matchKey(w.title, cfg) === key ? " ★一致" : ""}`);
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
      return `    ${t}${p.redirected ? ` → ${p.title}${p.fragment ? "（節）" : ""}` : ""}${p.disambiguation ? "（曖昧さ回避）" : ""} ${p.qid ?? ""} P31=${(e?.p31 ?? []).map((c) => cfg.wikipedia.not_work_classes[c] ?? c).join(",")} 年=${e?.year ?? "?"} ${kind(e, media)}${matchKey(baseTitle(p.title ?? t), cfg) === key ? " ★一致" : ""}`;
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
      out.push(`    ${h.id} ${h.label ?? ""}（${h.description ?? ""}）一致=${h.matchType}:${h.matchText} 年=${e?.year ?? "?"} ${kind(e, media)}`);
    }
  }
  return out.join("\n");
}
