// サイト（Astro）に渡すデータの形と、ジョブ・ビルド・ブラウザで共有する表示の決まり。
//
//   ジョブ（src/publish/）が DB からサイト用のデータ（SiteData）を書き出し、Astro がそれを読んで HTML と JSON を作る。
//   ブラウザの絞り込み・並べ替えも同じ表示の決まり（種別形式・時期・話数・再生数）を使うので、ここは DOM・Node に依存しない純粋関数だけにする。

import type { Affiliation, Branch, EventStatus, WorkKind, WorkMedia } from "./types.ts";

export type Season = "winter" | "spring" | "summer" | "autumn";
export const SEASONS: readonly Season[] = ["winter", "spring", "summer", "autumn"];
export const SEASON_LABEL: Record<Season, string> = { winter: "冬", spring: "春", summer: "夏", autumn: "秋" };

/** 作品一覧・パンくずの種類のページ（URL の名前） */
export const KIND_SLUG: Record<WorkKind, string> = { anime: "anime", tokusatsu: "tokusatsu", live_action: "live-action" };

// ---------------------------------------------------------------- 書き出すデータ（ビルドの入力。公開しない）

export interface SiteStreamer {
  id: number;
  channelId: string;
  name: string;
  /** 英語の名前。日本以外の区分の配信者に併記する（名前と同じなら出さない） */
  nameEn: string | null;
  affiliation: Affiliation;
  branch: Branch;
  iconUrl: string | null;
  isActive: boolean;
  /** 配信者ページを作るか（終わった枠が1つ以上） */
  hasPage: boolean;
  /** 集計（サイトに出る終わった枠だけ） */
  eventsCount: number;
  worksCount: number;
  membersCount: number;
  firstEventAt: string | null;
  latestEventAt: string | null;
  /** ページの中身が変わった日（sitemap の lastmod） */
  lastmod: string | null;
}

export interface SiteWork {
  id: number;
  /** URL の公開キー（annict-1234 / anilist-5678 / wikidata-Q123）。一度出したら変えない。作品ページの無い作品（publish_upcoming で予定枠だけに付いた作品）は null */
  key: string | null;
  title: string;
  titleKana: string | null;
  kind: WorkKind | null;
  media: WorkMedia | null;
  year: number | null;
  /** 放送期（Annict・AniList の TV・Web のアニメだけ） */
  season: Season | null;
  /** 制作国（ISO 3166-1 alpha-2）。分からなければ null */
  countries: string[] | null;
  seriesId: string | null;
  seriesTitle: string | null;
  episodesCount: number | null;
  /** AniList の画像 URL（参照するだけ） */
  imageUrl: string | null;
  annictId: number | null;
  anilistId: number | null;
  wikidataId: string | null;
  /** 作品ページを作るか（終わった枠が1つ以上） */
  hasPage: boolean;
  streamersCount: number;
  eventsCount: number;
  membersCount: number;
  /** 公開枠の再生数の最大・合計。取れた枠が無ければ null（0 と区別する） */
  viewsMax: number | null;
  viewsTotal: number | null;
  firstEventAt: string | null;
  latestEventAt: string | null;
  lastmod: string | null;
}

/** 作品を付けずに出す枠の見せ方 */
export interface SiteFrame {
  /** 作品名（外部DBに無い作品・同じ題の別作品のどれか決まらない枠）なら true、枠のタイトルなら false */
  named: boolean;
  title: string;
  kind: WorkKind | null;
  movie: boolean | null;
}

export interface SiteEvent {
  id: number;
  videoId: string;
  streamerId: number;
  /** 実開始（予定枠は予定時刻、ライブでない動画は公開日時） */
  startedAt: string;
  status: EventStatus;
  membersOnly: boolean;
  /** 再生数。メン限・予定枠は null */
  views: number | null;
  thumbnailUrl: string | null;
  /** 付いた作品と、その枠で観た話数の表記（無ければ null） */
  works: { id: number; episodes: string | null }[];
  /** 複数作品の枠で、外部DBに無い作品の名前（リンクなしで並べる） */
  missing: string[];
  /** 作品を付けずに出す枠（works は空） */
  frame: SiteFrame | null;
}

export interface SiteData {
  /** 書き出した時刻（ビルドの時刻。ランキングの期間の基準） */
  generatedAt: string;
  /** 再生数を最後に取った時刻 */
  viewsFetchedAt: string | null;
  streamers: SiteStreamer[];
  works: SiteWork[];
  /** サイトに出る枠（終わった枠だけ。config/site.yaml の publish_upcoming が true なら予定枠・配信中の枠も） */
  events: SiteEvent[];
  /** 公開キーが変わった作品の 301（古い URL → 新しい URL） */
  redirects: { from: string; to: string }[];
  /** 出し方は work なのに作品の行が無く、出さなかった枠（起きないはず。起きたら名寄せの不具合） */
  skipped?: { noWorks: number[] };
}

// ---------------------------------------------------------------- URL

export function workPath(key: string): string {
  return `/works/${key}/`;
}

export function streamerPath(channelId: string): string {
  return `/streamers/${channelId}/`;
}

/** 作品の公開キーを外部DBの ID から作る（annict > anilist > wikidata） */
export function publicKeyOf(ids: { annictId: number | null; anilistId: number | null; wikidataId: string | null }): string | null {
  if (ids.annictId != null) return `annict-${ids.annictId}`;
  if (ids.anilistId != null) return `anilist-${ids.anilistId}`;
  if (ids.wikidataId) return `wikidata-${ids.wikidataId}`;
  return null;
}

export function youtubeUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

/** サムネイル（i.ytimg.com の mqdefault。320×180） */
export function thumbnailUrl(videoId: string): string {
  return `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;
}

/** チャンネルのアイコンの大きさを変える（yt3.ggpht.com の「=s240-…」） */
export function iconAt(url: string | null, px: number): string | null {
  return url ? url.replace(/=s\d+(-[^/]*)?$/, `=s${px}$1`) : null;
}

// ---------------------------------------------------------------- 表示の決まり（モックアップ「作品の属性の出し方」）

const FORM: Record<WorkKind, Partial<Record<WorkMedia, string>> & { other: string }> = {
  anime: { tv: "TVアニメ", movie: "アニメ映画", ova: "OVA", web: "Webアニメ", other: "アニメ" },
  tokusatsu: { tv: "特撮", movie: "特撮映画", other: "特撮" },
  live_action: { tv: "ドラマ", movie: "実写映画", other: "実写" },
};

/** 種別と形式の短い表記（「TVアニメ」「実写映画」）。種別が分からない映画は「映画」。分からなければ空 */
export function formLabel(kind: WorkKind | null, media: WorkMedia | null): string {
  if (!kind) return media === "movie" ? "映画" : "";
  const f = FORM[kind];
  return (media ? f[media] : undefined) ?? f.other;
}

/** 時期。TV・Web のアニメで放送期が分かれば「2013年春」、ほかは「1985年」。分からなければ空 */
export function periodLabel(w: { kind: WorkKind | null; media: WorkMedia | null; year: number | null; season: Season | null }): string {
  if (w.year == null) return "";
  if (w.kind === "anime" && (w.media === "tv" || w.media === "web") && w.season) return `${w.year}年${SEASON_LABEL[w.season]}`;
  return `${w.year}年`;
}

/** 行・カードの1行（「TVアニメ · 2013年春」。枠カードで話数があれば時期の代わりに話数） */
export function metaLine(w: { kind: WorkKind | null; media: WorkMedia | null; year: number | null; season: Season | null }, episodes?: string | null): string {
  return [formLabel(w.kind, w.media), episodes || periodLabel(w)].filter(Boolean).join(" · ");
}

/** 1枠に複数作品のカードの1行（「TVアニメ・特撮 · 3作品」） */
export function multiMetaLine(ws: { kind: WorkKind | null; media: WorkMedia | null }[], extra = 0): string {
  const forms = [...new Set(ws.map((w) => formLabel(w.kind, w.media)).filter(Boolean))].join("・");
  return [forms, `${ws.length + extra}作品`].filter(Boolean).join(" · ");
}

/** 再生数（「1,234回」「3.4万回」「104万回」「1.2億回」）。null は「—」 */
export function formatViews(n: number | null): string {
  if (n == null) return "—";
  if (n < 10_000) return `${n.toLocaleString("ja-JP")}回`;
  if (n < 100_000_000) {
    const man = n / 10_000;
    return man >= 100 ? `${Math.floor(man).toLocaleString("ja-JP")}万回` : `${man.toFixed(1)}万回`;
  }
  return `${(n / 100_000_000).toFixed(1)}億回`;
}

/** 再生数を数と単位に分ける（作品ページの集計の「19.9 万回」） */
export function splitViews(n: number | null): { num: string; unit: string } {
  const s = formatViews(n);
  const m = /^([\d.,]+)(.*)$/.exec(s);
  return m ? { num: m[1]!, unit: m[2]! } : { num: s, unit: "" };
}

const JST = 9 * 3_600_000;
const pad = (n: number) => String(n).padStart(2, "0");
const jst = (iso: string) => new Date(Date.parse(iso) + JST);

/** 「2026/09/22」（日本時間） */
export function formatDate(iso: string | null): string {
  if (!iso) return "";
  const d = jst(iso);
  return `${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}`;
}

/** 「2020/09」（日本時間） */
export function formatMonth(iso: string | null): string {
  if (!iso) return "";
  const d = jst(iso);
  return `${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}`;
}

/** 「2026-10-19」（日本時間。sitemap の lastmod） */
export function isoDateJst(iso: string): string {
  return formatDate(iso).replaceAll("/", "-");
}

/**
 * 1枠で観た話の表記。続いた番号は「第1話〜第4話」、飛んだ番号は「・」でつなぐ（「第1話〜第3話・第5話」）。
 * 番号の表記（number_text。「第1羽」「第壱話」）はそのまま使う
 */
export function episodeLabel(eps: { number: number | null; text: string }[]): string | null {
  const xs = [...eps].sort((a, b) => (a.number ?? Infinity) - (b.number ?? Infinity));
  if (xs.length === 0) return null;
  const runs: { first: (typeof xs)[number]; last: (typeof xs)[number] }[] = [];
  for (const e of xs) {
    const cur = runs.at(-1);
    if (cur && cur.last.number != null && e.number != null && e.number === cur.last.number + 1) cur.last = e;
    else runs.push({ first: e, last: e });
  }
  return runs.map((r) => (r.first === r.last ? r.first.text : `${r.first.text}〜${r.last.text}`)).join("・");
}

/** 所属の表記（一覧の行は「にじさんじ EN」。日本は区分を書かない） */
export function affiliationLabel(aff: Affiliation, branch: Branch | null, labels: { aff: Record<Affiliation, string>; branch: Record<Branch, string> }): string {
  return branch && branch !== "jp" ? `${labels.aff[aff]} ${labels.branch[branch]}` : labels.aff[aff];
}

/** 英語の名前を併記するか（日本以外の区分で、名前と違うとき） */
export function showsNameEn(s: { branch: Branch; name: string; nameEn: string | null }): boolean {
  return s.branch !== "jp" && !!s.nameEn && s.nameEn !== s.name;
}

/** 名前順の並べ方（読みがな、無ければ作品名。日本語の照合順） */
export const jaCollator = new Intl.Collator("ja", { numeric: true, sensitivity: "base" });

// ---------------------------------------------------------------- 並べ替え（ブラウザとビルドで同じ規則）

/**
 * 再生数で並べる。値のある行を多い順（逆順で少ない順）、値の無い行（メン限など）は逆順に関係なく末尾で、最終視聴日の新しい順。
 * NULL を 0 として扱わない
 */
export function sortByViews<T>(rows: T[], views: (r: T) => number | null, latest: (r: T) => string | number | null, reverse = false): T[] {
  const cmpLatest = (a: T, b: T) => {
    const x = latest(a);
    const y = latest(b);
    if (typeof x === "number" && typeof y === "number") return y - x;
    return String(y ?? "").localeCompare(String(x ?? ""));
  };
  const has = rows.filter((r) => views(r) != null).sort((a, b) => (reverse ? views(a)! - views(b)! : views(b)! - views(a)!) || cmpLatest(a, b));
  const none = rows.filter((r) => views(r) == null).sort(cmpLatest);
  return has.concat(none);
}
