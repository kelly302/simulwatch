// 枠カードと作品一覧の行の HTML。ビルド（Astro）とブラウザ（並べ替え・絞り込み・さらに表示）が同じ関数で作る。
// DOM・Node に依存しない（文字列を返す）。値はすべて esc() を通す。

import type { Affiliation, Branch, WorkKind, WorkMedia } from "../../src/shared/types.ts";
import { AFFILIATION_LABEL, BRANCH_LABEL } from "../../src/shared/types.ts";
import type { Season } from "../../src/shared/site.ts";
import {
  formLabel, formatDate, formatViews, iconAt, metaLine, multiMetaLine, thumbnailUrl, youtubeUrl, workPath,
} from "../../src/shared/site.ts";
import type { DictWork, TopDict, TopRow, WorkListRow } from "./encode.ts";
import { unpackImage } from "./encode.ts";

export const esc = (s: string | number) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** 所属の表記（一覧の行。「にじさんじ EN」） */
export function affLabel(aff: Affiliation, branch: Branch | null): string {
  return branch && branch !== "jp" ? `${AFFILIATION_LABEL[aff]} ${BRANCH_LABEL[branch]}` : AFFILIATION_LABEL[aff];
}

// ---------------------------------------------------------------- 枠カード

export interface CardStreamer {
  name: string;
  href: string;
  aff: Affiliation;
  branch: Branch;
  icon: string;
}

export interface CardOptions {
  /** ランキングの順位 */
  rank?: number;
  /** 画像を遅れて読む（最初の画面より下） */
  lazy?: boolean;
}

const workOf = (w: DictWork) => ({ kind: (w[2] || null) as WorkKind | null, media: (w[3] || null) as WorkMedia | null, year: w[4] || null, season: (w[5] || null) as Season | null });

/** アイコン（無ければ名前の1文字目）。lazy を false にするとすぐ読む（画面の上に出るヒーローのアイコン） */
export function avatarHtml(name: string, icon: string | null, px: number, cls = "av", lazy = true): string {
  const src = iconAt(icon, px * 2);
  return src
    ? `<img class="${cls}" src="${esc(src)}" alt="" width="${px}" height="${px}"${lazy ? ' loading="lazy"' : ""} decoding="async" referrerpolicy="no-referrer">`
    : `<span class="${cls}" aria-hidden="true">${esc(name.slice(0, 1))}</span>`;
}

/** 枠の行（TopRow）と辞書から枠カードを作る */
export function cardHtml(row: TopRow, dict: TopDict, opt: CardOptions = {}): string {
  const [videoId, t, views, members, sid, ws, frame, missing] = row;
  const st = dict.s[sid];
  const s: CardStreamer = st ? { href: st[0], name: st[1], aff: st[2], branch: st[3], icon: st[4] } : { href: "", name: "", aff: "other", branch: "jp", icon: "" };
  const works = ws.map((x) => {
    const [id, ep] = Array.isArray(x) ? x : [x, ""];
    const w = dict.w[id];
    return { href: w?.[0] ?? "", title: w?.[1] ?? "", ep, w: w ? workOf(w) : { kind: null, media: null, year: null, season: null } };
  });
  const iso = new Date(t * 1000).toISOString();

  // 作品名（複数は「 / 」で並べる。3行で切る）
  let title: string;
  let meta = "";
  let label: string;
  if (frame) {
    const [ftitle, named, kind, movie] = frame;
    label = ftitle;
    title = named
      ? `<h3 class="ttl">${esc(ftitle)}</h3><span class="tag">作品ページなし</span>`
      : `<h3 class="ttl plain">${esc(ftitle)}</h3><span class="tag">枠のタイトル</span>`;
    if (named) meta = formLabel((kind || null) as WorkKind | null, movie === 1 ? "movie" : null);
  } else {
    const parts = [
      ...works.map((w) => (w.href ? `<a href="${esc(w.href)}">${esc(w.title)}</a>` : `<span>${esc(w.title)}</span>`)),
      ...missing.map((m) => `<span>${esc(m)}</span>`),
    ];
    label = [...works.map((w) => w.title), ...missing].join("・");
    title = `<h3 class="ttl">${parts.join('<span class="sep"> / </span>')}</h3>`;
    meta = works.length + missing.length > 1 ? multiMetaLine(works.map((w) => w.w), missing.length) : works[0] ? metaLine(works[0].w, works[0].ep) : "";
  }
  if (opt.rank) title = `<div class="title-row"><span class="rank" aria-label="${opt.rank}位">${opt.rank}</span>${title}</div>`;

  const brTag = s.branch !== "jp" ? `<span class="br" aria-label="${esc(affLabel(s.aff, s.branch))}">${esc(BRANCH_LABEL[s.branch])}</span>` : "";
  const who = `${avatarHtml(s.name, s.icon || null, 22)}<span class="nm">${esc(s.name)}</span>${brTag}`;
  const whoHtml = s.href ? `<a class="who" href="${esc(s.href)}">${who}</a>` : `<span class="who">${who}</span>`;

  const foot = `<span>${esc(formatDate(iso))}</span>${members ? '<span class="badge mem">メン限</span>' : `<span class="views">${esc(formatViews(views))}</span>`}`;

  const lazy = opt.lazy === false ? "" : ' loading="lazy"';
  return `<article class="card">
<a class="thumb" href="${esc(youtubeUrl(videoId))}" aria-label="YouTube で開く（${esc(label)}・${esc(s.name)}）"><img src="${esc(thumbnailUrl(videoId))}" alt="" width="320" height="180"${lazy} decoding="async" referrerpolicy="no-referrer"></a>
${title}
${meta ? `<p class="meta">${esc(meta)}</p>` : ""}
${whoHtml}
<div class="foot">${foot}</div>
</article>`;
}

// ---------------------------------------------------------------- 作品一覧の行

export type WorkRowMetric = "streamers" | "views" | "latest";

/** 作品一覧の行。右の上は並び順の値（配信者数・再生数）、下は最終視聴日 */
/** 行の作品の画像（AniList の画像。無ければ種別形式を書いた桃色の札）。作品一覧の行と配信者ページの作品の行 */
export function workThumbHtml(image: string | null, kind: WorkKind | null, media: WorkMedia | null): string {
  return image
    ? `<img class="wimg" src="${esc(image)}" alt="" width="44" height="62" loading="lazy" decoding="async" referrerpolicy="no-referrer">`
    : `<span class="wimg none" aria-hidden="true">${esc(formLabel(kind, media) || "作品")}</span>`;
}

export function workRowHtml(r: WorkListRow, metric: WorkRowMetric = "streamers", titleHtml?: string): string {
  const [key, title, kind, media, year, season, image, streamers, viewsMax, latest] = r;
  const thumb = workThumbHtml(unpackImage(image), (kind || null) as WorkKind | null, (media || null) as WorkMedia | null);
  const meta = metaLine({ kind: (kind || null) as WorkKind | null, media: (media || null) as WorkMedia | null, year: year || null, season: (season || null) as Season | null });
  const top = metric === "views"
    ? `<span class="num${viewsMax == null ? " none" : ""}">${esc(formatViews(viewsMax))}</span>`
    : `<span class="num">${streamers}<span class="unit">人</span></span>`;
  const bottom = metric === "views" ? `${streamers}人 · ${formatDate(new Date(latest * 1000).toISOString())}` : formatDate(new Date(latest * 1000).toISOString());
  return `<li><a class="wrow" href="${esc(workPath(key))}">${thumb}<span class="wbody"><span class="wttl">${titleHtml ?? esc(title)}</span>${meta ? `<span class="wmeta">${esc(meta)}</span>` : ""}</span><span class="wside">${top}<span class="sub">${esc(bottom)}</span></span></a></li>`;
}

// ---------------------------------------------------------------- 作品の画像のカード（トップのよく同時視聴される作品・作品ページの同じシリーズ。ビルド時だけ）

export interface WorkCardItem {
  key: string;
  title: string;
  image: string | null;
  streamers: number;
  events: number;
  /** 種別形式・時期（「実写映画 · 2001年」）。画像の無い作品の文字のポスターに入れる */
  meta: string;
}

/** 作品の画像と作品名と観た配信者数。画像が無ければ作品名を組んだ文字のポスター。current はいま開いている作品（リンクにしない） */
export function workCardHtml(w: WorkCardItem, opt: { current?: boolean } = {}): string {
  const img = w.image
    ? `<img class="wimg" src="${esc(w.image)}" alt="" width="132" height="185" loading="lazy" decoding="async" referrerpolicy="no-referrer">`
    : `<span class="wimg none" aria-hidden="true"><span class="pt">${esc(w.title)}</span>${w.meta ? `<span class="pf">${esc(w.meta)}</span>` : ""}</span>`;
  const body = `${img}<b>${esc(w.title)}</b>`;
  return opt.current
    ? `<div class="wcard" aria-current="page">${body}<span>この作品</span></div>`
    : `<a class="wcard" href="${esc(workPath(w.key))}">${body}<span><strong>${w.streamers}人</strong>が観た · ${w.events}枠</span></a>`;
}

// ---------------------------------------------------------------- 展開行の中の枠（作品ページ・配信者ページ。ビルド時だけ）

export interface FrameItem {
  videoId: string;
  startedAt: string;
  views: number | null;
  members: boolean;
  /** 話数（「第1話〜第4話」）や作品を付けない枠のタイトル */
  detail?: string | null;
}

/** 展開行の中の枠（日付の昇順で並べる側が渡す）。サムネは開いたときに読む */
export function frameItemHtml(f: FrameItem): string {
  const date = formatDate(f.startedAt);
  // メン限の枠には data-mem（ページの「メン限を除く」で隠す。site/scripts/rows.ts）
  return `<li${f.members ? ' data-mem="1"' : ""}><a class="fthumb" href="${esc(youtubeUrl(f.videoId))}" aria-label="YouTube で開く（${esc(date)} の枠）"><img src="${esc(thumbnailUrl(f.videoId))}" alt="" width="320" height="180" loading="lazy" decoding="async" referrerpolicy="no-referrer"></a><span class="finfo"><span class="fdate">${esc(date)}</span>${f.detail ? `<span class="ftitle">${esc(f.detail)}</span>` : ""}<span class="fviews">${f.members ? '<span class="badge mem">メン限</span>' : `<span>${esc(formatViews(f.views))}</span>`}</span></span></li>`;
}

export const CHECK_ICON = '<svg class="ck" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"></path></svg>';
export const CHEVRON = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 9l6 6 6-6"></path></svg>';
export const EXT_ICON = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M7 17L17 7M9 7h8v8"></path></svg>';
export const REV_ICON = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 4v16M4 17l3 3 3-3M17 20V4M14 7l3-3 3 3"></path></svg>';
