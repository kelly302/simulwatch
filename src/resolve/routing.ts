import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Ctx } from "../lib/context.ts";
import { activeEventSql, farFutureCutoff } from "../lib/events.ts";
import { ROOT } from "../lib/paths.ts";
import { log } from "../lib/log.ts";
import type { ExtractConfig } from "./config.ts";
import { extract, extractFromDescription } from "./extract.ts";
import { tiers } from "./resolve.ts";
import type { Plan } from "./resolve.ts";
import { matchKey } from "./normalize.ts";
import { hasDisambiguation, usableAnimeCandidate, isShortLatin, workMedia, labelCandidate, releaseStart } from "./match.ts";
import { ResolveCache } from "./cache.ts";
import { AnnictClient } from "./sources/annict.ts";
import { WikipediaClient } from "./sources/wikipedia.ts";
import type { WorkCandidate } from "./types.ts";
import { ROUTES, classifyRoute, routeFlags, notAWorkGroups, stratumOf, publishState } from "./route.ts";
import type { RouteType, RouteFacts, SegmentFrom } from "./route.ts";

// 枠の型分けに要る事実を DB と照会キャッシュから集める（段・曖昧さ回避・ほかの作品名・実写のテレビ作品・作品ではない語の種類と作品にも当たるか）。
// 型の決め方そのものは route.ts の純粋関数。名寄せのたびに型を event_resolution.route に記録し（persistRoutes）、検証（report/audit.ts）でも使う

/** 枠ごとの型と、突き合わせに使うルールの答え */
export interface RuleWork {
  /** この作品を指す外部DBのキー（annict:1 / anilist:2 / wikidata:Q3） */
  keys: string[];
  mal: number | null;
  title: string;
  media: string | null;
  year: number | null;
  season: string | null;
  episodes: number[];
  method: string;
  text: string;
  from: SegmentFrom;
}

export interface RuleAnswer {
  video_id: string;
  event_id: number;
  type: RouteType;
  /** 型の中の区分（作品ではないの型は語の種類。無ければ null）。抽出と集計は型＋区分（stratumOf）ごと */
  sub?: string | null;
  flags: RouteType[];
  /** identified / not_a_work / unidentifiable / unresolved（そのほかの未同定） */
  status: string;
  reason: string | null;
  /** 作品ではない語・未同定のときの区間 */
  text: string | null;
  works: RuleWork[];
  disambiguation: boolean;
  prefixSiblings: string[];
}

export interface EventRow {
  id: number;
  video_id: string;
  title_raw: string;
  description_raw: string | null;
  started_at: string | null;
  streamer_id: number;
  thumbnail_url: string | null;
  streamer: string;
  is_members_only: number;
  /** 配信の長さを判定役に見せるため（actual_start と ended_at があれば実開始〜実終了。published_at は投稿した動画） */
  started_at_source?: string | null;
  ended_at?: string | null;
}

export interface Routed {
  ev: EventRow;
  rule: RuleAnswer;
}

/**
 * 一覧に出る枠をすべて型に分ける。照会はキャッシュを使い、無いものだけ外部に照会する
 * （曖昧さ回避ページの有無は Wikipedia、ほかの作品名は Annict の検索とシリーズ・Wikidata のラベル検索）
 */
export async function collectRoutes(ctx: Ctx, cfg: ExtractConfig): Promise<{ routed: Routed[]; unknownFrom: number }> {
  const db = ctx.db;
  const cutoff = farFutureCutoff(ctx.crawlCfg.upcoming.max_days_ahead);
  const events = db.prepare(`SELECT e.id, e.video_id, e.title_raw, e.description_raw, e.started_at, e.streamer_id, e.thumbnail_url, e.is_members_only, e.started_at_source, e.ended_at, s.name AS streamer
    FROM watch_events e JOIN streamers s ON s.id = e.streamer_id WHERE ${activeEventSql("e")} ORDER BY e.id`).all(cutoff) as unknown as EventRow[];
  const aiOf = new Map((db.prepare(`SELECT watch_event_id, status FROM ai_decisions WHERE revoked_at IS NULL AND status != 'hold'`).all() as
    { watch_event_id: number; status: RouteFacts["ai"] }[]).map((r) => [r.watch_event_id, r.status]));
  const unres = new Map((db.prepare(`SELECT watch_event_id, reason, extracted_text, detail FROM unresolved WHERE resolved_at IS NULL`).all() as
    { watch_event_id: number; reason: string; extracted_text: string | null; detail: string | null }[]).map((r) => [r.watch_event_id, r]));
  const ewRows = db.prepare(`SELECT ew.watch_event_id AS ev, ew.work_id, ew.match_method, ew.extracted_text, ep.number,
      w.annict_id, w.anilist_id, w.wikidata_id, w.mal_id, w.title, w.media, w.release_year, w.season_name
    FROM event_works ew JOIN works w ON w.id = ew.work_id LEFT JOIN episodes ep ON ep.id = ew.episode_id ORDER BY ew.id`).all() as Record<string, string | number | null>[];
  const worksOf = new Map<number, Map<number, RuleWork & { annictId: number | null; wikidataId: string | null }>>();
  for (const r of ewRows) {
    const ev = Number(r.ev);
    const m = worksOf.get(ev) ?? new Map();
    worksOf.set(ev, m);
    let w = m.get(Number(r.work_id));
    if (!w) {
      const keys = [r.annict_id !== null ? `annict:${r.annict_id}` : null, r.anilist_id !== null ? `anilist:${r.anilist_id}` : null,
        r.wikidata_id !== null ? `wikidata:${r.wikidata_id}` : null].filter((x): x is string => !!x);
      w = {
        keys, mal: r.mal_id as number | null, title: String(r.title), media: r.media as string | null, year: r.release_year as number | null,
        season: r.season_name as string | null, episodes: [], method: String(r.match_method), text: String(r.extracted_text), from: "unknown",
        annictId: r.annict_id as number | null, wikidataId: r.wikidata_id as string | null,
      };
      m.set(Number(r.work_id), w);
    }
    if (r.number !== null && !w.episodes.includes(Number(r.number))) w.episodes.push(Number(r.number));
  }

  // 区間がどの段から来たか（今の抽出ルールで切り出し直して探す。見つからなければ unknown）
  const selfWords = ctx.detectCfg.description.line_require;
  let unknownFrom = 0;
  for (const e of events) {
    const ws = worksOf.get(e.id);
    if (!ws || aiOf.has(e.id)) continue;
    const ex = extract(e.title_raw, cfg);
    const desc = e.description_raw ? extractFromDescription(e.description_raw, selfWords, cfg, { lists: ex.segments.length === 0 }) : [];
    const list = tiers({ target: e, ex, desc } as unknown as Plan);
    for (const w of ws.values()) {
      const hit = list.flat().find((it) => it.text === w.text);
      w.from = hit ? hit.from : "unknown";
      if (!hit && !w.method.startsWith("series:")) unknownFrom++;
    }
  }

  // 照会（キャッシュ優先）
  // 型分けは毎回 DB 全体で付け直すので、期限切れの照会結果も使う（新しい枠の区間は名寄せで照会したばかり）
  const cache = new ResolveCache(db, 30, { stale: true });
  const wp = new WikipediaClient(ctx.http, cache);
  const token = process.env.ANNICT_TOKEN;
  const annict = token ? new AnnictClient(ctx.http, cache, token, cfg.annict) : null;
  if (!annict) log.warn("ANNICT_TOKEN が無いので、ほかの期の作品名は Wikidata だけで見ます");
  const identified = events.filter((e) => worksOf.has(e.id) && !aiOf.has(e.id));
  const texts = [...new Set(identified.flatMap((e) => [...worksOf.get(e.id)!.values()].map((w) => w.text)))].filter((t) => t && t !== "(AI の判定)");
  log.info(`型分け: 同定済み ${identified.length} 枠・区間 ${texts.length} 件の照会（キャッシュ優先）`);
  const pages = await wp.pages(texts.flatMap((t) => [t, `${t} (曖昧さ回避)`]));
  const annictHits = annict ? await annict.search(texts.filter((t) => !isShortLatin(matchKey(t, cfg)))) : new Map<string, WorkCandidate[]>();
  const annictIds = [...new Set(identified.flatMap((e) => [...worksOf.get(e.id)!.values()].map((w) => w.annictId).filter((x): x is number => x !== null)))];
  const series = annict ? await annict.seriesWorks(annictIds) : new Map<number, WorkCandidate[]>();
  const wdHits = new Map<string, string[]>();
  let n = 0;
  for (const t of texts) {
    if (matchKey(t, cfg).length < 2) continue;
    try {
      wdHits.set(t, (await wp.searchEntities(t)).map((h) => h.id));
    } catch (e) {
      // 区間の文は出さない（概要欄から切り出した区間もあり、公開リポジトリの Actions のログは誰でも見られる。docs/workflows.md 2-9）
      log.warn(`Wikidata の検索に失敗（ほかの作品名の確認を飛ばす）: ${String(e).slice(0, 120)}`);
    }
    if (++n % 200 === 0) log.info(`  Wikidata のラベル検索 ${n}/${texts.length}`);
  }
  const ents = await wp.entities([...new Set([...wdHits.values()].flat())]);
  const wdCands = new Map<string, WorkCandidate[]>();
  for (const [t, ids] of wdHits) {
    wdCands.set(t, ids.map((q) => ents.get(q)).filter((e) => !!e && !!e.labelJa && !!workMedia(e, cfg)).map((e) => labelCandidate(e!, cfg)));
  }
  // Wikidata だけで引いた作品がアニメか（実写のテレビ作品を見分ける）
  const wdOnly = (w: { keys: string[] }) => w.keys.length > 0 && w.keys.every((k) => k.startsWith("wikidata:"));
  const selfEnts = await wp.entities([...new Set(identified.flatMap((e) => [...worksOf.get(e.id)!.values()].filter(wdOnly).map((w) => w.wikidataId!)))]);
  const liveActionTv = (w: RuleWork & { wikidataId: string | null }) => {
    if (!wdOnly(w) || w.media !== "tv" || !w.wikidataId) return false;
    const en = selfEnts.get(w.wikidataId);
    return !!en && !labelCandidate(en, cfg).isAnime;
  };
  // 作品ではない語の種類（config/extract.yaml の not_a_work のコメントの見出し）
  const groups = notAWorkGroups(readFileSync(join(ROOT, "config", "extract.yaml"), "utf8"), cfg.not_a_work);

  const routed: Routed[] = [];
  for (const e of events) {
    const ws = [...(worksOf.get(e.id)?.values() ?? [])];
    const u = unres.get(e.id);
    const ai = aiOf.get(e.id) ?? null;
    const at = e.started_at ? Date.parse(e.started_at) : null;
    let disambiguation = false;
    const siblings = new Set<string>();
    if (!ai) {
      for (const w of ws) {
        if (hasDisambiguation(w.text, pages)) disambiguation = true;
        for (const s of siblingTitles(w, [
          ...(annictHits.get(w.text) ?? []).filter(usableAnimeCandidate),
          ...(w.annictId ? series.get(w.annictId) ?? [] : []).filter(usableAnimeCandidate),
          ...(wdCands.get(w.text) ?? []),
        ], at, cfg)) siblings.add(s);
      }
    }
    const facts: RouteFacts = {
      ai, works: ws.map((w) => ({ method: w.method, from: w.from })), unresolvedReason: ws.length ? null : u?.reason ?? null,
      disambiguation, prefixSiblings: [...siblings], liveActionTv: !ai && ws.some(liveActionTv),
      notAWorkConflict: !!(u?.detail && (JSON.parse(u.detail) as { work_conflicts?: string[] }).work_conflicts?.length),
    };
    const type = classifyRoute(facts);
    const status = ai ?? (ws.length ? "identified" : u?.reason === "not_a_work" || u?.reason === "unidentifiable" ? u.reason : "unresolved");
    const sub = type === "not_a_work_rule" ? groups.get(u?.extracted_text ?? "") ?? "（設定に無い語）" : null;
    routed.push({
      ev: e,
      rule: {
        video_id: e.video_id, event_id: e.id, type, sub, flags: ai ? [] : routeFlags(facts), status, reason: u?.reason ?? null, text: u?.extracted_text ?? null,
        works: ws.map(({ annictId: _a, wikidataId: _w, ...w }) => ({ ...w, episodes: w.episodes.sort((a, b) => a - b) })),
        disambiguation, prefixSiblings: [...siblings].slice(0, 8),
      },
    });
  }
  return { routed, unknownFrom };
}

/**
 * 区間の照合キーで始まる、ほかの作品名（同名の別作品を含む）。枠の時点で公開済みのものだけ。
 * 同じ作品（キー・MyAnimeList の ID が同じ）は除く。アニメのDBの作品と同名の Wikidata のアニメの項目は、
 * 同じ作品を別のDBで見ているだけのことが多いので除く（逆も同じ）
 */
export function siblingTitles(
  w: { keys: string[]; mal: number | null; title: string; text: string },
  pool: WorkCandidate[],
  eventAt: number | null,
  cfg: ExtractConfig,
): string[] {
  const key = matchKey(w.text, cfg);
  if (key.length < 2) return [];
  const selfWikidata = w.keys.every((k) => k.startsWith("wikidata:"));
  // 作品がアニメか（アニメのDBの作品はアニメ。Wikidata の作品は照会結果の isAnime。分からなければ null）
  const selfAnime = !selfWikidata ? true : pool.find((x) => w.keys.includes(x.sourceKey))?.isAnime ?? null;
  const out = new Set<string>();
  for (const c of pool) {
    if (w.keys.includes(c.sourceKey) || (c.malId !== null && c.malId === w.mal)) continue;
    const ck = matchKey(c.title, cfg);
    if (!ck.startsWith(key)) continue;
    // 同名で照会先が違うアニメどうし（Annict の作品と Wikidata のアニメの記事）は、同じ作品を別のDBで見ているだけとみなす。
    // 実写の作品と同名のアニメは別作品として残す（「アラジン」）
    const cAnime = c.source !== "wikidata" || !!c.isAnime;
    const crossDb = (c.source === "wikidata") !== selfWikidata;
    if (ck === key && crossDb && cAnime && selfAnime === true) continue;
    if (eventAt !== null) {
      const st = releaseStart(c) ?? (c.releaseYear ? Date.UTC(c.releaseYear, 0, 1) : null);
      if (st !== null && st > eventAt + 31 * 86_400_000) continue;
    }
    out.add(`${c.title}（${c.sourceKey}・${c.media ?? "?"}・${c.releaseYear ?? "?"}）`);
  }
  return [...out];
}

/** 抽出の層（型。作品ではないの型は語の種類ごと）を、ROUTES の順に並べる */
export function strataOf(routed: Routed[]): { key: string; type: RouteType; sub: string | null; rows: Routed[] }[] {
  const out: { key: string; type: RouteType; sub: string | null; rows: Routed[] }[] = [];
  for (const t of Object.keys(ROUTES) as RouteType[]) {
    const rs = routed.filter((r) => r.rule.type === t);
    const subs = [...new Set(rs.map((r) => r.rule.sub ?? null))];
    if (subs.length === 0) out.push({ key: t, type: t, sub: null, rows: [] });
    for (const sub of subs) out.push({ key: stratumOf({ type: t, sub }), type: t, sub, rows: rs.filter((r) => (r.rule.sub ?? null) === sub) });
  }
  return out;
}


/** 枠の型を event_resolution.route に記録する（名寄せのたびに DB 全体）。層ごとの件数を返す */
export async function persistRoutes(ctx: Ctx, cfg: ExtractConfig): Promise<Record<string, number>> {
  const { routed } = await collectRoutes(ctx, cfg);
  const now = new Date().toISOString();
  const counts: Record<string, number> = {};
  const up = ctx.db.prepare("UPDATE event_resolution SET route = ?, route_sub = ?, route_at = ? WHERE watch_event_id = ?");
  ctx.db.exec("BEGIN");
  try {
    for (const r of routed) {
      up.run(r.rule.type, r.rule.sub ?? null, now, r.ev.id);
      const k = stratumOf(r.rule);
      counts[k] = (counts[k] ?? 0) + 1;
    }
    ctx.db.exec("COMMIT");
  } catch (e) {
    ctx.db.exec("ROLLBACK");
    throw e;
  }
  return counts;
}

/**
 * サイトでの出し方ごとの件数（publishState。AI の判定待ちの内訳は型ごと）。終わった枠だけを数え、
 * 予定枠・配信中の枠（サイトに出さず、AI の待ち行列にも入れない。2026-10-27 の決定 D-01）は notEnded に別に数える
 */
export function publishSummary(ctx: Ctx, cfg: ExtractConfig): { states: Record<string, number>; pendingByRoute: Record<string, number>; noRoute: number; notEnded: number } {
  const cutoff = farFutureCutoff(ctx.crawlCfg.upcoming.max_days_ahead);
  const rows = ctx.db.prepare(`SELECT e.id, e.status AS event_status, er.route, er.route_sub,
      (SELECT a.status FROM ai_decisions a WHERE a.watch_event_id = e.id AND a.revoked_at IS NULL) AS ai_status,
      (SELECT a.confidence FROM ai_decisions a WHERE a.watch_event_id = e.id AND a.revoked_at IS NULL) AS ai_conf,
      EXISTS (SELECT 1 FROM event_works ew WHERE ew.watch_event_id = e.id) AS has_works,
      (SELECT u.reason FROM unresolved u WHERE u.watch_event_id = e.id AND u.resolved_at IS NULL) AS reason
    FROM watch_events e LEFT JOIN event_resolution er ON er.watch_event_id = e.id WHERE ${activeEventSql("e")}`).all(cutoff) as Record<string, string | number | null>[];
  const states: Record<string, number> = {};
  const pendingByRoute: Record<string, number> = {};
  let noRoute = 0;
  let notEnded = 0;
  for (const r of rows) {
    if (r.event_status !== "completed") {
      notEnded++;
      continue;
    }
    if (!r.route) noRoute++;
    const s = publishState({
      type: r.route as string | null, sub: r.route_sub as string | null,
      ai: r.ai_status ? { status: String(r.ai_status), confidence: String(r.ai_conf) } : null,
      hasWorks: !!r.has_works, unresolvedReason: r.reason as string | null,
    }, cfg.ai_routes ?? []);
    states[s] = (states[s] ?? 0) + 1;
    if (s === "pending_ai") {
      const k = r.route ? stratumOf({ type: r.route as RouteType, sub: r.route_sub as string | null }) : "（型なし）";
      pendingByRoute[k] = (pendingByRoute[k] ?? 0) + 1;
    }
  }
  return { states, pendingByRoute, noRoute, notEnded };
}
