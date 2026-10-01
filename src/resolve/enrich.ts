import type { Ctx } from "../lib/context.ts";
import { tx } from "../lib/db.ts";
import { log } from "../lib/log.ts";
import type { ExtractConfig } from "./config.ts";
import { ResolveCache } from "./cache.ts";
import { AnnictClient } from "./sources/annict.ts";
import { AniListClient } from "./sources/anilist.ts";
import { WikipediaClient } from "./sources/wikipedia.ts";
import type { WdAttrs } from "./sources/wikipedia.ts";
import type { WorkKind } from "../shared/types.ts";

// 作品の属性（UI の絞り込み用。2026-10-02 の決定）を外部DBから自動で埋める。手で分類しない。
//   kind         映像の種類。anime / tokusatsu / live_action
//                Annict・AniList の作品はアニメ。Wikidata の作品は、次の順で決める
//                  1. 作品のジャンル（P136）に特撮（tokusatsu_genres）があれば特撮
//                  2. アニメーションのジャンルか anime_classes の分類（P31）があればアニメ
//                  3. 作品名に tokusatsu_title_words（仮面ライダー）があれば特撮（Wikidata に手がかりの無い仮面ライダーギーツ）
//                  4. シリーズ（P179。2段まで）・原作（P144）・フランチャイズ（P8345）のジャンルに特撮があれば特撮
//                     （仮面ライダーシリーズ・スーパー戦隊シリーズ・劇場版の原作のテレビシリーズ。作品自体のアニメの分類を上書きしない）。
//                     受け継ぐのは、その項目が作品・シリーズ・フランチャイズのときだけ（原作がキャラクターの「ゴジラ」はジャンルが特撮だが受け継がない）
//                  5. それ以外は実写。怪獣映画（ゴジラ・ガメラ）は実写（2026-10-02 決定）
//                特撮は日本の作品に限る（tokusatsu_origin。原語（P364）が日本語。原語が無ければ制作国に日本。どちらも無ければ限らない）。
//                ハリウッドのゴジラは原作がゴジラでも実写（制作国には日本も入っているので原語で見る）
//   countries    制作国（ISO 3166-1 alpha-2 の並び）。Wikidata の P495（国の項目の P297）、無ければ AniList の countryOfOrigin。
//                Annict にだけある作品（海外のアニメ映画に多い）は、作品名・「作品名 (映画)」・「作品名 (YYYY年の映画)」の Wikipedia の記事の
//                Wikidata 項目がアニメーションの作品で公開年が±1年（日本の公開が翌年になる）なら、その P495 を使う（制作国を引くためだけ。同定には使わない）。
//                それでも無ければ、同じシリーズ（series_id）のほかの作品の制作国がそろっていればそれを使う（「チェンソーマン 総集篇」）。分からなければ NULL
//   series_title シリーズの名前。Annict のシリーズ（series_id = annict:<シリーズ>）、Wikidata の P179（series_id = wikidata:<Q>）の日本語ラベル
//                （無ければ英語のラベル）。シリーズのまとめ（UI）は series_title のある作品を series_id でまとめる。
//                Annict の作品で series_id が空のもの（視聴系列・AI の判定でシリーズの一覧から作った作品）は、Annict の作品のシリーズで埋める
//                （シリーズが複数なら、DB のほかの作品が多く付いているもの。「アイカツオンパレード！」は「アイカツ！」）
//                Wikidata の P179 には一覧記事（「BBC's 100 Greatest Films of the 21st Century」）やスタジオの作品一覧が入ることがあるので、
//                series_excluded_classes・series_excluded の項目はシリーズにしない（series_title を NULL にする）
//   title        Wikidata に日本語のラベルが無い項目（AI の判定で選んだ「We Are Zombies」）は作品名が QID になるので、英語のラベルに直す
// 映画かどうかは既存の media（movie）で見る。名寄せ（resolve）のたびと ai:apply のあとに、まだ埋めていない作品だけを埋める（all で全部）

export interface WorkAttrs {
  kind: WorkKind;
  countries: string[] | null;
}

/**
 * 映像の種類（純粋関数）。p31・p136 は Wikidata の作品のときだけ。related はシリーズ（P179。2段まで）・原作（P144）・フランチャイズ（P8345）のジャンル。
 * japanese は日本の作品か（原語・制作国で見る。分からなければ null）
 */
export function workKind(source: string, p31: string[], p136: string[], cfg: ExtractConfig, related: string[] = [], japanese: boolean | null = null, title = ""): WorkKind {
  if (source === "annict" || source === "anilist") return "anime";
  const tok = (gs: string[]) => japanese !== false && gs.some((g) => (cfg.wikipedia.tokusatsu_genres ?? []).includes(g));
  if (tok(p136)) return "tokusatsu";
  const animation = new Set([...(cfg.wikipedia.anime_classes ?? []), ...(cfg.wikipedia.animation_genres ?? [])]);
  if (p31.some((c) => animation.has(c)) || p136.some((g) => animation.has(g))) return "anime";
  if (japanese !== false && (cfg.wikipedia.tokusatsu_title_words ?? []).some((w) => title.includes(w))) return "tokusatsu";
  if (tok(related)) return "tokusatsu";
  return "live_action";
}

export async function enrichWorks(ctx: Ctx, cfg: ExtractConfig, opts: { all?: boolean } = {}): Promise<{ updated: number; kinds: Record<string, number>; noCountry: number; series: number; countryViaWikipedia: number; countryViaSeries: number }> {
  const db = ctx.db;
  const rows = db.prepare(`SELECT id, title, release_year, source, annict_id, anilist_id, wikidata_id, series_id FROM works ${opts.all ? "" : "WHERE attrs_at IS NULL"}`).all() as {
    id: number; title: string; release_year: number | null; source: string; annict_id: number | null; anilist_id: number | null; wikidata_id: string | null; series_id: string | null;
  }[];
  const out = { updated: 0, kinds: {} as Record<string, number>, noCountry: 0, series: 0, countryViaWikipedia: 0, countryViaSeries: 0 };
  if (rows.length === 0) return out;
  log.info(`作品の属性: ${rows.length} 件`);
  const cache = new ResolveCache(db, 30);
  const wp = new WikipediaClient(ctx.http, cache);
  const anilist = new AniListClient(ctx.http, cache, cfg.anilist);
  const token = process.env.ANNICT_TOKEN;
  const annict = token ? new AnnictClient(ctx.http, cache, token, cfg.annict) : null;

  // Wikidata: 作品の分類（P31）と属性（ジャンル・制作国）、シリーズ（P179）の名前、国の ISO コード
  const qids = rows.map((r) => r.wikidata_id).filter((q): q is string => !!q);
  const ents = await wp.entities(qids);
  const attrs = await wp.attrs(qids);
  const seriesQ = rows.map((r) => (r.series_id?.startsWith("wikidata:") ? r.series_id.slice(9) : null)).filter((q): q is string => !!q);
  const seriesEnts = await wp.entities(seriesQ);
  const seriesAttrs = await wp.attrs(seriesQ);
  // 特撮の判定用に、作品のシリーズ（P179）とその上のシリーズ・原作（P144）・フランチャイズ（P8345）のジャンル
  const up1 = await wp.entities([...ents.values()].map((e) => e.series).filter((q): q is string => !!q));
  const up2 = await wp.entities([...up1.values()].map((e) => e.series).filter((q): q is string => !!q));
  const related = [...attrs.values()].flatMap((a) => [...a.p144, ...a.p8345]);
  const upAttrs = await wp.attrs([...up1.keys(), ...up2.keys(), ...related]);
  // 受け継ぐのは作品・シリーズ・フランチャイズの項目だけ（キャラクターの項目は除く）。シリーズ（P179）は項目の分類を問わない
  const inheritable = new Set([...Object.keys(cfg.wikipedia.work_classes), ...(cfg.wikipedia.tokusatsu_inherit_classes ?? [])]);
  const relatedGenres = (q: string | null | undefined, a: WdAttrs | undefined): string[] => {
    const parent = q ? up1.get(q)?.series : null;
    const via = [...(a?.p144 ?? []), ...(a?.p8345 ?? [])].filter((x) => (upAttrs.get(x)?.p31 ?? []).some((c) => inheritable.has(c)));
    return [q, parent, ...via].flatMap((x) => (x ? upAttrs.get(x)?.p136 ?? [] : []));
  };
  const countryQ = [...new Set([...attrs.values()].flatMap((a) => a.p495))];
  const countryIso = new Map([...(await wp.attrs(countryQ))].map(([q, a]) => [q, a.p297]));
  // AniList の制作国（アニメ）
  const anilistCountry = await anilist.countries(rows.map((r) => r.anilist_id).filter((x): x is number => x !== null));
  // Annict のシリーズの名前
  const annictSeries = annict
    ? await annict.seriesNames(rows.filter((r) => r.annict_id !== null && (r.series_id === null || r.series_id.startsWith("annict:"))).map((r) => r.annict_id!))
    : new Map<number, { id: number; name: string }[]>();

  // Annict にだけある作品の制作国: 同名の Wikipedia の記事の Wikidata 項目（アニメーションの作品で公開年が±1年のときだけ）
  const animation = new Set([...(cfg.wikipedia.anime_classes ?? []), ...(cfg.wikipedia.animation_genres ?? [])]);
  const orphans = rows.filter((r) => !r.wikidata_id && (r.anilist_id === null || !anilistCountry.get(r.anilist_id)));
  const orphanTitles = (r: { title: string; release_year: number | null }) => [r.title, `${r.title} (映画)`,
    ...(r.release_year ? [`${r.title} (${r.release_year}年の映画)`, `${r.title} (${r.release_year - 1}年の映画)`] : [])];
  const orphanPages = await wp.pages(orphans.flatMap(orphanTitles));
  const orphanQ = [...orphanPages.values()].filter((p) => !p.missing && !p.disambiguation && !p.fragment && p.qid).map((p) => p.qid!);
  const orphanEnts = await wp.entities(orphanQ);
  const orphanAttrs = await wp.attrs(orphanQ);
  const orphanIso = new Map([...(await wp.attrs([...orphanAttrs.values()].flatMap((a) => a.p495)))].map(([q, a]) => [q, a.p297]));
  const viaWikipedia = new Map<number, string[]>();
  for (const r of orphans) {
    for (const t of orphanTitles(r)) {
      const p = orphanPages.get(t);
      if (!p || p.missing || p.disambiguation || p.fragment || !p.qid) continue;
      const e = orphanEnts.get(p.qid);
      const a = orphanAttrs.get(p.qid);
      if (!e || !a || r.release_year === null || e.year === null || Math.abs(e.year - r.release_year) > 1) continue;
      if (!e.p31.some((c) => animation.has(c)) && !a.p136.some((g) => animation.has(g))) continue;
      const iso = a.p495.map((q) => orphanIso.get(q)).filter((x): x is string => !!x);
      if (iso.length) { viaWikipedia.set(r.id, [...new Set(iso)]); break; }
    }
  }

  const now = new Date().toISOString();
  const seriesUse = new Map((db.prepare("SELECT series_id, COUNT(*) n FROM works WHERE series_id IS NOT NULL GROUP BY series_id").all() as { series_id: string; n: number }[]).map((x) => [x.series_id, x.n]));
  const up = db.prepare("UPDATE works SET kind = ?, countries = ?, series_title = ?, series_id = COALESCE(series_id, ?), attrs_at = ? WHERE id = ?");
  const retitle = db.prepare("UPDATE works SET title = ? WHERE id = ?");
  tx(db, () => {
    for (const r of rows) {
      const e = r.wikidata_id ? ents.get(r.wikidata_id) : undefined;
      const a = r.wikidata_id ? attrs.get(r.wikidata_id) : undefined;
      const fromWd = (a?.p495 ?? []).map((q) => countryIso.get(q)).filter((x): x is string => !!x);
      const fromAl = r.anilist_id !== null ? anilistCountry.get(r.anilist_id) ?? null : null;
      const countries = fromWd.length ? [...new Set(fromWd)] : fromAl ? [fromAl] : viaWikipedia.get(r.id) ?? null;
      const origin = cfg.wikipedia.tokusatsu_origin;
      const japanese = !origin ? null
        : a?.p364.length ? a.p364.includes(origin.language)
        : countries ? countries.includes(origin.country) : null;
      const kind = workKind(r.source, e?.p31 ?? [], a?.p136 ?? [], cfg, relatedGenres(e?.series, a), japanese, r.title);
      let seriesTitle: string | null = null;
      let fillSeries: string | null = null;
      if (r.series_id?.startsWith("wikidata:")) {
        const q = r.series_id.slice(9);
        const sa = seriesAttrs.get(q);
        const excluded = (cfg.wikipedia.series_excluded ?? []).includes(q) || (sa?.p31 ?? []).some((c) => (cfg.wikipedia.series_excluded_classes ?? []).includes(c));
        if (!excluded) seriesTitle = seriesEnts.get(q)?.labelJa ?? sa?.labelEn ?? null;
      }
      else if (r.series_id?.startsWith("annict:") && r.annict_id !== null) {
        const sid = Number(r.series_id.slice(7));
        seriesTitle = annictSeries.get(r.annict_id)?.find((s) => s.id === sid)?.name ?? null;
      } else if (!r.series_id && r.annict_id !== null) {
        const cands = annictSeries.get(r.annict_id) ?? [];
        const first = [...cands].sort((x, y) => (seriesUse.get(`annict:${y.id}`) ?? 0) - (seriesUse.get(`annict:${x.id}`) ?? 0))[0];
        if (first) {
          fillSeries = `annict:${first.id}`;
          seriesTitle = first.name;
          r.series_id = fillSeries;
        }
      }
      up.run(kind, countries ? JSON.stringify(countries) : null, seriesTitle, fillSeries, now, r.id);
      if (/^Q\d+$/.test(r.title) && a?.labelEn) retitle.run(a.labelEn, r.id);
      out.updated++;
      out.kinds[kind] = (out.kinds[kind] ?? 0) + 1;
      if (!countries) out.noCountry++;
      if (viaWikipedia.has(r.id) && !fromWd.length && !fromAl) out.countryViaWikipedia++;
      if (seriesTitle) out.series++;
    }
  });
  // 同じシリーズのほかの作品の制作国がそろっていれば使う
  const sibling = db.prepare("SELECT DISTINCT countries FROM works WHERE series_id = ? AND id != ? AND countries IS NOT NULL");
  const setCountries = db.prepare("UPDATE works SET countries = ? WHERE id = ?");
  for (const r of rows) {
    if (!r.series_id) continue;
    const cur = db.prepare("SELECT countries FROM works WHERE id = ?").get(r.id) as { countries: string | null };
    if (cur.countries) continue;
    const sib = sibling.all(r.series_id, r.id) as { countries: string }[];
    if (sib.length === 1) {
      setCountries.run(sib[0]!.countries, r.id);
      out.noCountry--;
      out.countryViaSeries++;
    }
  }
  return out;
}
