import type { Ctx } from "../lib/context.ts";
import type { ExtractConfig } from "../resolve/config.ts";
import { ResolveCache } from "../resolve/cache.ts";
import { extract } from "../resolve/extract.ts";
import { matchKey } from "../resolve/normalize.ts";
import { HttpError } from "../lib/http.ts";
import { log } from "../lib/log.ts";
import type { DetectConfig } from "../lib/config.ts";
import { detect } from "../detect/detect.ts";
import { chunk } from "../youtube/api.ts";

// AI の判定役に見せる手がかり（2026-10-02 決定。ai-run-1 の採点で、保留の6件中5件が決められたはずだった）。
//   - 同じ配信者の同じ作品名の枠（日付順）: シリーズを順に観ているとき、話数の続き・最終話で、どの作品（期・リメイク）か決まる（刃牙（バキ）は第26話（終）で終わる）
//   - 同じ配信者の前後の枠: 観ている作品の傾向（ディズニーのアニメ映画が続く・ジュラシック・パークを順に観ている）
//   - 概要欄のリンク先の題名: 配信サービス・映画情報サイトのページの題名と公開年・あらすじの冒頭（Amazon Prime Video の「ロスト・ワールド／ジュラシック・パーク (吹替版)」。
//     「君に届け」は題名だけではアニメか実写か分からず、公開年（2010）で実写映画と分かる）
//   - 概要欄の YouTube の動画・再生リストのリンクの題名（2026-10-18）: 夕陽リリの「アニポケ1話～同時視聴」は「公式チャンネルで視聴しています。」の下のリンクが
//     ポケモン公式の1997年版の第1話（今は消えている。再生リストは「アニポケセレクション」）。コラボ相手の同時視聴の枠・Nintendo Direct などの番組も分かる
//   - 同時視聴枠にならなかった同じ配信者の動画（videos_seen の題名だけ。2026-10-18）: 続きの回が題名に同時視聴の語を書かずに配信されていることがある
//     （ルカ・カネシロの ARCANE は、メン限の「STARTING SEASON 2」「SEASON 2 EPISODE 3 AND 4」が続くので、前の4枠はシーズン1）
// ほかの枠のルールの答え・AI の答えは見せない（タイトルと日付だけ）。設定は config/extract.yaml の ai_context

export interface Frame {
  id: number;
  date: string;
  title: string;
}

export interface FrameContext {
  /** 同じ作品名の枠（この枠を含む日付順。this がこの枠） */
  sameName: (Frame & { self?: boolean })[];
  /** 前後の枠（同じ作品名の枠と重ならないもの） */
  around: Frame[];
}

const JST = (t: string | null) => (t ? new Date(Date.parse(t) + 9 * 3_600_000).toISOString().slice(0, 10) : "?");

/** 配信者ごとの同時視聴枠（日付順）。判定から外した枠（excluded_at）は除く */
export function streamerFrames(ctx: Pick<Ctx, "db">): (streamerId: number) => Frame[] {
  const memo = new Map<number, Frame[]>();
  const q = ctx.db.prepare("SELECT id, started_at, title_raw FROM watch_events WHERE streamer_id = ? AND excluded_at IS NULL ORDER BY started_at, id");
  return (sid) => {
    let v = memo.get(sid);
    if (!v) {
      v = (q.all(sid) as { id: number; started_at: string | null; title_raw: string }[]).map((r) => ({ id: r.id, date: JST(r.started_at), title: r.title_raw }));
      memo.set(sid, v);
    }
    return v;
  };
}

/**
 * タイトルの作品名の区間の照合キー（括弧の中身と括弧の外。3文字以上。ハッシュタグは使わない）。
 * 配信者の決まり文句（配信者名を含む区間「花畑チャイカと」、同時視聴枠の10枠以上かつ半分を超える枠に出る区間「王覇山軍」）は除く。frameKeys は配信者の枠のタイトルの照合キー
 */
function workKeys(title: string, cfg: ExtractConfig, streamer: string, frameKeys: string[]): string[] {
  const nameKey = streamer ? matchKey(streamer, cfg) : "";
  const boilerplate = (k: string) => {
    if (nameKey && (k.includes(nameKey) || nameKey.includes(k))) return true;
    const n = frameKeys.filter((t) => t.includes(k)).length;
    return n >= 10 && n > frameKeys.length / 2;
  };
  return [...new Set(extract(title, cfg).segments.filter((s) => s.from !== "hashtag" && s.key.length >= 3).map((s) => s.key))].filter((k) => !boilerplate(k));
}

/**
 * この枠の手がかり。作品名の区間（括弧の中身と括弧の外。照合キー3文字以上）を含むタイトルの枠を「同じ作品名の枠」にする。
 * 配信者の決まり文句（配信者名を含む区間「花畑チャイカと」、10枠以上かつ半分を超える枠に出る区間「王覇山軍」）は使わない
 */
export function frameContext(frames: Frame[], eventId: number, title: string, cfg: ExtractConfig, streamer = ""): FrameContext {
  const ac = cfg.ai_context ?? {};
  const nAround = ac.neighbors ?? 3;
  const nSame = ac.same_name ?? 10;
  const idx = frames.findIndex((f) => f.id === eventId);
  if (idx < 0) return { sameName: [], around: [] };
  const titleKeys = frames.map((f) => matchKey(f.title, cfg));
  const keys = workKeys(title, cfg, streamer, titleKeys);
  const same = keys.length
    ? frames.filter((f, i) => f.id !== eventId && keys.some((k) => titleKeys[i]!.includes(k)))
    : [];
  // この枠に近い順に nSame 件を選び、日付順に並べ直す
  const pos = new Map(frames.map((f, i) => [f.id, i]));
  const near = same
    .sort((a, b) => Math.abs(pos.get(a.id)! - idx) - Math.abs(pos.get(b.id)! - idx))
    .slice(0, nSame);
  const sameIds = new Set(near.map((f) => f.id));
  const sameName = near.length
    ? [...near.map((f) => ({ ...f })), { ...frames[idx]!, self: true }].sort((a, b) => pos.get(a.id)! - pos.get(b.id)!)
    : [];
  const around = [...frames.slice(Math.max(0, idx - nAround), idx), ...frames.slice(idx + 1, idx + 1 + nAround)].filter((f) => !sameIds.has(f.id));
  return { sameName, around };
}

/** 同時視聴枠にならなかった動画（videos_seen の題名だけ） */
export interface Video {
  id: string;
  /** 公開日（日本時間）。ライブ配信は枠を作った日で、配信日と数日ずれることがある */
  date: string;
  /** 公開日時（ミリ秒）。この枠に近い順に選ぶのに使う */
  at: number;
  title: string;
  /** メン限（メン限プレイリストに載っている・題名にメン限の語がある。videos_seen.is_members_hint） */
  members: boolean;
  /** 照合キー（matchKey）と、英数字のキーを単語の切れ目で照合するための題名（NFKC・小文字） */
  key: string;
  norm: string;
}

export interface OtherVideos {
  /** この枠の作品名の区間を題名に含む動画（期間を限らない。この枠に近いものから。日付順） */
  sameName: Video[];
  /** この枠がメン限のとき、前後の期間のメン限の動画（sameName と重ならないもの。この枠に近いものから。日付順） */
  members: Video[];
}

/** 配信者ごとの、同時視聴枠にならなかった動画（日付順）。判定から外した枠（excluded_at）はこちらに入る */
export function streamerVideos(ctx: Pick<Ctx, "db">, cfg: ExtractConfig): (streamerId: number) => Video[] {
  const memo = new Map<number, Video[]>();
  const q = ctx.db.prepare(`SELECT v.video_id, v.published_at, v.title, v.is_members_hint FROM videos_seen v JOIN streamers s ON s.channel_id = v.channel_id
    WHERE s.id = ? AND v.published_at IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM watch_events e WHERE e.video_id = v.video_id AND e.excluded_at IS NULL)
    ORDER BY v.published_at, v.video_id`);
  return (sid) => {
    let v = memo.get(sid);
    if (!v) {
      v = (q.all(sid) as { video_id: string; published_at: string; title: string; is_members_hint: number }[]).map((r) => ({
        id: r.video_id, date: JST(r.published_at), at: Date.parse(r.published_at), title: r.title, members: r.is_members_hint === 1,
        key: matchKey(r.title, cfg), norm: r.title.normalize("NFKC").toLowerCase(),
      }));
      memo.set(sid, v);
    }
    return v;
  };
}

const wordRes = new Map<string, RegExp>();

/**
 * 照合キーが動画の題名に出るか。英数字だけのキーは単語の切れ目で照合する（「air」を「SisterCleaire」に、「sing」を「Missing」に当てない）。
 * キーの文字のあいだの空白・記号は飛ばす（「deathnote」は「DEATH NOTE」に当たる）
 */
export function inTitle(k: string, v: Video): boolean {
  if (!/^[a-z0-9]+$/.test(k)) return v.key.includes(k);
  let re = wordRes.get(k);
  if (!re) {
    re = new RegExp(`(?<![a-z0-9])${[...k].join("[^\\p{L}\\p{N}]*")}(?![a-z0-9])`, "u");
    wordRes.set(k, re);
  }
  return re.test(v.norm);
}

// 区間ごとの、チャンネルの動画のうち題名に出る本数（全部・メン限）。同じ配信者の動画の配列ごとに覚える
const keyCounts = new WeakMap<Video[], { members: number; byKey: Map<string, { all: number; members: number }> }>();

function countKey(videos: Video[], k: string): { all: number; members: number; membersTotal: number } {
  let c = keyCounts.get(videos);
  if (!c) {
    c = { members: videos.filter((v) => v.members).length, byKey: new Map() };
    keyCounts.set(videos, c);
  }
  let n = c.byKey.get(k);
  if (!n) {
    n = { all: 0, members: 0 };
    for (const v of videos) {
      if (!inTitle(k, v)) continue;
      n.all++;
      if (v.members) n.members++;
    }
    c.byKey.set(k, n);
  }
  return { ...n, membersTotal: c.members };
}

/**
 * 枠の題名から、同じ配信者の動画（同時視聴枠にならなかったもの）に照合する作品名の区間の照合キー。同時視聴枠の「同じ作品名の枠」と同じキーから、
 *   - 作品名でない区間（ai_context.other_videos.ignore_keys）
 *   - チャンネルの動画の boilerplate_ratio を超える動画（10本以上）に出る区間（「APEX」「MEMBERSHIP STREAM」）
 *   - メン限の見出しの区間: チャンネルのメン限の動画の members_heading.ratio を超える動画（members_heading.min 本以上）に出る区間
 *     （「メンゲン」「メンゲンノチカラ」「konbinicrew」。メン限の見出しはチャンネルの全動画の3%に届かず、boilerplate_ratio では落ちない。2026-11-04）
 * を除く。判定役に見せる同じ作品名の動画（otherVideos）と、続きの回の候補（src/candidates/select.ts）が同じ決まりを使う。
 * frames は配信者の同時視聴枠（決まり文句の判定に使う）
 */
export function videoKeys(videos: Video[], frames: Frame[], title: string, cfg: ExtractConfig, streamer = ""): string[] {
  const oc = cfg.ai_context?.other_videos ?? {};
  const ratio = oc.boilerplate_ratio ?? 0.03;
  const heading = oc.members_heading;
  const ignore = (oc.ignore_keys ?? []).map((p) => new RegExp(p));
  return workKeys(title, cfg, streamer, frames.map((f) => matchKey(f.title, cfg)))
    .filter((k) => !ignore.some((re) => re.test(k)))
    .filter((k) => {
      const n = countKey(videos, k);
      if (n.all >= 10 && n.all > videos.length * ratio) return false;
      return !(heading && n.members >= heading.min && n.members > n.membersTotal * heading.ratio);
    });
}

/**
 * この枠の、同時視聴枠にならなかった同じ配信者の動画（2026-10-18 決定）。
 *   - 同じ作品名の動画: この枠の作品名の区間（videoKeys）を題名に含む動画（期間を限らない）
 *   - 前後のメン限の動画: この枠がメン限のとき、前後 members_days 日のメン限の動画（同時視聴の枠はメン限が多く、続きの回もメン限で配信されやすい）
 * frames は配信者の同時視聴枠（決まり文句の判定に使う）
 */
export function otherVideos(
  videos: Video[], frames: Frame[], frame: { startedAt: string | null; title: string; membersOnly: boolean }, cfg: ExtractConfig, streamer = "",
): OtherVideos {
  const oc = cfg.ai_context?.other_videos ?? {};
  const nSame = oc.same_name ?? 5;
  const nMembers = oc.members ?? 8;
  const days = oc.members_days ?? 30;
  const t0 = frame.startedAt ? Date.parse(frame.startedAt) : NaN;
  if (!videos.length || Number.isNaN(t0)) return { sameName: [], members: [] };
  const near = (xs: Video[], n: number) =>
    xs.sort((a, b) => Math.abs(a.at - t0) - Math.abs(b.at - t0) || a.at - b.at).slice(0, n).sort((a, b) => a.at - b.at);
  const keys = videoKeys(videos, frames, frame.title, cfg, streamer);
  const sameName = keys.length && nSame > 0 ? near(videos.filter((v) => keys.some((k) => inTitle(k, v))), nSame) : [];
  const picked = new Set(sameName);
  const members = frame.membersOnly && nMembers > 0
    ? near(videos.filter((v) => v.members && !picked.has(v) && Math.abs(v.at - t0) <= days * 86_400_000), nMembers)
    : [];
  return { sameName, members };
}

export interface LinkPage {
  title: string | null;
  /** 公開年（Amazon の releaseYear など。無ければ null） */
  year: number | null;
  /** あらすじ（meta description）の冒頭 */
  summary: string | null;
}

function meta(html: string, attr: "property" | "name", key: string): string | null {
  const a = html.match(new RegExp(`<meta[^>]+${attr}=["']${key}["'][^>]+content=["']([^"']*)["']`, "i"));
  const b = html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+${attr}=["']${key}["']`, "i"));
  return (a ?? b)?.[1] ?? null;
}

/** HTML の実体参照・ゼロ幅の文字・空白を直す */
function clean(t: string | null): string | null {
  if (!t) return null;
  const s = t
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/[\uFEFF\u200B-\u200D\u2060]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return s || null;
}

/** ページの題名（og:title か最初の <title>） */
export function pageTitle(html: string): string | null {
  return clean(meta(html, "property", "og:title") ?? html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] ?? null);
}

/** ページの題名・公開年・あらすじの冒頭（100文字） */
export function pageInfo(html: string): LinkPage {
  const y = html.match(/"releaseYear"\s*:\s*"?(\d{4})/)?.[1] ?? html.match(/release-year-badge[^>]*>(\d{4})</)?.[1];
  const d = clean(meta(html, "name", "description") ?? meta(html, "property", "og:description"));
  return { title: pageTitle(html), year: y ? Number(y) : null, summary: d ? d.slice(0, 100) : null };
}

const URL_RE = /https?:\/\/[^\s)）」』"]+/g;

/** 概要欄の行から、題名を取りに行くリンク（ai_context.link_patterns に合うもの）を max_links 件まで */
export function pickLinks(lines: string[], cfg: ExtractConfig): string[] {
  const pats = (cfg.ai_context?.link_patterns ?? []).map((p) => new RegExp(p));
  const urls = lines.flatMap((l) => l.match(URL_RE) ?? []);
  return [...new Set(urls.filter((u) => pats.some((p) => p.test(u))))].slice(0, cfg.ai_context?.max_links ?? 3);
}

/**
 * 公開の枠の YouTube のコメント（上位）。DB には持たない（YouTube のデータを溜めない）。
 * API キーが無い・メン限・コメントを閉じている・クォータが尽きたときは空
 */
export async function videoComments(ctx: Ctx, cfg: ExtractConfig, videoId: string): Promise<string[]> {
  const n = cfg.ai_context?.comments ?? 0;
  if (!ctx.yt || n <= 0) return [];
  const chars = cfg.ai_context?.comment_chars ?? 200;
  try {
    const list = await ctx.yt.commentThreads(videoId, n);
    return (list ?? []).map((t) => t.replace(/\s+/g, " ").trim()).filter((t) => t).map((t) => (t.length > chars ? `${t.slice(0, chars)}…` : t));
  } catch (e) {
    log.warn(`コメントを取れなかった ${videoId}: ${String(e).slice(0, 120)}`);
    return [];
  }
}

/** リンク先の題名・公開年・あらすじ（題名が取れなければ title が null）。照会結果は resolve_cache（link_page、30日）に持つ */
export async function linkTitles(ctx: Ctx, cfg: ExtractConfig, urls: string[]): Promise<Map<string, LinkPage>> {
  const cache = new ResolveCache(ctx.db, 30);
  const generic = (cfg.ai_context?.generic_titles ?? []).map((p) => new RegExp(p));
  const none: LinkPage = { title: null, year: null, summary: null };
  const out = new Map<string, LinkPage>();
  for (const u of new Set(urls)) {
    const c = cache.get<LinkPage>("link_page", u);
    if (c) {
      out.set(u, c);
      continue;
    }
    let page = none;
    let keep = true;
    try {
      const res = await ctx.http.get(u, { headers: { "accept-language": "ja-JP,ja;q=0.9" } });
      page = pageInfo(res.body);
      if (page.title && generic.some((g) => g.test(page.title!))) page = none;
    } catch (e) {
      // 取れなければ「取れなかった」と見せる（判定役は開けない）。一時的なエラー（5xx・通信）は覚えずに次の回で取り直す
      keep = e instanceof HttpError && e.status < 500;
    }
    if (keep) cache.set("link_page", u, page);
    out.set(u, page);
  }
  return out;
}

/** 概要欄の YouTube のリンク。watch?v=…&list=… は動画と再生リストの両方を持つ */
export interface YouTubeRef {
  url: string;
  video: string | null;
  playlist: string | null;
}

/** YouTube の動画（watch?v=・youtu.be/・live/・shorts/）か再生リスト（playlist?list=）のリンクなら ID を返す。チャンネル・メンバーシップ（join）のリンクは null */
export function parseYouTube(url: string): YouTubeRef | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^(www|m|music)\./, "");
  // 末尾に続いた文字（「】」など）は落とす。動画の ID は11文字
  const id = (s: string | null | undefined) => s?.match(/^[\w-]+/)?.[0] ?? null;
  const vid = (s: string | null | undefined) => (id(s)?.length === 11 ? id(s) : null);
  const playlist = id(u.searchParams.get("list"));
  let video: string | null = null;
  if (host === "youtu.be") video = vid(u.pathname.slice(1));
  else if (host === "youtube.com") {
    const m = u.pathname.match(/^\/(live|shorts|embed)\/(.+)/);
    if (u.pathname === "/watch") video = vid(u.searchParams.get("v"));
    else if (m) video = vid(m[2]);
    else if (u.pathname !== "/playlist") return null;
  } else return null;
  return video || playlist ? { url, video, playlist } : null;
}

/** 概要欄の行の YouTube のリンク（出てくる順。同じ動画・同じ再生リストは1つ） */
export function youtubeRefs(lines: string[]): YouTubeRef[] {
  const seen = new Set<string>();
  const out: YouTubeRef[] = [];
  for (const u of lines.flatMap((l) => l.match(URL_RE) ?? [])) {
    const r = parseYouTube(u);
    if (!r) continue;
    const k = r.video ? `v:${r.video}` : `p:${r.playlist}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

/** リンク先の動画・再生リストの題名・チャンネル・公開日（日本時間。再生リストは作った日） */
export interface YouTubeInfo {
  title: string;
  channelId: string;
  channel: string;
  date: string;
}

/** videos.list・playlists.list の結果。返ってこなかったもの（消えた・非公開）は null */
export interface YouTubeInfoMap {
  videos: Map<string, YouTubeInfo | null>;
  playlists: Map<string, YouTubeInfo | null>;
}

/**
 * リンク先の動画・再生リストを videos.list・playlists.list で引く（50件ずつ1ユニット）。DB には持たない（YouTube のデータを溜めない）。
 * API キーが無い・クォータが尽きた・呼び出しに失敗したときは null（YouTube のリンクは見せない）
 */
export async function youtubeInfo(ctx: Ctx, refs: YouTubeRef[]): Promise<YouTubeInfoMap | null> {
  if (!ctx.yt) return null;
  const vids = [...new Set(refs.flatMap((r) => (r.video ? [r.video] : [])))];
  const lists = [...new Set(refs.flatMap((r) => (r.playlist ? [r.playlist] : [])))];
  const out: YouTubeInfoMap = { videos: new Map(), playlists: new Map() };
  const info = (s: { title: string; channelId: string; channelTitle?: string; publishedAt: string } | undefined): YouTubeInfo | null =>
    s ? { title: s.title, channelId: s.channelId, channel: s.channelTitle ?? "", date: JST(s.publishedAt) } : null;
  try {
    for (const c of chunk(vids, 50)) {
      const got = new Map((await ctx.yt.videos(c)).map((v) => [v.id, info(v.snippet)]));
      for (const id of c) out.videos.set(id, got.get(id) ?? null);
    }
    for (const c of chunk(lists, 50)) {
      const got = new Map((await ctx.yt.playlists(c)).map((p) => [p.id, info(p.snippet)]));
      for (const id of c) out.playlists.set(id, got.get(id) ?? null);
    }
  } catch (e) {
    log.warn(`YouTube のリンク先を取れなかった: ${String(e).slice(0, 120)}`);
    return null;
  }
  return out;
}

/** 判定役に見せる YouTube のリンク先。null は取れなかった（消えたか非公開）。self は配信者自身のチャンネル */
export interface YouTubeShown {
  title: string;
  channel: string;
  date: string;
  self?: boolean;
}

export interface YouTubeLink {
  url: string;
  video?: YouTubeShown | null;
  playlist?: YouTubeShown | null;
}

/**
 * この枠に見せる YouTube のリンク（2026-10-18 決定）。概要欄に出てくる順に ai_context.youtube_links 件まで。
 *   - 配信者自身のチャンネルの動画・再生リストは、題名が同時視聴の語（detect.yaml の題名の語）に当たるときだけ（自分の MV・歌ってみた・宣伝を除く。
 *     「同時視聴(映画コマンドー)」の再生リストや、枠になっていない前回の回は見せる）
 *   - ほかの配信者（名簿にいる VTuber）・公式チャンネルのものは見せる
 *   - 消えた・非公開の動画は持ち主が分からないので見せる（「取れなかった」）。watch?v=…&list=… の再生リストは、取れたときだけ添える
 */
export function youtubeLinks(refs: YouTubeRef[], info: YouTubeInfoMap, channelId: string, cfg: ExtractConfig, detectCfg: DetectConfig): YouTubeLink[] {
  const n = cfg.ai_context?.youtube_links ?? 3;
  const allowed = (x: YouTubeInfo | null | undefined) => !x || x.channelId !== channelId || detect({ title: x.title, description: null }, detectCfg).hit;
  const shown = (x: YouTubeInfo): YouTubeShown => ({ title: x.title, channel: x.channel, date: x.date, ...(x.channelId === channelId ? { self: true } : {}) });
  const out: YouTubeLink[] = [];
  for (const r of refs) {
    if (out.length >= n) break;
    const v = r.video ? info.videos.get(r.video) : undefined;
    const p = r.playlist ? info.playlists.get(r.playlist) : undefined;
    if (r.video) {
      if (!allowed(v)) continue;
      out.push({ url: r.url, video: v ? shown(v) : null, ...(p && allowed(p) ? { playlist: shown(p) } : {}) });
    } else {
      if (!allowed(p)) continue;
      out.push({ url: r.url, playlist: p ? shown(p) : null });
    }
  }
  return out;
}
