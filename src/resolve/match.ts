import type { ExtractConfig } from "./config.ts";
import type { WorkCandidate, Media } from "./types.ts";
import type { PageInfo, EntityInfo } from "./sources/wikipedia.ts";
import { matchKey } from "./normalize.ts";
import { suffixTag } from "./markers.ts";

// 照会結果から作品を決める（純粋関数）。取りこぼしより誤同定のほうが害が大きいので、
// 区間の照合キーが作品名（原題・英題・別名）のどれかと完全に一致したときだけ採用する。

export type MatchResult =
  /** weak: 原題（Annict の作品名・AniList の native）ではなく、英題・ローマ字だけで一致した */
  | { kind: "match"; work: WorkCandidate; method: string; weak?: boolean }
  | { kind: "ambiguous"; works: WorkCandidate[]; method: string }
  | { kind: "none"; note?: string };

const MOVIE_HINT = /劇場版|映画|the ?movie|ムービー/i;

/**
 * アニメのDB（Annict・AniList）の候補として使えるか。
 * 種別が無い作品（Annict の OTHER、AniList の MUSIC など）と、放送年が無い作品（未公開の企画）には同定しない。
 * 例: Annict の「原神」（アニメ化企画。ゲームのミラー配信が当たっていた）、AniList の「ただいま。」（音楽作品）
 */
export function usableAnimeCandidate(c: WorkCandidate): boolean {
  if (c.source === "wikidata") return true;
  return c.media !== null && c.releaseYear !== null;
}

/**
 * 英数字だけの短い区間（4文字以下）はアニメのDBで同定しない。
 * 「Fate」「Zero」「SP」「REC」のような一般語・略称が、同名の無関係なアニメに一致してしまうため。
 */
export function isShortLatin(key: string): boolean {
  return /^[a-z0-9]{1,4}$/.test(key);
}

/**
 * 候補のうち、作品名が区間と完全一致するものを選ぶ。
 * 同名の作品が複数あるとき（リメイク・テレビと劇場版など）は、タイトルに「劇場版・映画」があれば映画、無ければテレビを選ぶ。
 * それでも1つに決まらなければ ambiguous（誤同定するより unresolved に回す）。
 */
/** 作品名の末尾の公開年（「(2020)」「(2020年版)」「(2020年)」。照合キーでは括弧が落ちている） */
const YEAR_SUFFIX = /^(19|20)\d{2}(年版|年)?$/;
/** リメイクの作品名の末尾（年のあとに分割の表記が付くもの。「BASTARD!! -暗黒の破壊神- (2022) part1」） */
const REMAKE_SUFFIX = /^(19|20)\d{2}(年版|年)?(part\d+|season\d+)?$/;

export function matchByTitle(key: string, candidates: WorkCandidate[], hintText: string, cfg: ExtractConfig): MatchResult {
  const uniq = new Map<string, WorkCandidate>();
  for (const w of candidates) if (!uniq.has(w.sourceKey)) uniq.set(w.sourceKey, w);
  const all = [...uniq.values()];
  const keys = (w: WorkCandidate) => w.titles.map((t) => matchKey(t, cfg));
  // 原題（titles[0]）での一致を優先し、英題・ローマ字だけの一致は弱い根拠として印を付ける。
  // Annict は1期の英題がシリーズの総称になっている（「Fate/Zero 1stシーズン」の英題が「Fate/Zero」）
  const primary = (w: WorkCandidate) => (w.titles[0] ? matchKey(w.titles[0], cfg) : "");
  let equal = all.filter((w) => keys(w).includes(key));
  const strong = equal.filter((w) => primary(w) === key);
  let weak = equal.length > 0 && strong.length === 0;
  if (strong.length > 0) equal = strong;
  let method = "exact";

  // 区間の末尾に公開年が付いている（「ダイの大冒険(2020)」）: 年を外した作品名で照合し、公開年で選ぶ
  const ym = key.match(/^(.+?)((?:19|20)\d{2})$/);
  if (equal.length === 0 && ym) {
    const [, base, yearStr] = ym;
    const year = Number(yearStr);
    const byYear = (ks: string[]) => ks.some((k) => k === base || YEAR_SUFFIX.test(k.slice(base!.length)) && k.startsWith(base!));
    equal = all.filter((w) => byYear(keys(w)) && w.releaseYear === year);
    weak = equal.length > 0 && !equal.some((w) => byYear([primary(w)]));
    method = "exact+year";
  }
  if (equal.length === 0) return { kind: "none" };

  // リメイク: 「X」で当たっても、年付きの同名作品（「X (2020)」）が別にあれば、どちらか決められない
  if (method === "exact") {
    const remakes = all.filter(
      (w) => !equal.includes(w) && keys(w).some((k) => k.startsWith(key) && REMAKE_SUFFIX.test(k.slice(key.length))),
    );
    if (remakes.length > 0) return { kind: "ambiguous", works: [...equal, ...remakes], method: "remake" };
  }

  const w8 = weak ? { weak: true } : {};
  if (equal.length === 1) return { kind: "match", work: equal[0]!, method, ...w8 };
  const want: Media = MOVIE_HINT.test(hintText) ? "movie" : "tv";
  const byMedia = equal.filter((w) => w.media === want);
  if (byMedia.length === 1) return { kind: "match", work: byMedia[0]!, method: `${method}+${want}`, ...w8 };
  return { kind: "ambiguous", works: equal, method };
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
    isAnime: e.p31.some((c) => cfg.wikipedia.anime_classes.includes(c)),
    ...(liveSeasonSeries(e, cfg) ? { liveSeasonOf: liveSeasonSeries(e, cfg)! } : {}),
  };
}

/** 実写のシーズンの項目なら、所属するシリーズの QID（付け替え先）。そうでなければ null */
export function liveSeasonSeries(e: EntityInfo, cfg: ExtractConfig): string | null {
  const seasons = cfg.wikipedia.live_season_classes ?? [];
  if (!e.series || !e.p31.some((c) => seasons.includes(c))) return null;
  if (e.p31.some((c) => cfg.wikipedia.anime_classes.includes(c))) return null;
  return e.series;
}

/** Wikipedia に記事の無い Wikidata の作品（ラベルの完全一致で見つけたもの） */
export function labelCandidate(e: EntityInfo, cfg: ExtractConfig): WorkCandidate {
  return wikidataCandidate({ query: e.labelJa ?? e.qid, title: null, qid: e.qid, missing: false, disambiguation: false, redirected: false, fragment: false }, e, cfg);
}

/**
 * 区間の照合キーに期の表記を足した作品名の候補（「ウマ娘プリティーダービー」+「season2」→ Season 2 の作品）。
 * 期のタグ（s2・final・after など）ごとに、候補の作品名のうち「区間 + 期の表記」と一致するものを集める。
 * タイトルに期の表記がある枠だけが使う（照会結果はタイトルによらず区間ごとに持つため、ここではタグごとに全部持つ）
 */
export function seasonVariants(key: string, candidates: WorkCandidate[], cfg: ExtractConfig): Map<string, WorkCandidate[]> {
  const out = new Map<string, WorkCandidate[]>();
  for (const w of candidates) {
    // 原題だけで見る（Annict の英題・ローマ字は期の表記が当てにならない）
    for (const t of w.titles.slice(0, 1)) {
      const k = matchKey(t, cfg);
      if (k.length <= key.length || !k.startsWith(key)) continue;
      const tag = suffixTag(k.slice(key.length), cfg);
      if (!tag) continue;
      const list = out.get(tag) ?? [];
      if (!list.some((x) => x.sourceKey === w.sourceKey)) list.push(w);
      out.set(tag, list);
    }
  }
  return out;
}

/** Wikipedia で試す記事名（区間そのもの・曖昧さ回避の接尾辞付き・「(曖昧さ回避)」の記事） */
export function wikipediaTitlesFor(text: string, cfg: ExtractConfig): string[] {
  return [text, ...cfg.wikipedia.title_suffixes.map((s) => `${text}${s}`), `${text} (曖昧さ回避)`];
}

const FILM_SUFFIX = " (映画)";

/** 同名の記事が複数ある（区間の記事が曖昧さ回避ページ、または「区間 (曖昧さ回避)」の記事がある） */
export function hasDisambiguation(text: string, pages: Map<string, PageInfo>): boolean {
  const exact = pages.get(text);
  const dab = pages.get(`${text} (曖昧さ回避)`);
  return !!exact?.disambiguation || (!!dab && !dab.missing);
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
      const w = wikidataCandidate(p!, entities.get(p!.qid!)!, cfg);
      // 同名の記事が複数あるとき、「(映画)」以外の接尾辞の記事では決めない（「スパイダーマン (テレビドラマ)」は1978年の東映版）。
      // 「X (映画)」は Wikipedia の慣例で同名の映画が1本のときの記事名（複数あれば「X (2002年の映画)」）なので、映画の中では一意
      if (suffix !== FILM_SUFFIX && hasDisambiguation(text, pages)) return { kind: "ambiguous", works: [w], method: "suffix+disambiguation" };
      return { kind: "match", work: w, method: "suffix" };
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
  disambiguated: Set<string> = new Set(),
): MatchResult {
  const works = new Map<string, WorkCandidate>();
  let qualified = false;
  for (const t of titles) {
    if (matchKey(baseTitle(t), cfg) !== key) continue;
    const p = pages.get(t);
    if (!isWorkPage(p, entities, cfg)) continue;
    const w = wikidataCandidate(p!, entities.get(p!.qid!)!, cfg);
    works.set(w.sourceKey, w);
    // 「スパイダーマン (東映)」のような限定の括弧付き記事で、同名の曖昧さ回避ページがある（「X (映画)」は映画の中で一意なので除く）
    if (baseTitle(t) !== t && !t.endsWith(FILM_SUFFIX) && disambiguated.has(baseTitle(t))) qualified = true;
  }
  if (works.size === 0) return { kind: "none" };
  if (works.size === 1 && !qualified) return { kind: "match", work: [...works.values()][0]!, method: "search" };
  return { kind: "ambiguous", works: [...works.values()], method: qualified ? "search+disambiguation" : "search" };
}

const SEASON_MONTH: Record<string, number> = { winter: 1, spring: 4, summer: 7, autumn: 10 };

/** 作品の放送開始の目安（放送期の最初の月の1日）。放送期が分からなければ null */
export function releaseStart(w: WorkCandidate): number | null {
  const m = w.seasonName?.match(/^(\d{4})-(winter|spring|summer|autumn)$/);
  if (!m) return null;
  return Date.UTC(Number(m[1]), SEASON_MONTH[m[2]!]! - 1, 1);
}
