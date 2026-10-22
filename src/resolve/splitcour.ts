import type { Ctx } from "../lib/context.ts";
import type { DB } from "../lib/db.ts";
import { tx } from "../lib/db.ts";
import { log } from "../lib/log.ts";
import { nowIso } from "../lib/time.ts";
import type { ExtractConfig } from "./config.ts";
import { ResolveCache } from "./cache.ts";
import { AnnictClient, type AnnictEpisode } from "./sources/annict.ts";
import { mergeWorks, upsertWork } from "./store.ts";
import { parseKanjiNumber } from "./kanji.ts";
import type { WorkCandidate } from "./types.ts";

// 分割クールを1作品にまとめる（2026-10-21 ユーザー決定）。
// Annict は1つの放送を前半と後半の作品に分ける（Fate/Zero 1stシーズン・2ndシーズン、水星の魔女 Season1・Season2）。
// 作品ページが前半と後半に分かれると、通しで観た配信者が2つのページに割れるので、後半の作品を前半の作品の行にまとめる。
// 本当の2期（ゴールデンカムイ 第2期・フリーレン 第2期）は分けたまま。見分け方は config/extract.yaml の split_cour:
//   B の最初の話の番号が A の最後の話の番号の次・放送の間が max_gap_seasons 期以内・B の作品名が「A の作品名＋後半の表記」
// 名寄せ（resolve）と AI の判定（ai:apply）は今までどおり前半・後半の作品に付け、最後にここでまとめる（Wikidata のアニメのまとめ（link.ts）の次）。
// まとめた先は前半（シリーズで最初）の作品の行で、Annict の ID・公開キー（annict-1855）はそのまま。話は Annict の通し番号なので、後半の話も同じ作品の話になる。
// どの作品をまとめたかは split_cours に持つ（公開キーの転送に使う。後半の作品のキー annict-1856 から前半のページへ 301）

export type SplitCourConfig = NonNullable<ExtractConfig["split_cour"]>;

const SEASON_INDEX: Record<string, number> = { winter: 0, spring: 1, summer: 2, autumn: 3 };

/** 放送期（2011-autumn）を通しの番号にする。年だけ・無しは null */
export function seasonIndex(s: string | null): number | null {
  const m = s?.match(/^(\d{4})-(winter|spring|summer|autumn)$/);
  return m ? Number(m[1]) * 4 + SEASON_INDEX[m[2]!]! : null;
}

/**
 * 話の番号。表記（第十四話・#13・MISSION:13）から読み、読めなければ number。どちらも無ければ null。
 * 表記を先に見るのは、number が表記と食い違う作品があるため（シンデレラガールズ 2nd SEASON の「第26話」は number が 0。Fate/Zero は number が空）
 */
export function episodeNumber(e: AnnictEpisode): number | null {
  const m = e.numberText?.match(/[0-9]+|[〇零一壱二弐三参四肆五伍六陸七漆八捌九玖十拾百]+/);
  const n = m ? parseKanjiNumber(m[0]) : null;
  if (n !== null) return n;
  return e.number !== null && Number.isFinite(e.number) ? e.number : null;
}

function range(eps: AnnictEpisode[] | undefined): { first: number; last: number; count: number } | null {
  const ns = (eps ?? []).map(episodeNumber).filter((n): n is number => n !== null);
  return ns.length ? { first: Math.min(...ns), last: Math.max(...ns), count: new Set(ns).size } : null;
}

export function normTitle(s: string, cfg: SplitCourConfig): string {
  return s.normalize("NFKC").toLowerCase().replace(new RegExp(`[${cfg.strip_chars}]`, "g"), "");
}

/** B の作品名が「A の作品名＋後半の表記」か */
export function isLaterTitle(a: string, b: string, cfg: SplitCourConfig): boolean {
  let base = normTitle(a, cfg);
  for (const re of cfg.first_markers) base = base.replace(new RegExp(re), "");
  const nb = normTitle(b, cfg);
  if (!base || !nb.startsWith(base)) return false;
  const rest = nb.slice(base.length);
  return cfg.later_markers.some((re) => new RegExp(re).test(rest));
}

/** まとめた作品の名前（前半の作品名から前半の表記を外す） */
export function mergedTitle(head: string, cfg: SplitCourConfig): string {
  return head.replace(new RegExp(cfg.title_strip, "i"), "") || head;
}

/**
 * 作品名と放送期だけで見る候補の組（話の番号はあとで見る）。同じシリーズのテレビ作品から、B ごとに当てはまる A が1つだけのとき。
 * A の作品名に後半の表記を付けた作品が2つ以上あれば（スポンジ・ボブ(シーズン1) に (シーズン2)〜(シーズン6)）、シーズンを重ねる番組なのでまとめない
 */
export function titlePairs(series: WorkCandidate[], cfg: SplitCourConfig): [WorkCandidate, WorkCandidate][] {
  const tv = series.filter((w) => w.media === "tv" && w.annictId !== null && seasonIndex(w.seasonName) !== null);
  const out: [WorkCandidate, WorkCandidate][] = [];
  for (const b of tv) {
    const as = tv.filter((a) => {
      if (a.annictId === b.annictId) return false;
      const gap = seasonIndex(b.seasonName)! - seasonIndex(a.seasonName)!;
      return gap > 0 && gap <= cfg.max_gap_seasons && isLaterTitle(a.title, b.title, cfg);
    });
    if (as.length !== 1) continue;
    const a = as[0]!;
    if (tv.filter((c) => c.annictId !== a.annictId && isLaterTitle(a.title, c.title, cfg)).length > 1) continue;
    out.push([a, b]);
  }
  return out;
}

/** 話の番号が続いているか（B の最初の話が A の最後の話の次） */
export function continues(a: AnnictEpisode[] | undefined, b: AnnictEpisode[] | undefined): boolean {
  const ra = range(a), rb = range(b);
  return !!ra && !!rb && rb.first === ra.last + 1;
}

/** 後半の作品 → まとめ先（いちばん前の作品）。Re:ゼロ 2nd season 第2部 → 2nd season のように続けてまとまるものはたどる */
export function heads(pairs: [number, number][]): Map<number, number> {
  const prev = new Map(pairs.map(([a, b]) => [b, a]));
  const out = new Map<number, number>();
  for (const b of prev.keys()) {
    let h = prev.get(b)!;
    const seen = new Set([b]);
    while (prev.has(h) && !seen.has(h)) { seen.add(h); h = prev.get(h)!; }
    out.set(b, h);
  }
  return out;
}

/** まとめた作品の Annict の ID（まとめ先 → まとめた後半の作品）。公開キーの転送に使う */
export function splitMembers(db: DB): Map<number, number[]> {
  const out = new Map<number, number[]>();
  for (const r of db.prepare("SELECT annict_id, head_annict_id FROM split_cours").all() as { annict_id: number; head_annict_id: number }[]) {
    out.set(r.head_annict_id, [...(out.get(r.head_annict_id) ?? []), r.annict_id]);
  }
  return out;
}

export async function mergeSplitCours(ctx: Ctx, cfg: ExtractConfig): Promise<{ pairs: number; merged: number; created: number }> {
  const out = { pairs: 0, merged: 0, created: 0 };
  const sc = cfg.split_cour;
  const token = process.env.ANNICT_TOKEN;
  if (!sc || !token) return out;
  const db = ctx.db;
  const cache = new ResolveCache(db, 30);
  const annict = new AnnictClient(ctx.http, cache, token, cfg.annict);

  const rows = db.prepare("SELECT id, annict_id, series_id FROM works WHERE annict_id IS NOT NULL AND media = 'tv'").all() as { id: number; annict_id: number; series_id: string | null }[];
  // まとめ済みの作品（split_cours のまとめ先）も見る（後半の枠が無くなっても、まとめ先の名前と話数を付け直すため）
  const series = await annict.seriesWorks(rows.map((r) => r.annict_id));
  const cands = new Map<number, WorkCandidate>();
  const tp = new Map<string, [WorkCandidate, WorkCandidate]>();
  for (const ws of series.values()) {
    for (const w of ws) if (w.annictId !== null) cands.set(w.annictId, w);
    for (const p of titlePairs(ws, sc)) tp.set(`${p[0].annictId}-${p[1].annictId}`, p);
  }
  const eps = await annict.episodes([...tp.values()].flatMap(([a, b]) => [a.annictId!, b.annictId!]));
  const pairs = [...tp.values()].filter(([a, b]) => continues(eps.get(a.annictId!), eps.get(b.annictId!))).map(([a, b]) => [a.annictId!, b.annictId!] as [number, number]);
  const head = heads(pairs);
  out.pairs = head.size;

  tx(db, () => {
    const now = nowIso();
    db.prepare("DELETE FROM split_cours").run();
    const ins = db.prepare("INSERT INTO split_cours (annict_id, head_annict_id, checked_at) VALUES (?, ?, ?)");
    for (const [b, h] of head) ins.run(b, h, now);

    for (const r of rows) {
      const h = head.get(r.annict_id);
      if (h === undefined) continue;
      let target = db.prepare("SELECT id FROM works WHERE annict_id = ?").get(h) as { id: number } | undefined;
      if (!target) {
        const c = cands.get(h);
        if (!c) continue;
        target = { id: upsertWork(db, { ...c, seriesId: c.seriesId ?? r.series_id }) };
        out.created++;
      }
      mergeWorks(db, target.id, r.id);
      out.merged++;
    }
    // まとめ先の作品名（前半の表記を外す）と話数（まとめた作品の話の数）
    const members = new Map<number, number[]>();
    for (const [b, h] of head) members.set(h, [...(members.get(h) ?? []), b]);
    for (const [h, bs] of members) {
      const c = cands.get(h);
      if (!c) continue;
      const nums = new Set([h, ...bs].flatMap((id) => (eps.get(id) ?? []).map(episodeNumber).filter((n): n is number => n !== null)));
      db.prepare("UPDATE works SET title = ?, episodes_count = ?, updated_at = ? WHERE annict_id = ?")
        .run(mergedTitle(c.title, sc), nums.size || c.episodesCount, now, h);
    }
  });
  log.info(`分割クール ${out.pairs} 作品: 前の作品にまとめた ${out.merged}（まとめ先を新しく作った ${out.created}）`);
  return out;
}
