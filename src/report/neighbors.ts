import type { Ctx } from "../lib/context.ts";
import type { ExtractConfig } from "../resolve/config.ts";
import { ResolveCache } from "../resolve/cache.ts";
import { extract } from "../resolve/extract.ts";
import { matchKey } from "../resolve/normalize.ts";
import { HttpError } from "../lib/http.ts";

// AI の判定役に見せる手がかり（2026-10-02 決定。ai-run-1 の採点で、保留の6件中5件が決められたはずだった）。
//   - 同じ配信者の同じ作品名の枠（日付順）: シリーズを順に観ているとき、話数の続き・最終話で、どの作品（期・リメイク）か決まる（刃牙（バキ）は第26話（終）で終わる）
//   - 同じ配信者の前後の枠: 観ている作品の傾向（ディズニーのアニメ映画が続く・ジュラシック・パークを順に観ている）
//   - 概要欄のリンク先の題名: 配信サービス・映画情報サイトのページの題名と公開年・あらすじの冒頭（Amazon Prime Video の「ロスト・ワールド／ジュラシック・パーク (吹替版)」。
//     「君に届け」は題名だけではアニメか実写か分からず、公開年（2010）で実写映画と分かる）
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
export function streamerFrames(ctx: Ctx): (streamerId: number) => Frame[] {
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
 * この枠の手がかり。作品名の区間（括弧の中身と括弧の外。照合キー3文字以上）を含むタイトルの枠を「同じ作品名の枠」にする。
 * 配信者の決まり文句（配信者名を含む区間「花畑チャイカと」、10枠以上かつ半分を超える枠に出る区間「王覇山軍」）は使わない
 */
export function frameContext(frames: Frame[], eventId: number, title: string, cfg: ExtractConfig, streamer = ""): FrameContext {
  const ac = cfg.ai_context ?? {};
  const nAround = ac.neighbors ?? 3;
  const nSame = ac.same_name ?? 10;
  const idx = frames.findIndex((f) => f.id === eventId);
  if (idx < 0) return { sameName: [], around: [] };
  const nameKey = streamer ? matchKey(streamer, cfg) : "";
  const titleKeys = frames.map((f) => matchKey(f.title, cfg));
  const boilerplate = (k: string) => {
    if (nameKey && (k.includes(nameKey) || nameKey.includes(k))) return true;
    const n = titleKeys.filter((t) => t.includes(k)).length;
    return n >= 10 && n > frames.length / 2;
  };
  const keys = [...new Set(extract(title, cfg).segments.filter((s) => s.from !== "hashtag" && s.key.length >= 3).map((s) => s.key))].filter((k) => !boilerplate(k));
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

/** 概要欄の行から、題名を取りに行くリンク（ai_context.link_patterns に合うもの）を max_links 件まで */
export function pickLinks(lines: string[], cfg: ExtractConfig): string[] {
  const pats = (cfg.ai_context?.link_patterns ?? []).map((p) => new RegExp(p));
  const urls = lines.flatMap((l) => l.match(/https?:\/\/[^\s)）」』"]+/g) ?? []);
  return [...new Set(urls.filter((u) => pats.some((p) => p.test(u))))].slice(0, cfg.ai_context?.max_links ?? 3);
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
