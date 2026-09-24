import type { Ctx } from "../lib/context.ts";
import { runStep } from "../lib/context.ts";
import { activeEventSql, farFutureCutoff } from "../lib/events.ts";
import { tx } from "../lib/db.ts";
import { log, errorMessage } from "../lib/log.ts";
import type { ExtractConfig } from "./config.ts";
import { loadExtractConfig } from "./config.ts";
import type { Extracted, Segment, EpisodeRef } from "./extract.ts";
import { extract, extractFromDescription } from "./extract.ts";
import { matchKey } from "./normalize.ts";
import type { MatchResult } from "./match.ts";
import { matchByTitle, decideWikipedia, decideWikipediaSearch, wikipediaTitlesFor, usableAnimeCandidate, isShortLatin, baseTitle } from "./match.ts";
import { ResolveCache } from "./cache.ts";
import { AnnictClient } from "./sources/annict.ts";
import type { AnnictEpisode } from "./sources/annict.ts";
import { AniListClient } from "./sources/anilist.ts";
import { WikipediaClient } from "./sources/wikipedia.ts";
import type { WorkCandidate, UnresolvedReason } from "./types.ts";
import type { EventWorkRow } from "./store.ts";
import { upsertWork, mergeWorks, getOrCreateEpisode, replaceEventWorks, markUnresolved, markResolved } from "./store.ts";

// 名寄せの本体。
//
//   照会は枠ごとの「段」の順（括弧の中身 → 括弧の外の区間 → 小区間 → 概要欄）に、全枠まとめて行う。
//   前の段で作品が決まった枠の後の段は照会しない。
//   1つの区間は Annict → AniList → Wikipedia の記事名 → Wikipedia の全文検索 の順に、前で決まらなかったときだけ次へ
//   保存:   EventWork（話数があれば話ごと）/ Unresolved（理由付き）
//   補完:   Annict で同定した作品に AniList の ID と画像URLを付ける（MyAnimeList の ID で引く）

export type ResolveMode = "new" | "all" | "reason" | "videos";

export interface ResolveOptions {
  mode: ResolveMode;
  reason?: UnresolvedReason;
  videoIds?: string[];
  limit?: number;
}

interface Target {
  id: number;
  video_id: string;
  title_raw: string;
  description_raw: string | null;
  started_at: string | null;
}

export type Outcome = MatchResult & { source?: string; error?: string };

/** 確度。照会先と一致のしかたで決める（小区間・概要欄は下げる） */
const CONFIDENCE: Record<string, number> = {
  "annict:exact": 1.0,
  "anilist:exact": 0.95,
  "wikipedia:exact": 0.9,
  "wikipedia:redirect": 0.85,
  "wikipedia:suffix": 0.85,
  "wikipedia:search": 0.8,
};

function confidenceOf(method: string, from: Segment["from"] | "sub"): number {
  const base = CONFIDENCE[method.replace(/\+.*$/, "")] ?? 0.8;
  const tiebreak = method.includes("+") ? 0.9 : 1;
  const place = from === "sub" ? 0.85 : from === "description" ? 0.85 : 1;
  return Math.round(base * tiebreak * place * 100) / 100;
}

/**
 * Annict・AniList の検索語。区間そのもの（先頭）と、表記ゆれ用の先頭の語・先頭4文字。
 * Annict は部分一致、AniList はあいまい検索だが表記ゆれ（「Season3」と「Season 3」など）に弱いため。
 * 表記ゆれ用の検索語は、区間そのままで一致しなかったときだけ使う（照会量を抑える）。
 * 検索語を広げても、採用するのは作品名が区間と完全一致したものだけ。
 */
function searchQueries(text: string): string[] {
  const qs = [text];
  const first = text.split(/\s+/)[0] ?? "";
  if (first !== text && [...first].length >= 2) qs.push(first);
  const chars = [...text.replace(/\s+/g, "")];
  if (!/\s/.test(text) && chars.length > 6) qs.push(chars.slice(0, 4).join(""));
  return [...new Set(qs)];
}

class Resolver {
  private readonly ctx: Ctx;
  private readonly cfg: ExtractConfig;
  readonly cache: ResolveCache;
  readonly annict: AnnictClient | null;
  readonly anilist: AniListClient;
  readonly wikipedia: WikipediaClient;
  readonly errors: string[] = [];

  constructor(ctx: Ctx, cfg: ExtractConfig) {
    this.ctx = ctx;
    this.cfg = cfg;
    this.cache = new ResolveCache(ctx.db, 30);
    const token = process.env.ANNICT_TOKEN;
    this.annict = token ? new AnnictClient(ctx.http, this.cache, token, cfg.annict) : null;
    if (!token) log.warn("ANNICT_TOKEN が未設定のため Annict を使わずに名寄せします（AniList・Wikipedia のみ）");
    this.anilist = new AniListClient(ctx.http, this.cache, cfg.anilist);
    this.wikipedia = new WikipediaClient(ctx.http, this.cache);
  }

  /** 照会に失敗した Wikidata の項目を参照しているか（そうなら「照会エラー」にして次回に回す） */
  private touchesFailed(titles: string[], pages: Map<string, import("./sources/wikipedia.ts").PageInfo>): boolean {
    return titles.some((t) => {
      const q = pages.get(t)?.qid;
      return !!q && this.wikipedia.failedQids.has(q);
    });
  }

  /** 区間の文字列ごとに作品を決める。hint は「劇場版」の有無を見るための元のタイトル */
  async resolveTexts(texts: Map<string, string>, useSearch: boolean): Promise<Map<string, Outcome>> {
    const out = new Map<string, Outcome>();
    const keyOf = new Map([...texts.keys()].map((t) => [t, matchKey(t, this.cfg)]));
    const pending = () => [...texts.keys()].filter((t) => !out.has(t));
    const stageError = new Map<string, string>();

    // Annict → AniList。まず区間そのままで照会し、一致しなかった区間だけ表記ゆれ用の検索語を足して照会し直す
    const stages: { name: string; search: ((qs: string[]) => Promise<Map<string, WorkCandidate[]>>) | null }[] = [
      { name: "annict", search: this.annict ? (qs) => this.annict!.search(qs) : null },
      { name: "anilist", search: (qs) => this.anilist.search(qs) },
    ];
    for (const stage of stages) {
      // 英数字だけの短い区間はアニメのDBでは同定しない（照会もしない）
      const ts = pending().filter((t) => !isShortLatin(keyOf.get(t)!));
      if (!stage.search || ts.length === 0) continue;
      try {
        const first = await stage.search(ts);
        const retry: string[] = [];
        for (const t of ts) {
          const r = matchByTitle(keyOf.get(t)!, (first.get(t) ?? []).filter(usableAnimeCandidate), texts.get(t)!, this.cfg);
          if (r.kind !== "none") out.set(t, { ...r, source: stage.name });
          else if (searchQueries(t).length > 1) retry.push(t);
        }
        if (retry.length) {
          const extra = new Map(retry.map((t) => [t, searchQueries(t).slice(1)]));
          const second = await stage.search([...extra.values()].flat());
          for (const t of retry) {
            const cands = [...(first.get(t) ?? []), ...extra.get(t)!.flatMap((q) => second.get(q) ?? [])].filter(usableAnimeCandidate);
            const r = matchByTitle(keyOf.get(t)!, cands, texts.get(t)!, this.cfg);
            if (r.kind !== "none") out.set(t, { ...r, source: stage.name });
          }
        }
      } catch (e) {
        this.errors.push(`${stage.name}: ${errorMessage(e)}`);
        for (const t of ts) if (!out.has(t)) stageError.set(t, `${stage.name}: ${errorMessage(e)}`);
      }
    }

    // アニメのDBで当たった区間も Wikipedia で照合する。同名で公開年が2年以上離れた作品（実写映画など）があれば決めない
    // （「シャザム！」が Annict の1990年のテレビ作品に当たっていた）
    const animeMatched = [...out.entries()].filter(([, o]) => o.kind === "match" && o.source !== "wikipedia").map(([t]) => t);
    if (animeMatched.length) {
      try {
        const pages = await this.wikipedia.pages(animeMatched.flatMap((t) => wikipediaTitlesFor(t, this.cfg)));
        const ents = await this.wikipedia.entities([...pages.values()].map((p) => p.qid).filter((q): q is string => !!q));
        for (const t of animeMatched) {
          const o = out.get(t)!;
          if (o.kind !== "match") continue;
          const w = decideWikipedia(t, pages, ents, this.cfg);
          if (w.kind !== "match") continue;
          // 照合の相手はアニメ以外の作品（実写映画など）だけ。アニメの記事は同じ作品の別の粒度（シリーズ全体など）のことが多い
          const p31 = ents.get(w.work.wikidataId ?? "")?.p31 ?? [];
          if (p31.some((c) => this.cfg.wikipedia.anime_classes.includes(c))) continue;
          const a = o.work.releaseYear;
          const b = w.work.releaseYear;
          // 同名のアニメ以外の作品（実写映画など）と、公開年が1年以上違うか種別（テレビ/映画）が違えば別作品の可能性がある
          // （『カラオケ行こ！』は2024年の実写映画と2025年のアニメ）
          if ((a && b && Math.abs(a - b) >= 1) || (o.work.media && w.work.media && o.work.media !== w.work.media)) {
            out.set(t, { kind: "ambiguous", works: [o.work, w.work], method: "同名の別作品（公開年が違う）", source: o.source });
          }
        }
      } catch (e) {
        this.errors.push(`wikipedia cross-check: ${errorMessage(e)}`);
      }
    }

    // Wikipedia の記事名 → Wikidata
    const wpNotes = new Map<string, string>();
    if (pending().length) {
      const ts = pending();
      try {
        const pages = await this.wikipedia.pages(ts.flatMap((t) => wikipediaTitlesFor(t, this.cfg)));
        const ents = await this.wikipedia.entities([...pages.values()].map((p) => p.qid).filter((q): q is string => !!q));
        for (const t of ts) {
          const r = decideWikipedia(t, pages, ents, this.cfg);
          if (r.kind !== "none") out.set(t, { ...r, source: "wikipedia" });
          else if (wikipediaTitlesFor(t, this.cfg).some((x) => this.wikipedia.failedTitles.has(x))) stageError.set(t, "wikipedia: 照会エラー");
          else if (this.touchesFailed(wikipediaTitlesFor(t, this.cfg), pages)) stageError.set(t, "wikidata: 一時的なエラー");
          else if (r.note) wpNotes.set(t, r.note);
        }
      } catch (e) {
        this.errors.push(`wikipedia: ${errorMessage(e)}`);
        for (const t of ts) stageError.set(t, `wikipedia: ${errorMessage(e)}`);
      }
    }

    // Wikipedia の全文検索（記事名が表記ゆれで一致しないもの）
    if (useSearch && pending().length) {
      const ts = pending().filter((t) => keyOf.get(t)!.length >= 3);
      try {
        const found = new Map<string, string[]>();
        for (const t of ts) {
          // 1語の検索が落ちても他の語は続ける（落ちた語だけ「照会エラー」にして次回に回す）
          try {
            found.set(t, await this.wikipedia.search(t));
          } catch (e) {
            stageError.set(t, `wikipedia search: ${errorMessage(e)}`);
          }
        }
        // 検索で当たりうる記事と、その括弧を外した記事・「(曖昧さ回避)」の記事も引く。
        // 「スパイダーマン (東映)」のような限定の括弧付き記事は、同名の曖昧さ回避ページがあれば決めない
        const hitTitles = [...found.values()].flat();
        const bases = [...new Set(hitTitles.filter((x) => baseTitle(x) !== x).map(baseTitle))];
        const pages = await this.wikipedia.pages([...hitTitles, ...bases, ...bases.map((b) => `${b} (曖昧さ回避)`)]);
        const ents = await this.wikipedia.entities([...pages.values()].map((p) => p.qid).filter((q): q is string => !!q));
        const disambiguated = new Set(
          bases.filter((b) => pages.get(b)?.disambiguation || (pages.get(`${b} (曖昧さ回避)`) && !pages.get(`${b} (曖昧さ回避)`)!.missing)),
        );
        for (const t of ts) {
          const r = decideWikipediaSearch(keyOf.get(t)!, found.get(t) ?? [], pages, ents, this.cfg, disambiguated);
          if (r.kind !== "none") out.set(t, { ...r, source: "wikipedia" });
          else if ((found.get(t) ?? []).some((x) => this.wikipedia.failedTitles.has(x))) stageError.set(t, "wikipedia: 照会エラー");
          else if (this.touchesFailed(found.get(t) ?? [], pages)) stageError.set(t, "wikidata: 一時的なエラー");
        }
      } catch (e) {
        this.errors.push(`wikipedia search: ${errorMessage(e)}`);
        for (const t of ts) stageError.set(t, `wikipedia search: ${errorMessage(e)}`);
      }
    }

    for (const t of texts.keys()) {
      if (out.has(t)) continue;
      const err = stageError.get(t);
      out.set(t, err ? { kind: "none", error: err } : { kind: "none", note: wpNotes.get(t) });
    }
    return out;
  }
}

function loadTargets(ctx: Ctx, opts: ResolveOptions): Target[] {
  const cutoff = farFutureCutoff(ctx.crawlCfg.upcoming.max_days_ahead);
  const base = `SELECT e.id, e.video_id, e.title_raw, e.description_raw, e.started_at FROM watch_events e
    LEFT JOIN event_resolution er ON er.watch_event_id = e.id
    LEFT JOIN unresolved u ON u.watch_event_id = e.id AND u.resolved_at IS NULL
    WHERE ${activeEventSql("e")}`;
  let sql: string;
  const params: (string | number)[] = [cutoff];
  switch (opts.mode) {
    case "new":
      // 未処理の枠と、前回照会エラーだった枠
      sql = `${base} AND (er.watch_event_id IS NULL OR u.reason = 'error')`;
      break;
    case "all":
      sql = base;
      break;
    case "reason":
      sql = `${base} AND u.reason = ?`;
      params.push(opts.reason ?? "not_found");
      break;
    case "videos": {
      const ids = opts.videoIds ?? [];
      sql = `${base} AND e.video_id IN (${ids.map(() => "?").join(",") || "''"})`;
      params.push(...ids);
      break;
    }
  }
  sql += " ORDER BY e.id";
  if (opts.limit) sql += ` LIMIT ${Math.floor(opts.limit)}`;
  return ctx.db.prepare(sql).all(...params) as unknown as Target[];
}

export interface ResolveStats {
  targets: number;
  resolved: number;
  unresolved: Record<UnresolvedReason, number>;
  event_works: number;
  multi_work_events: number;
  episodes_linked: number;
  works_total: number;
  works_removed: number;
  images_linked: number;
  requests: Record<string, number>;
  cache: { hits: number; misses: number };
  source_errors: string[];
  rule_version: string;
}

/** pick の中で照合キーを作るための設定。resolveEvents が差し込む */
let planCfg: ExtractConfig | null = null;
function cfgOf(_plan: Plan): ExtractConfig {
  if (!planCfg) planCfg = loadExtractConfig();
  return planCfg;
}

export interface Plan {
  target: Target;
  ex: Extracted;
  desc: Segment[];
}

interface Picked {
  work: WorkCandidate;
  method: string;
  from: Segment["from"] | "sub";
  text: string;
}

/**
 * 枠ごとの候補の段。前の段で作品が決まれば、後の段は照会もしないし採用もしない。
 *   0: 括弧（『』「」など）の中身
 *   1: 括弧の外の区間（括弧の中身が無い枠では最初の段）
 *   2: 小区間（「！」「＆」「/」で分けたもの）
 *   3: 概要欄のその枠を指す行の括弧の中身
 * 括弧で作品が決まった枠では、括弧の外の区間（「王覇山軍」「ぺこ」など配信者の決まり文句）を照会も採用もしない。
 */
interface TierItem {
  text: string;
  from: Picked["from"];
  /** 小区間の分け方。multi は複数作品になりうる、alt は同じ作品の言い換え */
  kind?: "multi" | "alt";
  /** 小区間の元の区間 */
  parent?: string;
}

function tiers(plan: Plan): TierItem[][] {
  const quote = plan.ex.segments.filter((s) => s.from === "quote");
  const title = plan.ex.segments.filter((s) => s.from !== "quote");
  return [
    quote.map((s) => ({ text: s.text, from: s.from })),
    title.map((s) => ({ text: s.text, from: s.from })),
    plan.ex.segments.flatMap((s) => s.subs.map((x) => ({ text: x.text, from: "sub" as const, kind: x.kind, parent: s.text }))),
    plan.desc.map((s) => ({ text: s.text, from: "description" as const })),
  ];
}

const MOVIE_WORDS = /劇場版|映画|the ?movie/i;

/** 映画の枠かどうか。「※映画のネタバレ禁止」のような注意書きの中の「映画」は見ない */
export function looksLikeMovieEvent(title: string): boolean {
  const body = title.replace(/[※＊*][^【】〖〗]*/g, "").replace(/(劇場版|映画)の?ネタバレ/g, "");
  return MOVIE_WORDS.test(body);
}

const SEASON_MONTH: Record<string, number> = { winter: 1, spring: 4, summer: 7, autumn: 10 };

/** 作品の放送開始の目安（放送期の最初の月の1日）。放送期が分からなければ null */
export function releaseStart(w: WorkCandidate): number | null {
  const m = w.seasonName?.match(/^(\d{4})-(winter|spring|summer|autumn)$/);
  if (!m) return null;
  return Date.UTC(Number(m[1]), SEASON_MONTH[m[2]!]! - 1, 1);
}

export function pick(
  plan: Plan,
  outcomes: Map<string, Outcome>,
  seasonQualifiers: RegExp[] = [],
): { picked: Picked[]; ambiguous: Outcome[]; errors: string[]; notes: Record<string, string> } {
  const ambiguous: Outcome[] = [];
  const errors: string[] = [];
  const notes: Record<string, string> = {};
  const eventYear = plan.target.started_at ? Number(plan.target.started_at.slice(0, 4)) : null;
  const maxEpisode = plan.ex.episodes.length ? Math.max(...plan.ex.episodes.map((e) => e.number)) : null;
  // 同じタイトルに、期・続編だけを示す区間があるか（「二期」「The Final Season」など）
  const allTexts = plan.ex.segments.flatMap((s) => [s.text, ...s.subs.map((x) => x.text)]);
  const seasonHint = allTexts.find((t) => seasonQualifiers.some((re) => re.test(t.normalize("NFKC").toLowerCase().replace(/[\s!！?？・:：\-]/g, ""))));
  const reject = (text: string, w: WorkCandidate, why: string) => {
    notes[text] = `${why}: ${w.title}`;
    ambiguous.push({ kind: "ambiguous", works: [w], method: why });
  };
  const list = tiers(plan);
  for (let k = 0; k < list.length; k++) {
    const picked = new Map<string, Picked>();
    const altTaken = new Set<string>();
    for (const item of list[k]!) {
      const { text, from } = item;
      const o = outcomes.get(text);
      if (!o) continue;
      if (o.kind === "match") {
        const w = o.work;
        // 枠より後に公開された作品は観られない（リメイク・別シーズンの取り違え）。
        // 放送期（2025-summer など）が分かれば月まで見る。先行上映があるので1か月の余裕を残す
        if (eventYear && w.releaseYear && w.releaseYear > eventYear) { reject(text, w, `公開年${w.releaseYear}が枠の年${eventYear}より後`); continue; }
        const start = releaseStart(w);
        if (start && plan.target.started_at && Date.parse(plan.target.started_at) < start - 31 * 86_400_000) {
          reject(text, w, `放送期${w.seasonName}より前の枠`);
          continue;
        }
        // 期・続編を示す区間があるのに、シリーズ名だけの区間で当たった（その区間自身が期を含むなら問題ない）
        if (seasonHint && seasonHint !== text && !text.includes(seasonHint)) { reject(text, w, `別の期の可能性（「${seasonHint}」）`); continue; }
        // 話数が作品の話数を超えている（別の期・通し番号）
        if (maxEpisode && w.episodesCount && w.media !== "movie" && maxEpisode > w.episodesCount) { reject(text, w, `話数${maxEpisode}が作品の話数${w.episodesCount}を超える`); continue; }
        // タイトルに「映画・劇場版」があるのにテレビ作品に当たった
        if (looksLikeMovieEvent(plan.target.title_raw) && w.media === "tv") { reject(text, w, "映画の枠がテレビ作品に当たった"); continue; }
        // 舞台版は外部作品DBに無いので、どの作品にも同定しない（「舞台「鬼滅の刃」」がアニメ1期に当たっていた）
        if (/舞台/.test(plan.target.title_raw)) { reject(text, w, "舞台の枠"); continue; }
        // タイトルに「実写」があるのにアニメのDBの作品に当たった（「魔女の宅急便（実写）」が1989年のアニメ映画に当たっていた）
        if (/実写/.test(plan.target.title_raw) && w.source !== "wikidata") { reject(text, w, "実写の枠がアニメ作品に当たった"); continue; }
        // 言い換えの小区間（「！」や和英併記で分けたもの）は、同じ元の区間から最初に当たった1つだけ
        if (item.kind === "alt" && item.parent) {
          if (altTaken.has(item.parent)) continue;
          altTaken.add(item.parent);
        }
        if (!picked.has(w.sourceKey)) picked.set(w.sourceKey, { work: w, method: `${o.source}:${o.method}`, from, text });
      } else if (o.kind === "ambiguous") {
        // アニメのテレビ作品と同名の実写作品が並んだとき、話数付きの枠ならアニメのシリーズを選ぶ（「ゴールデンカムイ 8話から」）
        const series = o.works.filter((w) => w.source !== "wikidata" && w.media !== "movie");
        if (o.method === "同名の別作品（公開年が違う）" && plan.ex.episodes.length > 0 && series.length === 1) {
          const w = series[0]!;
          if (!picked.has(w.sourceKey)) picked.set(w.sourceKey, { work: w, method: `${o.source}:exact+episodes`, from, text });
        } else ambiguous.push(o);
      } else {
        if (o.error) errors.push(o.error);
        if (o.note) notes[text] = o.note;
      }
    }
    if (picked.size === 0) continue;
    let ps = [...picked.values()];
    // 括弧の外の区間で、短い区間（照合キー4文字以下）だけが当たり、同じ段にもっと長い区間がある。
    // 決まり文句の短い語が同名の作品に当たっている可能性が高い（「劇場版のZガンダム…3作目！！！ラスト！」の「ラスト」）
    // 小区間の段では、言い換えの小区間（「！」などで分けたもの）だけが対象。「＆」で分けた複数作品（「ギャバン」）は対象外
    if (k === 1 || k === 2) {
      const keyLen = (t: string) => matchKey(t, cfgOf(plan)).length;
      const items = list[k]!;
      const longest = Math.max(...items.map((x) => keyLen(x.text)), ...items.map((x) => (x.parent ? keyLen(x.parent) : 0)));
      const isAltOrTitle = (p: Picked) => k === 1 || items.some((x) => x.text === p.text && x.kind === "alt");
      const short = ps.filter((p) => isAltOrTitle(p) && keyLen(p.text) <= 4 && longest > keyLen(p.text) * 2);
      for (const p of short) reject(p.text, p.work, "短い区間がより長い区間を差し置いて当たった");
      ps = ps.filter((p) => !short.includes(p));
      if (ps.length === 0) continue;
    }
    // 括弧の外の区間で別々の作品が当たったら決めない（長さや位置では選ばない。「R2」と英題の「1期」が並ぶ例があった）
    if (k === 1 && new Set(ps.map((p) => p.text)).size > 1) {
      ambiguous.push({ kind: "ambiguous", works: ps.map((p) => p.work), method: "複数の区間が別々の作品に当たった" });
      return { picked: [], ambiguous, errors, notes };
    }
    return { picked: ps, ambiguous, errors, notes };
  }
  return { picked: [], ambiguous, errors, notes };
}

export async function resolveEvents(ctx: Ctx, opts: ResolveOptions): Promise<ResolveStats> {
  const cfg = loadExtractConfig();
  const r = new Resolver(ctx, cfg);
  const targets = loadTargets(ctx, opts);
  log.info(`名寄せ対象 ${targets.length} 件（mode=${opts.mode}, rule=${cfg.version}）`);
  const selfWords = ctx.detectCfg.description.line_require;

  const plans: Plan[] = targets.map((t) => ({
    target: t,
    ex: extract(t.title_raw, cfg),
    desc: t.description_raw ? extractFromDescription(t.description_raw, selfWords, cfg) : [],
  }));

  // 段ごとにまとめて照会する。前の段で作品が決まった枠の、後の段の区間は照会しない
  const outcomes = new Map<string, Outcome>();
  const decided = (p: Plan, upTo: number) =>
    tiers(p).slice(0, upTo).some((tier) => tier.some(({ text }) => outcomes.get(text)?.kind === "match"));
  const TIER_NAMES = ["括弧の中身", "括弧の外の区間", "小区間", "概要欄"];
  for (let k = 0; k < 4; k++) {
    const texts = new Map<string, string>();
    for (const p of plans) {
      if (p.ex.notAWork || decided(p, k)) continue;
      for (const { text } of tiers(p)[k]!) if (!outcomes.has(text)) texts.set(text, p.target.title_raw);
    }
    log.info(`${k + 1}段目の照会（${TIER_NAMES[k]}）: ${texts.size} 件`);
    if (texts.size === 0) continue;
    // 全文検索は重いので、括弧の中身と区間の段だけで使う
    for (const [t, o] of await r.resolveTexts(texts, k <= 1)) outcomes.set(t, o);
  }

  // 話数を紐付けるテレビ作品の話の一覧（Annict）
  const seasonQualifiers = cfg.season_qualifiers.map((x) => new RegExp(x));
  const decisions = plans.map((p) => ({ plan: p, ...pick(p, outcomes, seasonQualifiers) }));
  const annictEpisodes = new Map<number, AnnictEpisode[]>();
  if (r.annict) {
    const ids = decisions
      .filter((d) => d.picked.length === 1 && d.plan.ex.episodes.length > 0 && d.picked[0]!.work.annictId && d.picked[0]!.work.media !== "movie")
      .map((d) => d.picked[0]!.work.annictId!);
    try {
      for (const [id, eps] of await r.annict.episodes(ids)) annictEpisodes.set(id, eps);
    } catch (e) {
      r.errors.push(`annict episodes: ${errorMessage(e)}`);
    }
  }

  const stats: ResolveStats = {
    targets: targets.length, resolved: 0,
    unresolved: { no_candidate: 0, not_found: 0, ambiguous: 0, not_a_work: 0, error: 0 },
    event_works: 0, multi_work_events: 0, episodes_linked: 0, works_total: 0, works_removed: 0, images_linked: 0,
    requests: {}, cache: { hits: 0, misses: 0 }, source_errors: [], rule_version: cfg.version,
  };

  tx(ctx.db, () => {
    for (const d of decisions) {
      const { plan } = d;
      const ev = plan.target.id;
      const segTexts = plan.ex.segments.map((s) => s.text);
      const shown = segTexts.join(" / ") || plan.ex.cleaned || null;
      if (plan.ex.notAWork) {
        markUnresolved(ctx.db, ev, "not_a_work", plan.ex.notAWork, { cleaned: plan.ex.cleaned, segments: segTexts }, cfg.version);
        stats.unresolved.not_a_work++;
        continue;
      }
      if (d.picked.length === 0) {
        let reason: UnresolvedReason;
        if (plan.ex.segments.length === 0 && plan.desc.length === 0) reason = "no_candidate";
        else if (d.ambiguous.length > 0) reason = "ambiguous";
        else if (d.errors.length > 0) reason = "error";
        else reason = "not_found";
        const detail = {
          cleaned: plan.ex.cleaned,
          segments: segTexts,
          subs: plan.ex.segments.flatMap((s) => s.subs.map((x) => x.text)),
          description: plan.desc.map((s) => s.text),
          notes: d.notes,
          errors: d.errors,
          candidates: d.ambiguous.flatMap((o) => (o.kind === "ambiguous" ? o.works.map((w) => `${w.sourceKey} ${w.title} (${w.media ?? "?"}, ${w.releaseYear ?? "?"})`) : [])),
        };
        markUnresolved(ctx.db, ev, reason, shown, detail, cfg.version);
        stats.unresolved[reason]++;
        continue;
      }
      const rows: EventWorkRow[] = [];
      const eps: EpisodeRef[] = plan.ex.episodes;
      for (const p of d.picked) {
        const workId = upsertWork(ctx.db, p.work);
        const confidence = confidenceOf(p.method, p.from);
        // 話数は、作品が1つに決まり、映画でないときだけ紐付ける
        if (d.picked.length === 1 && eps.length > 0 && p.work.media !== "movie") {
          const list = p.work.annictId ? annictEpisodes.get(p.work.annictId) ?? [] : [];
          for (const e of eps) {
            const a = list.find((x) => x.number === e.number);
            const epId = getOrCreateEpisode(ctx.db, workId, e.number, a?.numberText ?? e.number_text, a?.title ?? null);
            rows.push({ workId, episodeId: epId, confidence, method: p.method, extractedText: p.text });
          }
          stats.episodes_linked += eps.length;
        } else {
          rows.push({ workId, episodeId: null, confidence, method: p.method, extractedText: p.text });
        }
      }
      replaceEventWorks(ctx.db, ev, rows, cfg.version);
      markResolved(ctx.db, ev, cfg.version);
      stats.resolved++;
      stats.event_works += rows.length;
      if (d.picked.length > 1) stats.multi_work_events++;
    }
  });

  // Annict で同定した作品に AniList の ID と画像を付ける
  await runStep(ctx, "resolve: AniList の画像", async () => {
    const rows = ctx.db
      // MyAnimeList の ID が複数の作品で重なっているもの（総集編の Re: と Re:Re: など）は、どの作品の画像か決められないので付けない
      .prepare(`SELECT id, mal_id FROM works WHERE anilist_id IS NULL AND mal_id IS NOT NULL
        AND mal_id IN (SELECT mal_id FROM works GROUP BY mal_id HAVING COUNT(*) = 1)`)
      .all() as { id: number; mal_id: number }[];
    if (rows.length === 0) return;
    const got = await r.anilist.byMalIds(rows.map((x) => x.mal_id));
    tx(ctx.db, () => {
      for (const w of rows) {
        const c = got.get(w.mal_id);
        if (!c) continue;
        // MyAnimeList の ID が同じ別の作品（総集編の Re: と Re:Re: など）があるので、
        // AniList の ID を別の Annict 作品がすでに持っていればまとめずに画像だけ付ける
        const other = ctx.db.prepare("SELECT id, annict_id FROM works WHERE anilist_id = ? AND id != ?").get(c.anilistId, w.id) as
          | { id: number; annict_id: number | null }
          | undefined;
        const self = ctx.db.prepare("SELECT annict_id FROM works WHERE id = ?").get(w.id) as { annict_id: number | null };
        const separate = !!other && other.annict_id !== null && self.annict_id !== null && other.annict_id !== self.annict_id;
        if (other && !separate) mergeWorks(ctx.db, w.id, other.id);
        ctx.db.prepare("UPDATE works SET anilist_id = CASE WHEN ? THEN anilist_id ELSE ? END, image_url = COALESCE(image_url, ?), updated_at = ? WHERE id = ?")
          .run(separate ? 1 : 0, c.anilistId, c.imageUrl, new Date().toISOString(), w.id);
        stats.images_linked++;
      }
    });
  });

  // どの枠にも付いていない作品（ルールを直して付け替わったもの）を消す。作品は外部DBから作り直せる派生データで、
  // 同時視聴が1件もない作品はページを作らない
  tx(ctx.db, () => {
    ctx.db.exec(`DELETE FROM episodes WHERE work_id NOT IN (SELECT DISTINCT work_id FROM event_works)`);
    const r2 = ctx.db.prepare(`DELETE FROM works WHERE id NOT IN (SELECT DISTINCT work_id FROM event_works)`).run();
    stats.works_removed = Number(r2.changes);
  });
  stats.works_total = (ctx.db.prepare("SELECT COUNT(*) AS n FROM works").get() as { n: number }).n;
  stats.requests = { annict: r.annict?.requests ?? 0, anilist: r.anilist.requests, wikipedia: r.wikipedia.requests };
  stats.cache = { hits: r.cache.hits, misses: r.cache.misses };
  stats.source_errors = [...r.errors, ...r.wikipedia.errors].map((e) => e.slice(0, 200)).slice(0, 20);
  return stats;
}
