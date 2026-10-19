// ブラウザに渡す JSON の形（操作のあとに読む。本文はビルド時の HTML）。
// ビルド（Astro のエンドポイント）が書き、ブラウザのスクリプトが読む。どちらも同じ関数で HTML を作るので、ここで形を1つに決める。
// 1ファイル数十KBを目安に、配列の位置で項目を持つ（キーの名前を繰り返さない）。

import type { Affiliation, Branch, WorkKind, WorkMedia } from "../../src/shared/types.ts";
import type { Season, SiteEvent, SiteStreamer, SiteWork } from "../../src/shared/site.ts";
import { streamerPath, workPath } from "../../src/shared/site.ts";

// ---------------------------------------------------------------- トップの枠

/** 配信者の辞書の値: [配信者ページのパス（無ければ ""）, 名前, 所属, 区分, アイコンの URL（無ければ ""）] */
export type DictStreamer = [href: string, name: string, aff: Affiliation, branch: Branch, icon: string];
/** 作品の辞書の値: [作品ページのパス（無ければ ""）, 作品名, 種類, 形式, 年（不明は 0）, 放送期, 制作国（「JP,US」。不明は "?"）] */
export type DictWork = [href: string, title: string, kind: WorkKind | "", media: WorkMedia | "", year: number, season: Season | "", countries: string];

export interface TopDict {
  s: Record<string, DictStreamer>;
  w: Record<string, DictWork>;
}

/** 作品を付けない枠: [枠のタイトルか作品名, 作品名なら 1, 種類, 映画なら 1・映画でなければ 0・不明は -1] */
export type RowFrame = [title: string, named: 0 | 1, kind: WorkKind | "", movie: 1 | 0 | -1];

/**
 * 枠の行: [動画 ID, 開始（UNIX 秒）, 再生数, メン限なら 1, 配信者の id, 作品（id か [id, 話数]）, 作品を付けない枠（無ければ 0）, 外部DBに無い作品の名前]
 * 予定枠・配信中の枠は 8 番目に状態（"upcoming" / "live"）を持つ
 */
export type TopRow = [
  videoId: string,
  t: number,
  views: number | null,
  members: 0 | 1,
  sid: number,
  works: (number | [number, string])[],
  frame: RowFrame | 0,
  missing: string[],
  status?: "upcoming" | "live",
];

export interface TopRecent {
  d: TopDict;
  e: TopRow[];
}

export const toSec = (iso: string) => Math.floor(Date.parse(iso) / 1000);

export function encodeRow(e: SiteEvent): TopRow {
  const row: TopRow = [
    e.videoId,
    toSec(e.startedAt),
    e.views,
    e.membersOnly ? 1 : 0,
    e.streamerId,
    e.works.map((w) => (w.episodes ? [w.id, w.episodes] : w.id)),
    e.frame ? [e.frame.title, e.frame.named ? 1 : 0, e.frame.kind ?? "", e.frame.movie == null ? -1 : e.frame.movie ? 1 : 0] : 0,
    e.missing,
  ];
  if (e.status !== "completed") row.push(e.status);
  return row;
}

export function encodeStreamer(s: SiteStreamer): DictStreamer {
  return [s.hasPage ? streamerPath(s.channelId) : "", s.name, s.affiliation, s.branch, s.iconUrl ?? ""];
}

export function encodeWork(w: SiteWork): DictWork {
  return [
    w.hasPage && w.key ? workPath(w.key) : "", w.title, w.kind ?? "", w.media ?? "", w.year ?? 0, w.season ?? "",
    w.countries ? w.countries.join(",") : "?",
  ];
}

/** 枠の行に出てくる配信者・作品だけの辞書 */
export function dictFor(events: SiteEvent[], streamerById: Map<number, SiteStreamer>, workById: Map<number, SiteWork>): TopDict {
  const d: TopDict = { s: {}, w: {} };
  for (const e of events) {
    const s = streamerById.get(e.streamerId);
    if (s) d.s[s.id] = encodeStreamer(s);
    for (const x of e.works) {
      const w = workById.get(x.id);
      if (w) d.w[w.id] = encodeWork(w);
    }
  }
  return d;
}

// ---------------------------------------------------------------- 作品一覧

export const ANILIST_COVER = "https://s4.anilist.co/file/anilistcdn/media/anime/cover/";

/** 画像の URL を短くする（AniList の表紙の共通の頭を「~」に） */
export const packImage = (u: string | null) => (u ? (u.startsWith(ANILIST_COVER) ? `~${u.slice(ANILIST_COVER.length)}` : u) : "");
export const unpackImage = (u: string) => (u ? (u.startsWith("~") ? ANILIST_COVER + u.slice(1) : u) : null);

/** 作品一覧の行: [公開キー, 作品名, 種類, 形式, 年, 放送期, 画像, 観た配信者数, 最高再生数, 最終視聴（UNIX 秒）] */
export type WorkListRow = [
  key: string,
  title: string,
  kind: WorkKind | "",
  media: WorkMedia | "",
  year: number,
  season: Season | "",
  image: string,
  streamers: number,
  viewsMax: number | null,
  latest: number,
];

export function encodeWorkRow(w: SiteWork): WorkListRow {
  return [w.key ?? "", w.title, w.kind ?? "", w.media ?? "", w.year ?? 0, w.season ?? "", packImage(w.imageUrl), w.streamersCount, w.viewsMax, w.latestEventAt ? toSec(w.latestEventAt) : 0];
}

export interface WorkListPage {
  /** 全体の件数とページ数 */
  total: number;
  pages: number;
  page: number;
  rows: WorkListRow[];
}

/** 作品名の検索の索引: 一覧の行 ＋ 読みがな */
export type WorkSearchRow = [...WorkListRow, kana: string];

export type WorkSort = "streamers" | "views" | "latest";
export const WORK_SORTS: readonly WorkSort[] = ["streamers", "views", "latest"];
export type WorkTab = "all" | "anime" | "tokusatsu" | "live-action";
export const WORK_TABS: readonly WorkTab[] = ["all", "anime", "tokusatsu", "live-action"];

export function workListJsonPath(tab: WorkTab, sort: WorkSort, reverse: boolean, page: number): string {
  return `/data/works/${tab}/${sort}-${reverse ? "asc" : "desc"}-${page}.json`;
}
