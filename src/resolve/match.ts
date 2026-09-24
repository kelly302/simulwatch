import type { ExtractConfig } from "./config.ts";
import type { WorkCandidate, Media } from "./types.ts";
import type { PageInfo, EntityInfo } from "./sources/wikipedia.ts";
import { matchKey } from "./normalize.ts";

// 照会結果から作品を決める（純粋関数）。取りこぼしより誤同定のほうが害が大きいので、
// 区間の照合キーが作品名（原題・英題・別名）のどれかと完全に一致したときだけ採用する。

export type MatchResult =
  | { kind: "match"; work: WorkCandidate; method: string }
  | { kind: "ambiguous"; works: WorkCandidate[]; method: string }
  | { kind: "none"; note?: string };

const MOVIE_HINT = /劇場版|映画|the ?movie|ムービー/i;

/**
 * 候補のうち、作品名が区間と完全一致するものを選ぶ。
 * 同名の作品が複数あるとき（リメイク・テレビと劇場版など）は、タイトルに「劇場版・映画」があれば映画、無ければテレビを選ぶ。
 * それでも1つに決まらなければ ambiguous（誤同定するより unresolved に回す）。
 */
export function matchByTitle(key: string, candidates: WorkCandidate[], hintText: string, cfg: ExtractConfig): MatchResult {
  const seen = new Set<string>();
  const equal: WorkCandidate[] = [];
  for (const w of candidates) {
    if (seen.has(w.sourceKey)) continue;
    if (w.titles.some((t) => matchKey(t, cfg) === key)) {
      seen.add(w.sourceKey);
      equal.push(w);
    }
  }
  if (equal.length === 0) return { kind: "none" };
  if (equal.length === 1) return { kind: "match", work: equal[0]!, method: "exact" };
  const want: Media = MOVIE_HINT.test(hintText) ? "movie" : "tv";
  const byMedia = equal.filter((w) => w.media === want);
  if (byMedia.length === 1) return { kind: "match", work: byMedia[0]!, method: `exact+${want}` };
  return { kind: "ambiguous", works: equal, method: "exact" };
}

/** Wikidata の P31 が作品クラスなら media（tv/movie/ova/web）を返す。作品でなければ null */
export function workMedia(entity: EntityInfo | undefined, cfg: ExtractConfig): Media | null {
  if (!entity) return null;
  for (const c of entity.p31) {
    const m = cfg.wikipedia.work_classes[c];
    if (m) return m;
  }
  return null;
}

/** 記事が作品として使えるか（曖昧さ回避・節へのリダイレクト・作品でないクラスを除く） */
export function isWorkPage(p: PageInfo | undefined, entities: Map<string, EntityInfo>, cfg: ExtractConfig): boolean {
  if (!p || p.missing || !p.qid || p.disambiguation || p.fragment) return false;
  return workMedia(entities.get(p.qid), cfg) !== null;
}

/** 記事名から「 (映画)」のような曖昧さ回避の括弧を外す */
export function baseTitle(t: string): string {
  return t.replace(/\s*[（(][^()（）]*[)）]\s*$/, "").trim();
}

export function wikidataCandidate(p: PageInfo, e: EntityInfo, cfg: ExtractConfig): WorkCandidate {
  const title = e.labelJa ?? baseTitle(p.title ?? p.query);
  return {
    source: "wikidata",
    sourceKey: `wikidata:${e.qid}`,
    annictId: null,
    anilistId: null,
    wikidataId: e.qid,
    malId: null,
    title,
    titleKana: null,
    titles: [title, baseTitle(p.title ?? "")].filter(Boolean),
    media: workMedia(e, cfg),
    seasonName: e.year ? String(e.year) : null,
    releaseYear: e.year,
    episodesCount: null,
    imageUrl: null,
    seriesId: e.series ? `wikidata:${e.series}` : null,
  };
}

/** Wikipedia で試す記事名（区間そのものと、曖昧さ回避の接尾辞付き） */
export function wikipediaTitlesFor(text: string, cfg: ExtractConfig): string[] {
  return [text, ...cfg.wikipedia.title_suffixes.map((s) => `${text}${s}`)];
}

/**
 * Wikipedia の記事名照会の結果から作品を決める。
 * 1. 区間そのものの記事が作品なら採用（リダイレクト経由も可。ただし節へのリダイレクトは不可）
 * 2. そうでなければ「区間 (映画)」などの記事を順に試す（「国宝」→「国宝 (映画)」、「プラダを着た悪魔」→ 小説なので映画の記事へ）
 */
export function decideWikipedia(
  text: string,
  pages: Map<string, PageInfo>,
  entities: Map<string, EntityInfo>,
  cfg: ExtractConfig,
): MatchResult {
  const exact = pages.get(text);
  if (isWorkPage(exact, entities, cfg)) {
    return { kind: "match", work: wikidataCandidate(exact!, entities.get(exact!.qid!)!, cfg), method: exact!.redirected ? "redirect" : "exact" };
  }
  for (const suffix of cfg.wikipedia.title_suffixes) {
    const p = pages.get(`${text}${suffix}`);
    if (isWorkPage(p, entities, cfg)) {
      return { kind: "match", work: wikidataCandidate(p!, entities.get(p!.qid!)!, cfg), method: "suffix" };
    }
  }
  let note: string | undefined;
  if (exact?.disambiguation) note = "曖昧さ回避ページ";
  else if (exact?.fragment) note = "記事の節へのリダイレクト";
  else if (exact?.qid) note = `作品でない記事（P31: ${(entities.get(exact.qid)?.p31 ?? []).map((c) => cfg.wikipedia.not_work_classes[c] ?? c).join(",")}）`;
  return { kind: "none", note };
}

/**
 * 全文検索の結果から作品を決める。記事名の括弧を外したものが区間と完全一致し、作品である記事だけを採用する。
 * 複数あれば ambiguous。
 */
export function decideWikipediaSearch(
  key: string,
  titles: string[],
  pages: Map<string, PageInfo>,
  entities: Map<string, EntityInfo>,
  cfg: ExtractConfig,
): MatchResult {
  const works = new Map<string, WorkCandidate>();
  for (const t of titles) {
    if (matchKey(baseTitle(t), cfg) !== key) continue;
    const p = pages.get(t);
    if (!isWorkPage(p, entities, cfg)) continue;
    const w = wikidataCandidate(p!, entities.get(p!.qid!)!, cfg);
    works.set(w.sourceKey, w);
  }
  if (works.size === 0) return { kind: "none" };
  if (works.size === 1) return { kind: "match", work: [...works.values()][0]!, method: "search" };
  return { kind: "ambiguous", works: [...works.values()], method: "search" };
}
