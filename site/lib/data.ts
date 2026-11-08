// ビルド時に読むサイト用のデータ（data/site/site-data.json。npm run cli -- site:data が書き出す）と、ページごとの組み立て。
// ビルドのときだけ動く（Node）。ブラウザには持ち込まない。

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import type { Affiliation, Branch, WorkKind } from "../../src/shared/types.ts";
import { AFFILIATIONS } from "../../src/shared/types.ts";
import type { SiteConfig } from "../../src/lib/config.ts";
import type { SiteData, SiteEvent, SiteStreamer, SiteWork } from "../../src/shared/site.ts";
import { KIND_SLUG, jaCollator, sortByViews } from "../../src/shared/site.ts";
import type { WorkSort, WorkTab } from "./encode.ts";

// ビルドは Astro がまとめたファイルから動くので、場所はリポジトリの直下（作業ディレクトリ）から決める
const ROOT = process.cwd();
const DATA_PATH = process.env.SITE_DATA ?? join(ROOT, "data", "site", "site-data.json");

export const cfg = parse(readFileSync(join(ROOT, "config", "site.yaml"), "utf8")) as SiteConfig;

function load(): SiteData {
  try {
    return JSON.parse(readFileSync(DATA_PATH, "utf8")) as SiteData;
  } catch (e) {
    throw new Error(`サイト用のデータ ${DATA_PATH} を読めません。先に npm run cli -- site:data を実行してください（${(e as Error).message}）`);
  }
}

export const site = load();
export const now = new Date(site.generatedAt);

export const streamerById = new Map(site.streamers.map((s) => [s.id, s]));
export const workById = new Map(site.works.map((w) => [w.id, w]));
export const workByKey = new Map(site.works.filter((w) => w.key).map((w) => [w.key!, w]));

/** 終わった枠（新しい順） */
export const completed = site.events.filter((e) => e.status === "completed").sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id - a.id);

export const eventsByWork = new Map<number, SiteEvent[]>();
export const eventsByStreamer = new Map<number, SiteEvent[]>();
for (const e of completed) {
  for (const w of e.works) eventsByWork.set(w.id, [...(eventsByWork.get(w.id) ?? []), e]);
  eventsByStreamer.set(e.streamerId, [...(eventsByStreamer.get(e.streamerId) ?? []), e]);
}

export const workPages = site.works.filter((w) => w.hasPage && w.key);
export const streamerPages = site.streamers.filter((s) => s.hasPage);

// ---------------------------------------------------------------- トップ

/** ランキング（枠単位。期間内の公開枠を再生数の多い順。作品の付いた枠だけ）。days が 0 なら全期間。limit は既定で設定の枠数 */
export function ranking(days: number, limit: number): SiteEvent[] {
  const from = days ? new Date(now.getTime() - days * 86_400_000).toISOString() : "";
  return completed.filter((e) => !e.membersOnly && e.views != null && e.works.length > 0 && e.startedAt >= from)
    .sort((a, b) => b.views! - a.views! || b.startedAt.localeCompare(a.startedAt))
    .slice(0, limit);
}

// ---------------------------------------------------------------- 作品一覧

export const TAB_LABEL: Record<WorkTab, string> = { all: "すべて", anime: "アニメ", tokusatsu: "特撮", "live-action": "実写" };
export const TAB_KIND: Record<Exclude<WorkTab, "all">, WorkKind> = { anime: "anime", tokusatsu: "tokusatsu", "live-action": "live_action" };

export function tabPath(tab: WorkTab, page = 1): string {
  const base = tab === "all" ? "/works/" : `/works/${tab}/`;
  return page > 1 ? `${base}page/${page}/` : base;
}

export function kindTab(kind: WorkKind | null): Exclude<WorkTab, "all"> | null {
  return kind ? (KIND_SLUG[kind] as Exclude<WorkTab, "all">) : null;
}

export function worksOfTab(tab: WorkTab): SiteWork[] {
  return tab === "all" ? workPages : workPages.filter((w) => w.kind === TAB_KIND[tab]);
}

const latestOf = (w: SiteWork) => w.latestEventAt ?? "";

/**
 * 作品一覧の並び。配信者数（同じなら最終視聴日の新しい順）・再生数（無い作品は逆順に関係なく末尾）・最終視聴日。
 * 逆順は主のキーだけを逆にする（同じ値のときの並びは変えない）
 */
export function sortWorks(ws: SiteWork[], sort: WorkSort, reverse: boolean): SiteWork[] {
  const byLatest = (a: SiteWork, b: SiteWork) => latestOf(b).localeCompare(latestOf(a)) || a.id - b.id;
  if (sort === "views") return sortByViews(ws, (w) => w.viewsMax, latestOf, reverse);
  if (sort === "latest") return [...ws].sort((a, b) => (reverse ? -1 : 1) * byLatest(a, b));
  return [...ws].sort((a, b) => (reverse ? a.streamersCount - b.streamersCount : b.streamersCount - a.streamersCount) || byLatest(a, b));
}

export function pageCount(n: number): number {
  return Math.max(1, Math.ceil(n / cfg.works_page_size));
}

// ---------------------------------------------------------------- 配信者一覧

export const AFF_SLUG: Record<Exclude<Affiliation, "other">, string> = { nijisanji: "nijisanji", hololive: "hololive", vspo: "vspo" };
export const STREAMER_AFFS = AFFILIATIONS.filter((a): a is Exclude<Affiliation, "other"> => a !== "other");
export const BRANCH_ORDER: Branch[] = ["jp", "en", "kr", "id"];

export function streamersOf(aff: Affiliation | "all"): SiteStreamer[] {
  return streamerPages.filter((s) => aff === "all" || s.affiliation === aff)
    .sort((a, b) => (b.latestEventAt ?? "").localeCompare(a.latestEventAt ?? "") || jaCollator.compare(a.name, b.name));
}

// ---------------------------------------------------------------- 作品ページ・配信者ページ

/** 作品ページの配信者の行（1配信者＝1行。枠は日付の昇順） */
export interface WorkStreamerRow {
  streamer: SiteStreamer;
  events: SiteEvent[];
  members: number;
  viewsMax: number | null;
  latest: string;
}

export function streamerRowsOf(w: SiteWork): WorkStreamerRow[] {
  const by = new Map<number, SiteEvent[]>();
  for (const e of eventsByWork.get(w.id) ?? []) by.set(e.streamerId, [...(by.get(e.streamerId) ?? []), e]);
  const rows = [...by].map(([sid, evs]) => {
    const asc = [...evs].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    const vs = evs.map((e) => e.views).filter((v): v is number => v != null);
    return { streamer: streamerById.get(sid)!, events: asc, members: evs.filter((e) => e.membersOnly).length, viewsMax: vs.length ? Math.max(...vs) : null, latest: asc.at(-1)!.startedAt };
  });
  return sortByViews(rows, (r) => r.viewsMax, (r) => r.latest);
}

/** 同じシリーズの作品（series_title のある作品を series_id でまとめる。放送順） */
export function seriesOf(w: SiteWork): SiteWork[] {
  if (!w.seriesId || !w.seriesTitle) return [];
  const SEASON_ORDER = { winter: 0, spring: 1, summer: 2, autumn: 3 } as const;
  const xs = workPages.filter((x) => x.seriesId === w.seriesId && x.seriesTitle);
  return xs.length < 2 ? [] : xs.sort((a, b) => (a.year ?? 9999) - (b.year ?? 9999)
    || (a.season ? SEASON_ORDER[a.season] : 9) - (b.season ? SEASON_ORDER[b.season] : 9)
    || (a.firstEventAt ?? "").localeCompare(b.firstEventAt ?? "") || a.id - b.id);
}

/** 配信者ページの作品の行（1作品＝1行。枠は日付の昇順） */
export interface StreamerWorkRow {
  work: SiteWork;
  events: SiteEvent[];
  episodes: Map<number, string | null>;
  viewsMax: number | null;
  latest: string;
}

/** 配信者ページの作品の行（既定は名前順。読みがな、無ければ作品名） */
export function workRowsOf(s: SiteStreamer): StreamerWorkRow[] {
  const by = new Map<number, SiteEvent[]>();
  for (const e of eventsByStreamer.get(s.id) ?? []) for (const w of e.works) by.set(w.id, [...(by.get(w.id) ?? []), e]);
  return [...by].map(([wid, evs]) => {
    const asc = [...evs].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    const vs = evs.map((e) => e.views).filter((v): v is number => v != null);
    return {
      work: workById.get(wid)!,
      events: asc,
      episodes: new Map(asc.map((e) => [e.id, e.works.find((x) => x.id === wid)?.episodes ?? null])),
      viewsMax: vs.length ? Math.max(...vs) : null,
      latest: asc.at(-1)!.startedAt,
    };
  }).sort((a, b) => jaCollator.compare(nameKey(a.work), nameKey(b.work)) || a.work.id - b.work.id);
}

/** 名前順の鍵（読みがな、無ければ作品名） */
export const nameKey = (w: SiteWork) => w.titleKana ?? w.title;

/** 配信者の作品を付けない枠（作品ページの無い枠。新しい順） */
export function framesOf(s: SiteStreamer): SiteEvent[] {
  return (eventsByStreamer.get(s.id) ?? []).filter((e) => e.frame);
}

/** 再生数の最終更新（フッター） */
export const viewsUpdated = site.viewsFetchedAt;
