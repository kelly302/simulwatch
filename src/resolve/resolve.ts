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
import {
  matchByTitle, decideWikipedia, wikipediaTitlesFor, usableAnimeCandidate, isShortLatin, baseTitle, decideWikipediaSearch,
  isWorkPage, wikidataCandidate, seasonVariants, workMedia, labelCandidate, releaseStart,
} from "./match.ts";
import { markersOf, workMarkers, seasonConflict } from "./markers.ts";
import type { Markers } from "./markers.ts";
import { ResolveCache } from "./cache.ts";
import { AnnictClient } from "./sources/annict.ts";
import type { AnnictEpisode } from "./sources/annict.ts";
import { AniListClient } from "./sources/anilist.ts";
import { WikipediaClient } from "./sources/wikipedia.ts";
import type { PageInfo, EntityInfo, WdSearchHit } from "./sources/wikipedia.ts";
import type { WorkCandidate, UnresolvedReason } from "./types.ts";
import type { EventWorkRow } from "./store.ts";
import { upsertWork, mergeWorks, getOrCreateEpisode, replaceEventWorks, markUnresolved, markResolved } from "./store.ts";
import { applyAiDecisions, AI_LOCKED_SQL } from "./ai.ts";
import { assignSeasons } from "./series.ts";
import type { SeriesStats } from "./series.ts";

// 名寄せの本体。
//
//   照会は枠ごとの「段」の順（括弧の中身 → 括弧の外の区間 → 小区間 → 概要欄 → ハッシュタグ）に、全枠まとめて行う。
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

/**
 * 区間ごとの照会結果。
 *   cands:    アニメのDBの候補（部の特定で、同じシリーズのほかの作品を見るのに使う）
 *   variants: 区間に期の表記を足した作品名の候補（タイトルに期の表記がある枠が使う）
 */
export type Outcome = MatchResult & {
  source?: string;
  error?: string;
  cands?: WorkCandidate[];
  variants?: Map<string, WorkCandidate[]>;
};

/** Wikidata のラベルは一致するが、同名の曖昧さ回避ページがある（枠ごとに映画の手がかりで選ぶ） */
const LABEL_DISAMBIGUATED = "Wikidata のラベルは一致するが、Wikipedia に曖昧さ回避ページがある";
/** Wikidata のラベルは一致するが、区間が一般の語（Wikipedia の同名の記事が作品・原作でない。「罰ゲーム」） */
const LABEL_COMMON_WORD = "Wikidata のラベルは一致するが、区間と同名の Wikipedia の記事が作品・原作でない";

/** 確度。照会先と一致のしかたで決める（小区間・概要欄・ハッシュタグは下げる） */
const CONFIDENCE: Record<string, number> = {
  "annict:exact": 1.0,
  "anilist:exact": 0.95,
  "wikipedia:exact": 0.9,
  "wikipedia:redirect": 0.85,
  "wikipedia:suffix": 0.85,
  "wikipedia:search": 0.8,
  "wikidata:label": 0.75,
};

function confidenceOf(method: string, from: Picked["from"]): number {
  const base = CONFIDENCE[method.replace(/\+.*$/, "")] ?? 0.8;
  const tiebreak = method.includes("+") ? 0.9 : 1;
  const place = from === "sub" || from === "description" ? 0.85 : from === "hashtag" ? 0.8 : 1;
  return Math.round(base * tiebreak * place * 100) / 100;
}

/**
 * Annict・AniList の検索語。区間そのもの（先頭）と、表記ゆれ用の先頭の語・先頭4文字・先頭3文字。
 * Annict は部分一致、AniList はあいまい検索だが表記ゆれ（「Season3」と「Season 3」、空白の有無）に弱いため。
 * 表記ゆれ用の検索語は、区間そのままで一致しなかったときだけ使う（照会量を抑える）。
 * 検索語を広げても、採用するのは作品名が区間と完全一致したものだけ。
 */
function searchQueries(text: string): string[] {
  const qs = [text];
  const first = text.split(/\s+/)[0] ?? "";
  if (first !== text && [...first].length >= 2) qs.push(first);
  const chars = [...text.replace(/\s+/g, "")];
  // 先頭3文字は、作品名の途中に空白がある（「ウマ娘 プリティーダービー」を「ウマ娘プリティーダービー」と書く）ときに効く
  if (!/\s/.test(text) && chars.length > 6) qs.push(chars.slice(0, 4).join(""), chars.slice(0, 3).join(""));
  // 「劇場版モノノ怪 唐傘」: Annict は「劇場版 モノノ怪 唐傘」。前置きを外した語で引き、照合は区間まるごとで行う
  const noMovie = text.replace(/^(?:劇場版|映画)\s*/, "");
  if (noMovie !== text && [...noMovie].length >= 2) qs.push(noMovie);
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

  /** Wikidata の検索結果のラベル（日本語）が区間と完全一致するか。別名（alias）での一致は使わない */
  private labelEquals(h: WdSearchHit, key: string): boolean {
    // 日本語のラベルだけを見る。日本語のラベルの無い項目は英語などのラベルが代わりに返る（「Movie」「cover」「TALK TO ME」が別の作品に当たっていた）
    return !!h.label && /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(h.label) && matchKey(h.label, this.cfg) === key;
  }

  /** 照会に失敗した Wikidata の項目を参照しているか（そうなら「照会エラー」にして次回に回す） */
  private touchesFailed(titles: string[], pages: Map<string, PageInfo>): boolean {
    return titles.some((t) => {
      const q = pages.get(t)?.qid;
      return !!q && this.wikipedia.failedQids.has(q);
    });
  }

  /**
   * 区間の文字列ごとに作品を決める。texts の値は「劇場版」の有無を見るための元のタイトル。
   * wp は Wikipedia の記事名で先に試す別の形（「カラオケ行こ!」）
   */
  async resolveTexts(texts: Map<string, string>, useSearch: boolean, wp: Map<string, string> = new Map()): Promise<Map<string, Outcome>> {
    const out = new Map<string, Outcome>();
    const keyOf = new Map([...texts.keys()].map((t) => [t, matchKey(t, this.cfg)]));
    const pending = () => [...texts.keys()].filter((t) => !out.has(t));
    const stageError = new Map<string, string>();
    const cands = new Map<string, WorkCandidate[]>();
    const addCands = (t: string, cs: WorkCandidate[]) => {
      const m = new Map((cands.get(t) ?? []).map((c) => [c.sourceKey, c]));
      for (const c of cs) m.set(c.sourceKey, c);
      cands.set(t, [...m.values()]);
    };

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
          const cs = (first.get(t) ?? []).filter(usableAnimeCandidate);
          addCands(t, cs);
          const r = matchByTitle(keyOf.get(t)!, cs, texts.get(t)!, this.cfg);
          if (r.kind !== "none") out.set(t, { ...r, source: stage.name });
          else if (searchQueries(t).length > 1) retry.push(t);
        }
        if (retry.length) {
          const extra = new Map(retry.map((t) => [t, searchQueries(t).slice(1)]));
          const second = await stage.search([...extra.values()].flat());
          for (const t of retry) {
            const cs = extra.get(t)!.flatMap((q) => second.get(q) ?? []).filter(usableAnimeCandidate);
            addCands(t, cs);
            const r = matchByTitle(keyOf.get(t)!, cands.get(t) ?? [], texts.get(t)!, this.cfg);
            if (r.kind !== "none") out.set(t, { ...r, source: stage.name });
          }
        }
      } catch (e) {
        this.errors.push(`${stage.name}: ${errorMessage(e)}`);
        for (const t of ts) if (!out.has(t)) stageError.set(t, `${stage.name}: ${errorMessage(e)}`);
      }
    }

    // アニメのDBで当たった区間も Wikipedia で照合する。同名のアニメ以外の作品（実写映画など）があり、
    // 公開年か種別が違えば決めない（「シャザム！」が1990年のテレビ作品に、「アラジン」が1992年のアニメ映画に当たる型）。
    // 記事名（区間そのもの・「(映画)」など）に加えて、全文検索で見つかる「X (2019年の映画)」のような記事も見る
    const animeMatched = [...out.entries()].filter(([, o]) => o.kind === "match" && o.source !== "wikipedia").map(([t]) => t);
    if (animeMatched.length) {
      try {
        const found = new Map<string, string[]>();
        for (const t of animeMatched) {
          if (keyOf.get(t)!.length < 3) continue;
          try {
            found.set(t, await this.wikipedia.search(t));
          } catch (e) {
            stageError.set(t, `wikipedia search: ${errorMessage(e)}`);
          }
        }
        const hits = [...found.values()].flat();
        const pages = await this.wikipedia.pages([...animeMatched.flatMap((t) => wikipediaTitlesFor(t, this.cfg)), ...hits]);
        // Wikipedia に記事が無い同名の作品（「亜人」の2017年の実写映画は Wikidata にしか無い）も見る
        const labels = new Map<string, string[]>();
        if (this.cfg.wikidata_label) {
          for (const t of animeMatched) {
            if (stageError.has(t) || keyOf.get(t)!.length < 2) continue;
            try {
              labels.set(t, (await this.wikipedia.searchEntities(t)).filter((h) => this.labelEquals(h, keyOf.get(t)!)).map((h) => h.id));
            } catch (e) {
              stageError.set(t, `wikidata search: ${errorMessage(e)}`);
            }
          }
        }
        const ents = await this.wikipedia.entities([
          ...[...pages.values()].map((p) => p.qid).filter((q): q is string => !!q),
          ...[...labels.values()].flat(),
        ]);
        for (const t of animeMatched) {
          const o = out.get(t)!;
          if (o.kind !== "match") continue;
          // 照合できなかったもの（検索・記事・Wikidata の照会が落ちた）は決めずに次回に回す
          const used = [...wikipediaTitlesFor(t, this.cfg), ...(found.get(t) ?? [])];
          if (!stageError.has(t) && used.some((x) => this.wikipedia.failedTitles.has(x))) stageError.set(t, "wikipedia cross-check: 照会エラー");
          if (!stageError.has(t) && this.touchesFailed(used, pages)) stageError.set(t, "wikidata cross-check: 一時的なエラー");
          if (stageError.has(t)) {
            out.set(t, { kind: "none", error: stageError.get(t)! });
            continue;
          }
          const same: WorkCandidate[] = [];
          const w = decideWikipedia(t, pages, ents, this.cfg);
          if (w.kind === "match") same.push(w.work);
          for (const title of found.get(t) ?? []) {
            if (matchKey(baseTitle(title), this.cfg) !== keyOf.get(t)) continue;
            const p = pages.get(title);
            if (isWorkPage(p, ents, this.cfg)) same.push(wikidataCandidate(p!, ents.get(p!.qid!)!, this.cfg));
          }
          for (const q of labels.get(t) ?? []) {
            const e = ents.get(q);
            if (e && workMedia(e, this.cfg) && !same.some((x) => x.wikidataId === q)) same.push(labelCandidate(e, this.cfg));
          }
          // 照合の相手はアニメ以外の作品（実写映画など）だけ。アニメの記事は同じ作品の別の粒度（シリーズ全体など）のことが多い
          const other = same.filter((x) => !x.isAnime);
          const a = o.work.releaseYear;
          const differs = other.filter((x) => (a && x.releaseYear && Math.abs(a - x.releaseYear) >= 1) || (o.work.media && x.media && o.work.media !== x.media));
          if (differs.length) {
            out.set(t, { kind: "ambiguous", works: [o.work, ...differs], method: "同名の別作品（公開年が違う）", source: o.source });
          }
        }
      } catch (e) {
        this.errors.push(`wikipedia cross-check: ${errorMessage(e)}`);
        for (const t of animeMatched) out.set(t, { kind: "none", error: `wikipedia cross-check: ${errorMessage(e)}` });
      }
    }

    // Wikipedia の記事名 → Wikidata。区間の直後に「!」があった区間は、それを残した記事名を先に試す
    const wpNotes = new Map<string, string>();
    if (pending().length) {
      const ts = pending();
      const titlesOf = (t: string) => [...(wp.get(t) ? wikipediaTitlesFor(wp.get(t)!, this.cfg) : []), ...wikipediaTitlesFor(t, this.cfg)];
      try {
        const pages = await this.wikipedia.pages(ts.flatMap(titlesOf));
        const ents = await this.wikipedia.entities([...pages.values()].map((p) => p.qid).filter((q): q is string => !!q));
        for (const t of ts) {
          let r = wp.get(t) ? decideWikipedia(wp.get(t)!, pages, ents, this.cfg) : ({ kind: "none" } as MatchResult);
          if (r.kind === "none") r = decideWikipedia(t, pages, ents, this.cfg);
          if (r.kind !== "none") out.set(t, { ...r, source: "wikipedia" });
          else if (titlesOf(t).some((x) => this.wikipedia.failedTitles.has(x))) stageError.set(t, "wikipedia: 照会エラー");
          else if (this.touchesFailed(titlesOf(t), pages)) stageError.set(t, "wikidata: 一時的なエラー");
          else if (r.note) wpNotes.set(t, r.note);
        }
      } catch (e) {
        this.errors.push(`wikipedia: ${errorMessage(e)}`);
        for (const t of ts) stageError.set(t, `wikipedia: ${errorMessage(e)}`);
      }
    }

    // Wikipedia の全文検索（記事名が表記ゆれで一致しないもの）
    if (useSearch && pending().length) {
      const ts = pending().filter((t) => keyOf.get(t)!.length >= 3 && !stageError.has(t));
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

    // Wikidata のラベルの完全一致（Wikipedia に記事の無い作品）。全文検索を使う段（括弧の中身・括弧の外の区間）だけ。
    // 作品クラスのラベル一致が1件だけのときに決める。複数なら保留。
    // 区間の記事が曖昧さ回避ページなら決めない（同名の作品がほかにもある。「スパイダーマン」の型）
    if (useSearch && this.cfg.wikidata_label && pending().length) {
      const ts = pending().filter((t) => keyOf.get(t)!.length >= 2 && !isShortLatin(keyOf.get(t)!) && !stageError.has(t));
      try {
        const ids = new Map<string, string[]>();
        for (const t of ts) {
          try {
            ids.set(t, (await this.wikipedia.searchEntities(t)).filter((h) => this.labelEquals(h, keyOf.get(t)!)).map((h) => h.id));
          } catch (e) {
            stageError.set(t, `wikidata search: ${errorMessage(e)}`);
          }
        }
        const hitTs = [...ids.entries()].filter(([, v]) => v.length).map(([t]) => t);
        const pages = await this.wikipedia.pages(hitTs.flatMap((t) => [t, `${t} (曖昧さ回避)`]));
        const ents = await this.wikipedia.entities([...ids.values()].flat());
        // 区間と同名の記事（作品・原作でなければ、区間は一般の語）
        const pageEnts = await this.wikipedia.entities(hitTs.map((t) => pages.get(t)?.qid).filter((q): q is string => !!q));
        const sourceClasses = new Set([...Object.keys(this.cfg.wikipedia.work_classes), ...(this.cfg.wikipedia.source_classes ?? [])]);
        for (const t of hitTs) {
          const ws = ids.get(t)!.map((q) => ents.get(q)).filter((e): e is EntityInfo => !!e && !!workMedia(e, this.cfg)).map((e) => labelCandidate(e, this.cfg));
          if (ids.get(t)!.some((q) => this.wikipedia.failedQids.has(q))) { stageError.set(t, "wikidata: 一時的なエラー"); continue; }
          if (ws.length === 0) continue;
          const dis = pages.get(t)?.disambiguation || (pages.get(`${t} (曖昧さ回避)`) && !pages.get(`${t} (曖昧さ回避)`)!.missing);
          // 曖昧さ回避ページがあれば保留。映画の枠でラベルの一致が映画1つだけなら、枠ごとに選ぶ（pick。「ホラー映画：来る」）
          if (dis) { out.set(t, { kind: "ambiguous", works: ws, method: LABEL_DISAMBIGUATED, source: "wikidata" }); continue; }
          const page = pages.get(t);
          const pe = page && !page.missing && page.qid ? pageEnts.get(page.qid) : undefined;
          if (page && !page.missing && page.qid && !(pe?.p31 ?? []).some((c) => sourceClasses.has(c))) {
            out.set(t, { kind: "ambiguous", works: ws, method: LABEL_COMMON_WORD, source: "wikidata" });
            continue;
          }
          out.set(t, ws.length === 1
            ? { kind: "match", work: ws[0]!, method: "label", source: "wikidata" }
            : { kind: "ambiguous", works: ws, method: "Wikidata のラベルが同じ作品が複数", source: "wikidata" });
        }
      } catch (e) {
        this.errors.push(`wikidata label: ${errorMessage(e)}`);
        for (const t of ts) if (!out.has(t)) stageError.set(t, `wikidata label: ${errorMessage(e)}`);
      }
    }

    for (const t of texts.keys()) {
      if (!out.has(t)) {
        const err = stageError.get(t);
        out.set(t, err ? { kind: "none", error: err } : { kind: "none", note: wpNotes.get(t) });
      }
      const cs = cands.get(t);
      if (cs?.length) {
        const o = out.get(t)!;
        const variants = seasonVariants(keyOf.get(t)!, cs, this.cfg);
        out.set(t, { ...o, cands: cs, ...(variants.size ? { variants } : {}) });
      }
    }
    return out;
  }
}

function loadTargets(ctx: Ctx, opts: ResolveOptions): Target[] {
  const cutoff = farFutureCutoff(ctx.crawlCfg.upcoming.max_days_ahead);
  const base = `SELECT e.id, e.video_id, e.title_raw, e.description_raw, e.started_at FROM watch_events e
    LEFT JOIN event_resolution er ON er.watch_event_id = e.id
    LEFT JOIN unresolved u ON u.watch_event_id = e.id AND u.resolved_at IS NULL
    WHERE ${activeEventSql("e")} AND e.id NOT IN ${AI_LOCKED_SQL}`;
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
  /** AI の判定（確定）を入れ直した枠 */
  ai?: { identified: number; not_a_work: number; unidentifiable: number };
  /** 視聴系列による期の割り当て */
  series?: Omit<SeriesStats, "lines">;
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

export interface Picked {
  work: WorkCandidate;
  method: string;
  from: Segment["from"] | "sub";
  text: string;
  /** 小区間の元の区間 */
  parent?: string;
  /** 同じ作品に当たったほかの区間（英題の区間など。短い区間の足切りと話数の紐付けで使う） */
  also?: { text: string; parent?: string }[];
}

/**
 * 枠ごとの候補の段。前の段で作品が決まれば、後の段は照会もしないし採用もしない。
 *   0: 括弧（『』「」など）の中身
 *   1: 括弧の外の区間（括弧の中身が無い枠では最初の段）
 *   2: 小区間（「！」「＆」「/」で分けたもの・言い換え）
 *   3: 概要欄のその枠を指す行の括弧の中身・作品名の列挙
 *   4: ハッシュタグ（タグには配信者名・企画名も入るので、ほかに候補がないときだけ）
 * 括弧で作品が決まった枠では、括弧の外の区間（「王覇山軍」「ぺこ」など配信者の決まり文句）を照会も採用もしない。
 * 作品ではない語に当たった枠は、作品名だと明示された括弧（「映画「さがす」」）の中身だけを試す。
 */
interface TierItem {
  text: string;
  from: Picked["from"];
  /** 小区間の分け方。multi は複数作品になりうる、alt は同じ作品の言い換え */
  kind?: "multi" | "alt";
  /** 小区間の元の区間 */
  parent?: string;
  /** Wikipedia の記事名で先に試す形 */
  wp?: string;
}

export const TIER_NAMES = ["括弧の中身", "括弧の外の区間", "小区間", "概要欄", "ハッシュタグ"];

function tiers(plan: Plan): TierItem[][] {
  const item = (s: Segment): TierItem => ({ text: s.text, from: s.from, ...(s.wp ? { wp: s.wp } : {}) });
  const quote = plan.ex.segments.filter((s) => s.from === "quote").map(item);
  if (plan.ex.notAWork) return [plan.ex.notAWorkQuoteOnly ? quote : [], [], [], [], []];
  const title = plan.ex.segments.filter((s) => s.from !== "quote");
  return [
    quote,
    title.map(item),
    plan.ex.segments.flatMap((s) => s.subs.map((x) => ({ text: x.text, from: "sub" as const, kind: x.kind, parent: s.text }))),
    plan.desc.map(item),
    plan.ex.hashtags.map(item),
  ];
}

const MOVIE_WORDS = /劇場版|映画|the ?movie/i;

/** 映画の枠かどうか。「※映画のネタバレ禁止」のような注意書きの中の「映画」は見ない */
export function looksLikeMovieEvent(title: string): boolean {
  const body = title.replace(/[※＊*][^【】〖〗]*/g, "").replace(/(劇場版|映画)の?ネタバレ/g, "");
  return MOVIE_WORDS.test(body);
}

export { releaseStart };

/** 区間の末尾の公開年（「GODZILLA(2014」「ショーシャンクの空に(字幕版)1995」） */
export function yearIn(text: string | undefined): number | null {
  if (!text) return null;
  const m = text.normalize("NFKC").match(/(?:^|[^0-9])((?:19|20)\d{2})(?:年版?)?[)）]?\s*$/);
  return m ? Number(m[1]) : null;
}

/**
 * 期・部の表記を見る作品名。原題（Annict の作品名・AniList の native・Wikidata の日本語ラベル）だけ。
 * Annict の英題・ローマ字は期・部の表記が当てにならない（「スターダストクルセイダース」のローマ字が「… 2nd Season」、
 * 「ストーンオーシャン 第3期」のローマ字が「… Part 3」）
 */
const primaryTitle = (w: WorkCandidate): string[] => w.titles.slice(0, 1);

/** アニメのDBの作品か（期ごとに別作品として登録されている。Wikidata のアニメの記事も含める） */
const isAnimeWork = (w: WorkCandidate) => w.source !== "wikidata" || !!w.isAnime;

/**
 * 部の表記（「第3部」「part4」）がタイトルにあるとき、作品がその部かを確かめる。問題なければ null、あれば理由。
 *   - 作品名に同じ部の表記がある → よい
 *   - 同じ照会の候補に、その部の表記を持つ別の作品がある → 別の部
 *   - 候補に、作品名が作品の照合キーの前方に一致する（副題の無い）作品がある → 作品は副題で部を特定している（ジョジョの各部）→ よい
 *   - それ以外 → 部が特定できない
 */
function partProblem(title: Markers, w: WorkCandidate, cands: WorkCandidate[], cfg: ExtractConfig): string | null {
  if (title.part.size === 0) return null;
  const wm = workMarkers(primaryTitle(w), cfg);
  const wkeys = w.titles.map((t) => matchKey(t, cfg));
  for (const p of title.part) {
    if (wm.part.has(p)) continue;
    const others = cands.filter((c) => c.sourceKey !== w.sourceKey);
    if (others.some((c) => workMarkers(primaryTitle(c), cfg).part.has(p))) return `タイトルの部「${p}」は別の作品`;
    const subtitled = others.some((c) => c.titles.some((t) => {
      const k = matchKey(t, cfg);
      return k.length >= 2 && wkeys.some((x) => x.length > k.length && x.startsWith(k));
    }));
    if (!subtitled) return `タイトルの部「${p}」が特定できない`;
  }
  return null;
}

export function pick(
  plan: Plan,
  outcomes: Map<string, Outcome>,
  seasonQualifiers: RegExp[] = [],
): { picked: Picked[]; ambiguous: Outcome[]; errors: string[]; notes: Record<string, string> } {
  const cfg = cfgOf(plan);
  const ambiguous: Outcome[] = [];
  const errors: string[] = [];
  const notes: Record<string, string> = {};
  const eventYear = plan.target.started_at ? Number(plan.target.started_at.slice(0, 4)) : null;
  const maxEpisode = plan.ex.episodes.length ? Math.max(...plan.ex.episodes.map((e) => e.number)) : null;
  // 同じタイトルに、期・続編だけを示す区間があるか（「二期」「The Final Season」など）
  const allTexts = plan.ex.segments.flatMap((s) => [s.text, ...s.subs.map((x) => x.text)]);
  const seasonHint = allTexts.find((t) => seasonQualifiers.some((re) => re.test(t.normalize("NFKC").toLowerCase().replace(/[\s!！?？・:：\-]/g, ""))));
  // タイトル全体の期・部の表記
  const titleMk = markersOf(plan.target.title_raw, cfg);
  const laterSeasons = [...titleMk.season.keys()].filter((k) => k !== "s1");
  const list = tiers(plan);
  // 原題で一致した作品（英題だけの一致を裏付けるのに使う）
  const strong = new Set<string>();
  for (const tier of list) for (const { text } of tier) {
    const o = outcomes.get(text);
    if (o?.kind === "match" && !o.weak) {
      strong.add(o.work.sourceKey);
      if (o.work.malId) strong.add(`mal:${o.work.malId}`);
    }
  }
  // 同じ枠のほかの区間で当たった作品（英題だけの一致も含む）。同名の作品で保留になったとき、どちらかを選ぶ手がかりにする（和英併記）
  const anyMatched = new Map<string, number>();
  for (const tier of list) for (const { text } of tier) {
    const o = outcomes.get(text);
    if (o?.kind !== "match") continue;
    for (const k of [o.work.sourceKey, ...(o.work.malId ? [`mal:${o.work.malId}`] : [])]) anyMatched.set(k, (anyMatched.get(k) ?? 0) + 1);
  }
  const otherMatched = (x: WorkCandidate) => anyMatched.has(x.sourceKey) || (!!x.malId && anyMatched.has(`mal:${x.malId}`));
  const byOtherSegment = (o: Outcome & { kind: "ambiguous" }): WorkCandidate | null => {
    const hit = [...new Map(o.works.filter(otherMatched).map((x) => [x.malId ? `mal:${x.malId}` : x.sourceKey, x] as const)).values()];
    return hit.length === 1 ? hit[0]! : null;
  };
  // 和英併記で選べる保留の作品は、原題の一致と同じく英題の区間を裏付ける（「日常 同時視聴 / NICHIJOU」）
  for (const tier of list) for (const { text } of tier) {
    const o = outcomes.get(text);
    if (o?.kind !== "ambiguous") continue;
    const x = byOtherSegment(o);
    if (!x) continue;
    strong.add(x.sourceKey);
    if (x.malId) strong.add(`mal:${x.malId}`);
  }
  const reject = (text: string, w: WorkCandidate, why: string) => {
    notes[text] = `${why}: ${w.title}`;
    ambiguous.push({ kind: "ambiguous", works: [w], method: why });
  };
  for (let k = 0; k < list.length; k++) {
    const picked = new Map<string, Picked>();
    const altTaken = new Set<string>();
    for (const item of list[k]!) {
      const { text, from } = item;
      const o = outcomes.get(text);
      if (!o) continue;
      // タイトルに2期以降の表記があれば、「区間 + 期の表記」で作品名を作り直した候補を先に見る
      // （「【ウマ娘プリティーダービー】season２…」→ Season 2 の作品）
      let w: WorkCandidate | null = null;
      let method = "";
      let viaSeason = false;
      if (laterSeasons.length && o.variants) {
        // 照会先が違っても MyAnimeList の ID が同じなら同じ作品（Annict を優先）
        const vs = [...new Map(laterSeasons.flatMap((tag) => o.variants!.get(tag) ?? [])
          .sort((a, b) => (a.source === "annict" ? 0 : 1) - (b.source === "annict" ? 0 : 1))
          .map((x) => [x.malId ? `mal:${x.malId}` : x.sourceKey, x] as const).reverse()).values()];
        if (vs.length === 1) {
          w = vs[0]!;
          method = `${o.source}:exact+season`;
          viaSeason = true;
        } else if (vs.length > 1) {
          ambiguous.push({ kind: "ambiguous", works: vs, method: "期の候補が複数" });
          continue;
        }
      }
      if (!w && o.kind === "match") {
        w = o.work;
        method = `${o.source}:${o.method}`;
      }
      if (w) {
        // 枠より後に公開された作品は観られない（リメイク・別シーズンの取り違え）。
        // 放送期（2025-summer など）が分かれば月まで見る。先行上映があるので1か月の余裕を残す
        if (eventYear && w.releaseYear && w.releaseYear > eventYear) { reject(text, w, `公開年${w.releaseYear}が枠の年${eventYear}より後`); continue; }
        const start = releaseStart(w);
        if (start && plan.target.started_at && Date.parse(plan.target.started_at) < start - 31 * 86_400_000) {
          reject(text, w, `放送期${w.seasonName}より前の枠`);
          continue;
        }
        // 区間に公開年が書かれていて、作品の公開年と違う（「GODZILLA(2014)」を1998年版に付けない。公開国の違いで1年ずれるのは許す）
        const year = yearIn(text) ?? yearIn(item.parent);
        if (year && w.releaseYear && Math.abs(w.releaseYear - year) > 1) { reject(text, w, `区間の年${year}と公開年${w.releaseYear}が違う`); continue; }
        const keys = [matchKey(text, cfg), ...(item.parent ? [matchKey(item.parent, cfg)] : [])];
        // 丸数字の番号が付いた区間（「パイカリ③」）は、映画なら何作目か分からない
        if (w.media === "movie" && keys.some((x) => plan.ex.numbered.has(x))) { reject(text, w, "番号の付いた区間（何作目か分からない）"); continue; }
        // 区間の直後に副題の括弧がある（「ドラゴンボール超「ブロリー」」）のに、副題を含まない作品に当たった
        const subs = keys.flatMap((x) => plan.ex.subtitled.get(x) ?? []);
        if (subs.length && !w.titles.some((t) => subs.some((s) => matchKey(t, cfg).includes(s)))) { reject(text, w, "副題の括弧があるのにシリーズ名だけで当たった"); continue; }
        // ハッシュタグ（ゲーム名・企画名が多い）は、記事名の推測（「(映画)」を付けた記事・全文検索）では同定しない
        if (from === "hashtag" && /suffix|search/.test(method)) { reject(text, w, "ハッシュタグの推測の一致"); continue; }
        // 期・続編を示す区間があるのに、シリーズ名だけの区間で当たった（その区間自身が期を含むなら問題ない）
        if (!viaSeason && seasonHint && seasonHint !== text && !text.includes(seasonHint)) { reject(text, w, `別の期の可能性（「${seasonHint}」）`); continue; }
        // タイトルに期の表記があるのに、作品がその期でない（アニメのDBは期ごとに別作品。Wikidata の実写作品は全シーズンで1つなので見ない）
        if (isAnimeWork(w)) {
          const why = seasonConflict(titleMk, workMarkers(primaryTitle(w), cfg));
          if (why) { reject(text, w, why); continue; }
        }
        // タイトルに部の表記があるのに、作品の部が特定できない（「ジョジョの奇妙な冒険 第3部」を第1部に付けない）
        const part = partProblem(titleMk, w, o.cands ?? [], cfg);
        if (part) { reject(text, w, part); continue; }
        // 英題・ローマ字だけの一致は弱い根拠。同じ枠のほかの区間が原題で同じ作品に当たっていなければ採用しない
        // （Annict は1期の英題がシリーズの総称。「Fate/Zero」「CLANNAD」が常に1期に当たる）
        if (!viaSeason && o.kind === "match" && o.weak && !strong.has(w.sourceKey) && !(w.malId && strong.has(`mal:${w.malId}`))) {
          reject(text, w, "英題だけの一致（弱い根拠）");
          continue;
        }
        // 話数が作品の話数を超えている（別の期・通し番号）。
        // 期の表記で選んだ作品は、期をまたぐ通し番号（「[46話～50話(2期)]」）のことがあるので見ない（話数は紐付けない）
        if (!viaSeason && maxEpisode && w.episodesCount && w.media !== "movie" && maxEpisode > w.episodesCount) { reject(text, w, `話数${maxEpisode}が作品の話数${w.episodesCount}を超える`); continue; }
        // タイトルに「映画・劇場版」があるのにテレビ作品に当たった
        if (looksLikeMovieEvent(plan.target.title_raw) && w.media === "tv") { reject(text, w, "映画の枠がテレビ作品に当たった"); continue; }
        // タイトルに「総集編」があるのに、総集編でないテレビ作品に当たった（「チェンソーマン」総集篇 - 前篇 - をテレビ版に付けない）
        if (/総集[編篇]/.test(plan.target.title_raw) && (w.media === "tv" || w.media === "web") && !w.titles.some((t) => /総集[編篇]|recap/i.test(t))) {
          reject(text, w, "総集編の枠がテレビ作品に当たった");
          continue;
        }
        // 舞台版は外部作品DBに無いので、どの作品にも同定しない（「舞台「鬼滅の刃」」がアニメ1期に当たっていた）
        if (/舞台/.test(plan.target.title_raw)) { reject(text, w, "舞台の枠"); continue; }
        // タイトルに「実写」があるのにアニメのDBの作品に当たった（「魔女の宅急便（実写）」が1989年のアニメ映画に当たっていた）
        if (/実写/.test(plan.target.title_raw) && !/実写.{0,4}前/.test(plan.target.title_raw) && w.source !== "wikidata") { reject(text, w, "実写の枠がアニメ作品に当たった"); continue; }
        // 言い換えの小区間（「！」や和英併記で分けたもの）は、同じ元の区間から最初に当たった1つだけ
        if (item.kind === "alt" && item.parent) {
          if (altTaken.has(item.parent)) continue;
          altTaken.add(item.parent);
        }
        // 同じ作品（照会先が違っても MyAnimeList の ID が同じなら同じ作品）は1つにまとめ、当たった区間を裏付けとして残す
        const same = [...picked.values()].find((p) => p.work.sourceKey === w!.sourceKey || (!!w!.malId && p.work.malId === w!.malId));
        if (same) (same.also ??= []).push({ text, ...(item.parent ? { parent: item.parent } : {}) });
        else picked.set(w.sourceKey, { work: w, method, from, text, ...(item.parent ? { parent: item.parent } : {}) });
      } else if (o.kind === "ambiguous") {
        // アニメのテレビ作品と同名の実写作品が並んだとき、話数付きの枠ならアニメのシリーズを選ぶ（「ゴールデンカムイ 8話から」）
        // 同名の別作品で保留になったとき、タイトルに手がかりがあれば選ぶ
        //   話数付き → アニメのテレビシリーズ（「ゴールデンカムイ 8話から」）
        //   「アニメ」→ アニメの作品、「実写」→ アニメ以外の作品（「アラジン（実写のほう）」）、区間の年 → その年の作品（「グリンチ (2000)」）
        let chosen: WorkCandidate | null = byOtherSegment(o);
        let how = chosen ? "exact+bilingual" : "";
        // Wikidata のラベルは一致するが同名の曖昧さ回避ページがある: 映画の枠で、一致した作品が映画1つだけなら選ぶ
        // 区間が一般の語（Wikipedia の同名の記事が作品・原作でない。「罰ゲーム」）のときも同じ
        if (!chosen && (o.method === LABEL_DISAMBIGUATED || o.method === LABEL_COMMON_WORD) && o.works.length === 1 && o.works[0]!.media === "movie" && looksLikeMovieEvent(plan.target.title_raw)) {
          chosen = o.works[0]!;
          how = "label+movie";
        }
        if (!chosen && o.method === "同名の別作品（公開年が違う）") {
          const body = plan.target.title_raw.replace(/[※＊*][^【】〖〗]*/g, "");
          // 枠の時点でまだ公開されていない作品は候補から外す（「ルックバック」の実写版は2024年の枠より後）
          const t = plan.target.started_at ? Date.parse(plan.target.started_at) : null;
          const works = o.works.filter((x) => {
            if (!t) return true;
            const st = releaseStart(x);
            if (st !== null) return st <= t + 31 * 86_400_000;
            return !x.releaseYear || x.releaseYear <= new Date(t).getUTCFullYear();
          });
          const series = works.filter((x) => x.source !== "wikidata" && x.media !== "movie");
          const anime = works.filter((x) => isAnimeWork(x));
          // 「実写見る前に復習したい」は実写版の手がかりではない
          const liveCue = /実写/.test(body) && !/実写.{0,4}前/.test(body);
          const live = works.filter((x) => !isAnimeWork(x));
          const y = yearIn(text) ?? yearIn(item.parent);
          const byYear = y ? works.filter((x) => x.releaseYear && Math.abs(x.releaseYear - y) <= 1) : [];
          // 配信の回数（#2 以降・#最終回）がある枠は、何回にも分けて観るもの（テレビシリーズ）。映画は1枠で観る
          const counter = /[#＃]\s*(?:0*[2-9]|[1-9][0-9]|最終回)(?![0-9A-Za-z])/.test(body.normalize("NFKC"));
          const tvSeries = works.filter((x) => (x.media === "tv" || x.media === "web") && (x.episodesCount ?? 0) >= 7);
          if (works.length === 1 && o.works.length > 1) { chosen = works[0]!; how = "exact+date"; }
          else if (plan.ex.episodes.length > 0 && series.length === 1) { chosen = series[0]!; how = "exact+episodes"; }
          else if (counter && tvSeries.length === 1) { chosen = tvSeries[0]!; how = "exact+counter"; }
          else if (/アニメ/.test(body) && !liveCue && anime.length === 1) { chosen = anime[0]!; how = "exact+anime"; }
          else if (liveCue && live.length === 1) { chosen = live[0]!; how = "exact+live"; }
          else if (byYear.length === 1) { chosen = byYear[0]!; how = "exact+year"; }
        }
        if (chosen) {
          const why = seasonConflict(titleMk, workMarkers(primaryTitle(chosen), cfg));
          if (why) { reject(text, chosen, why); continue; }
          const same = [...picked.values()].find((p) => p.work.sourceKey === chosen!.sourceKey || (!!chosen!.malId && p.work.malId === chosen!.malId));
          if (same) (same.also ??= []).push({ text, ...(item.parent ? { parent: item.parent } : {}) });
          else picked.set(chosen.sourceKey, { work: chosen, method: `${how.startsWith("label") ? "wikidata" : chosen.source === "wikidata" ? "wikipedia" : o.source}:${how}`, from, text });
        } else ambiguous.push(o);
      } else if (o.kind === "none") {
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
      const keyLen = (t: string) => matchKey(t, cfg).length;
      const items = list[k]!;
      const isAltOrTitle = (p: Picked) => k === 1 || items.some((x) => x.text === p.text && x.kind === "alt");
      // 同じ作品のもっと長い区間（英題など）があればよい。短い区間を含む区間（言い換えの元）とは比べない
      const short = ps.filter((p) => {
        const own = Math.max(keyLen(p.text), ...(p.also ?? []).map((x) => keyLen(x.text)));
        if (!isAltOrTitle(p) || own > 4) return false;
        const k0 = matchKey(p.text, cfg);
        const others = [...items.map((x) => x.text), ...items.map((x) => x.parent ?? "")].filter((x) => x && !matchKey(x, cfg).includes(k0));
        return Math.max(0, ...others.map(keyLen)) > own * 2;
      });
      for (const p of short) reject(p.text, p.work, "短い区間がより長い区間を差し置いて当たった");
      ps = ps.filter((p) => !short.includes(p));
      if (ps.length === 0) continue;
    }
    // 括弧の外の区間で別々の作品が当たったら決めない（長さや位置では選ばない）。
    // 英題が日本語の区間と同じ作品に当たったもの（和英併記）は、上で同じ作品として1つにまとまっている
    if (k === 1 && new Set(ps.map((p) => p.text)).size > 1) {
      ambiguous.push({ kind: "ambiguous", works: ps.map((p) => p.work), method: "複数の区間が別々の作品に当たった" });
      return { picked: [], ambiguous, errors, notes };
    }
    return { picked: ps, ambiguous, errors, notes };
  }
  return { picked: [], ambiguous, errors, notes };
}

/**
 * 作品に付ける話数。タイトルの中の並びで、話数のまとまりの直前（無ければ直後）にある区間が、
 * その作品の区間（小区間ならその元の区間）のときだけ付ける。
 * 括弧の中身で決まった作品は、括弧の中身の区間どうしだけで見る（括弧の外の決まり文句を挟んでも付ける）。
 * 例: 「【アイカツ！同時視聴会】オンパレード同時視聴【27話＆1話】」は話数の直前が「オンパレード」なので、アイカツ！に話数を付けない
 */
export function episodesFor(plan: Plan, p: Picked, cfg: ExtractConfig): EpisodeRef[] {
  if (p.work.media === "movie") return [];
  // 期の表記で選んだ作品は、区間と期の表記が別の位置にあり、話数がどちらのものか決められない
  // （「CLANNAD1話アフターストーリー12話～16話」）。期をまたぐ通し番号のこともあるので付けない
  if (p.method.endsWith("+season")) return [];
  const texts = [p.text, p.parent, ...(p.also ?? []).flatMap((x) => [x.text, x.parent])].filter((x): x is string => !!x);
  const keys = new Set(texts.map((x) => matchKey(x, cfg)));
  const quoteOnly = p.from === "quote";
  const items = plan.ex.layout.filter((x) => x.t === "ep" || (x.t === "seg" && (!quoteOnly || x.quote)));
  const out = new Map<number, EpisodeRef>();
  items.forEach((x, i) => {
    if (x.t !== "ep") return;
    let owner: string | null = null;
    for (let j = i - 1; j >= 0 && owner === null; j--) { const y = items[j]!; if (y.t === "seg") owner = y.key; }
    for (let j = i + 1; j < items.length && owner === null; j++) { const y = items[j]!; if (y.t === "seg") owner = y.key; }
    if (owner !== null && keys.has(owner)) for (const e of plan.ex.episodeGroups[x.g] ?? []) if (!out.has(e.number)) out.set(e.number, e);
  });
  // 作品の話数を超える番号（期をまたぐ通し番号）は、どの話か決められないので付けない
  const eps = [...out.values()].sort((a, b) => a.number - b.number);
  if (p.work.episodesCount && eps.some((e) => e.number > p.work.episodesCount!)) return [];
  return eps;
}

export async function resolveEvents(ctx: Ctx, opts: ResolveOptions): Promise<ResolveStats> {
  const cfg = loadExtractConfig();
  planCfg = cfg;
  const r = new Resolver(ctx, cfg);
  const targets = loadTargets(ctx, opts);
  log.info(`名寄せ対象 ${targets.length} 件（mode=${opts.mode}, rule=${cfg.version}）`);
  const selfWords = ctx.detectCfg.description.line_require;

  const plans: Plan[] = targets.map((t) => ({
    target: t,
    ex: extract(t.title_raw, cfg),
    desc: [] as Segment[],
  }));
  for (const p of plans) {
    if (p.target.description_raw) p.desc = extractFromDescription(p.target.description_raw, selfWords, cfg, { lists: p.ex.segments.length === 0 });
  }

  // 段ごとにまとめて照会する。前の段で作品が決まった枠の、後の段の区間は照会しない
  const outcomes = new Map<string, Outcome>();
  const decided = (p: Plan, upTo: number) =>
    tiers(p).slice(0, upTo).some((tier) => tier.some(({ text }) => outcomes.get(text)?.kind === "match"));
  for (let k = 0; k < TIER_NAMES.length; k++) {
    const texts = new Map<string, string>();
    const wp = new Map<string, string>();
    for (const p of plans) {
      if (decided(p, k)) continue;
      for (const it of tiers(p)[k]!) {
        if (outcomes.has(it.text)) continue;
        texts.set(it.text, p.target.title_raw);
        if (it.wp) wp.set(it.text, it.wp);
      }
    }
    log.info(`${k + 1}段目の照会（${TIER_NAMES[k]}）: ${texts.size} 件`);
    if (texts.size === 0) continue;
    // 全文検索は重いので、括弧の中身と区間の段だけで使う
    for (const [t, o] of await r.resolveTexts(texts, k <= 1, wp)) outcomes.set(t, o);
  }

  // タイトルに部の表記がある枠は、当たった Annict の作品のシリーズの全作品を候補に足す
  // （「ジョジョの奇妙な冒険 ダイヤモンドは砕けない」の照会には、副題の無い「ジョジョの奇妙な冒険」が出てこないため）
  if (r.annict) {
    const texts = new Set<string>();
    for (const p of plans) {
      if (markersOf(p.target.title_raw, cfg).part.size === 0) continue;
      for (const tier of tiers(p)) for (const { text } of tier) texts.add(text);
    }
    const ids = [...texts].map((t) => outcomes.get(t)).filter((o): o is Outcome & { kind: "match" } => o?.kind === "match" && !!o.work.annictId).map((o) => o.work.annictId!);
    try {
      const series = await r.annict.seriesWorks(ids);
      for (const t of texts) {
        const o = outcomes.get(t);
        if (o?.kind !== "match" || !o.work.annictId) continue;
        const extra = series.get(o.work.annictId) ?? [];
        outcomes.set(t, { ...o, cands: [...new Map([...(o.cands ?? []), ...extra].map((c) => [c.sourceKey, c])).values()] });
      }
    } catch (e) {
      r.errors.push(`annict series: ${errorMessage(e)}`);
    }
  }

  const seasonQualifiers = cfg.season_qualifiers.map((x) => new RegExp(x));
  const decisions = plans.map((p) => {
    const d = pick(p, outcomes, seasonQualifiers);
    return { plan: p, ...d, eps: d.picked.map((x) => episodesFor(p, x, cfg)) };
  });
  // 話数を紐付けるテレビ作品の話の一覧（Annict）
  const annictEpisodes = new Map<number, AnnictEpisode[]>();
  if (r.annict) {
    const ids = decisions.flatMap((d) => d.picked.filter((x, i) => d.eps[i]!.length > 0 && x.work.annictId).map((x) => x.work.annictId!));
    try {
      for (const [id, eps] of await r.annict.episodes(ids)) annictEpisodes.set(id, eps);
    } catch (e) {
      r.errors.push(`annict episodes: ${errorMessage(e)}`);
    }
  }

  const stats: ResolveStats = {
    targets: targets.length, resolved: 0,
    unresolved: { no_candidate: 0, unidentifiable: 0, not_found: 0, ambiguous: 0, not_a_work: 0, error: 0 },
    event_works: 0, multi_work_events: 0, episodes_linked: 0, works_total: 0, works_removed: 0, images_linked: 0,
    requests: {}, cache: { hits: 0, misses: 0 }, source_errors: [], rule_version: cfg.version,
  };

  tx(ctx.db, () => {
    for (const d of decisions) {
      const { plan } = d;
      const ev = plan.target.id;
      const segTexts = plan.ex.segments.map((s) => s.text);
      const shown = segTexts.join(" / ") || plan.ex.cleaned || null;
      if (d.picked.length === 0 && plan.ex.notAWork) {
        markUnresolved(ctx.db, ev, "not_a_work", plan.ex.notAWork, { cleaned: plan.ex.cleaned, segments: segTexts, notes: d.notes }, cfg.version);
        stats.unresolved.not_a_work++;
        continue;
      }
      if (d.picked.length === 0) {
        let reason: UnresolvedReason;
        const named = plan.ex.segments.length > 0 || plan.desc.length > 0;
        if (d.ambiguous.length > 0) reason = "ambiguous";
        else if (d.errors.length > 0) reason = "error";
        else if (named) reason = "not_found";
        // 作品名の区間が無い（企画名だけ・「映画」「アニメ」だけ・ハッシュタグは当たらなかった）: 同時視聴だが作品を特定できない。
        // 1文字の語などが残っていれば、切り出しの取りこぼしの可能性があるので「作品名を切り出せない」
        else reason = plan.ex.programs.length === 0 && plan.ex.dropped.length > 0 ? "no_candidate" : "unidentifiable";
        const detail = {
          cleaned: plan.ex.cleaned,
          segments: segTexts,
          subs: plan.ex.segments.flatMap((s) => s.subs.map((x) => x.text)),
          description: plan.desc.map((s) => s.text),
          hashtags: plan.ex.hashtags.map((s) => s.text),
          programs: plan.ex.programs,
          dropped: plan.ex.dropped,
          notes: d.notes,
          errors: d.errors,
          // 保留した理由（「英題だけの一致（弱い根拠）」「remake」「同名の別作品（公開年が違う）」など）
          ambiguous_methods: [...new Set(d.ambiguous.map((o) => (o.kind === "none" ? "" : o.method)).filter(Boolean))],
          candidates: d.ambiguous.flatMap((o) => (o.kind === "ambiguous" ? o.works.map((w) => `${w.sourceKey} ${w.title} (${w.media ?? "?"}, ${w.releaseYear ?? "?"})`) : [])),
        };
        markUnresolved(ctx.db, ev, reason, shown || (plan.ex.programs.join(" / ") || null), detail, cfg.version);
        stats.unresolved[reason]++;
        continue;
      }
      const rows: EventWorkRow[] = [];
      d.picked.forEach((p, i) => {
        const workId = upsertWork(ctx.db, p.work);
        const confidence = confidenceOf(p.method, p.from);
        const eps = d.eps[i]!;
        if (eps.length > 0) {
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
      });
      replaceEventWorks(ctx.db, ev, rows, cfg.version);
      markResolved(ctx.db, ev, cfg.version);
      stats.resolved++;
      stats.event_works += rows.length;
      if (d.picked.length > 1) stats.multi_work_events++;
    }
  });

  // AI の判定（確定）を入れ直す。resolve の対象から外しているので、ここで最新の判定にそろえる
  tx(ctx.db, () => {
    stats.ai = applyAiDecisions(ctx.db, cfg.version);
  });

  // 視聴系列による期の割り当て（DB 全体。新しい枠で前の枠の期が決まることがあるので毎回全部を見る）
  if (r.annict && cfg.series_assignment !== false) {
    await runStep(ctx, "resolve: 視聴系列の期", async () => {
      const { lines: _lines, ...s } = await assignSeasons(ctx, cfg, r.annict!, cfg.version);
      stats.series = s;
      log.info(`視聴系列 ${s.runs} 系列・${s.events} 枠: 期が決まった ${s.events - s.held}（今と同じ ${s.same}・付け替え ${s.changed}・未同定から ${s.rescued}）、保留 ${s.held}（うち付いていた期を外した ${s.removed}）`);
    });
  }

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
