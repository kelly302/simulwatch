import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Ctx } from "../lib/context.ts";
import { activeEventSql, farFutureCutoff } from "../lib/events.ts";
import { DATA_DIR } from "../lib/paths.ts";
import type { ExtractConfig } from "../resolve/config.ts";
import { matchKey, looseKey } from "../resolve/normalize.ts";
import { workMedia } from "../resolve/match.ts";
import { ResolveCache } from "../resolve/cache.ts";
import { AnnictClient } from "../resolve/sources/annict.ts";
import type { EntityInfo } from "../resolve/sources/wikipedia.ts";
import type { Media, WorkCandidate } from "../resolve/types.ts";

// 同定の検証用の抽出（ローカルの CLI）。
// 母集団・抽出・表示項目・判定基準を確認表の先頭に書き、結果と手順が必ず一緒に残るようにする。

/** 検証で並べる作品（付いた作品とシリーズのほかの作品） */
export interface SeriesWork {
  key: string;
  title: string;
  media: Media | null;
  seasonName: string | null;
  releaseYear: number | null;
  episodesCount: number | null;
}

/** シードから決まる並び順（sha256(seed:id) の昇順）。同じシードなら誰が流しても同じ抽出になる */
export function sampleOrder(seed: string, ids: string[]): string[] {
  const h = (id: string) => createHash("sha256").update(`${seed}:${id}`).digest("hex");
  return ids.map((id) => [h(id), id] as const).sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([, id]) => id);
}

/** 照合キーが前方一致する別作品か（「葬送のフリーレン」と「葬送のフリーレン 第2期」） */
export function isPrefixRelated(a: string, b: string): boolean {
  if (a === b || a.length < 2 || b.length < 2) return false;
  return a.startsWith(b) || b.startsWith(a);
}

const TV_LIKE = new Set<Media | null>(["tv", "web", "ova"]);

/** シリーズにテレビ・Web・OVA の作品が2つ以上ある（複数の期がある） */
export function hasMultipleSeasons(self: SeriesWork, siblings: SeriesWork[]): boolean {
  return [self, ...siblings].filter((w) => TV_LIKE.has(w.media)).length >= 2;
}

const PROCEDURE = (p: { seed: string; n: number; population: number; works: number; dbState: string }) => `# 期の取り違えの検証（抽出と確認表）

## 手順

**母集団**（${p.population} 枠、作品 ${p.works} 件）

- 同定済みで一覧に出る枠（アーカイブ消失・判定ルールで除外・30日以上先の予定枠を除く）。
- そのうち、付いた作品のどれかが「複数期のシリーズ」に属する枠。
  「複数期のシリーズ」は、付いた作品とそのシリーズのほかの作品のうち、テレビ・Web・OVA の作品が2つ以上あるもの。
- シリーズのほかの作品の決め方:
  - Annict の作品: Annict のシリーズ（Work.seriesList）の全作品を Annict API で取る。
    加えて、照会キャッシュに出てきた Annict の作品のうち、照合キーが前方一致するもの（「葬送のフリーレン」と「葬送のフリーレン 第2期」）。
  - AniList の作品: 照会キャッシュに出てきた Annict・AniList の作品のうち、照合キーが前方一致するもの。
  - Wikidata の作品: 照会キャッシュに出てきた Wikidata の作品のうち、照合キーが前方一致するもの。
    P179（シリーズ）だけのつながり（仮面ライダーシリーズ・MCU など）は入れない。各作品が別の番組・別の映画で、期ではないため。

**抽出**

- 枠単位。sha256(シード + ":" + video_id) の昇順で先頭 ${p.n} 件。シード「${p.seed}」。
  同じシードで流し直せば同じ枠が出る（DB の状態が同じなら）。
- DB の状態: ${p.dbState}

**枠ごとに並べる項目**

1. 枠: video_id・配信日時（日本時間）・配信者・タイトル全文（切り詰めない）
2. 概要欄のうち、期・話数・続編を示す語を含む行（最大5行。ローカルの確認用で、公開しない）
3. 同定: 区間・同定の方法・付いた作品（種別・放送期・放送年・話数）・紐付いた話
4. シリーズのほかの作品（種別・放送期・話数。放送順）
5. 同じ配信者の関連する枠（タイトルに同じ区間を含むか、同じ作品が付いた枠。日付順で前後5件ずつ）

**判定の基準**（抽出の前に決めたもの）

- 誤同定: 次のどれかに当たる
  - a. タイトル・概要欄の期・部・続編・劇場版・総集編の表記が、付いた作品と食い違う
  - b. 話数が付いた作品の話数を超える。または同じ配信者の前後の枠の流れ（通し番号・話数・期の表記）から、別の期を観ていると読める
  - c. 付いた作品の放送開始より前の枠
  - d. 期ではなく、別のシリーズ・別作品に付いている（期以外の誤同定も記録する）
- 判断がつかない: 食い違う根拠はないが、付いた作品を指す根拠もない
  （シリーズ名だけで、期の表記・話数・前後の枠のどれからも、付いた作品か別の期かを決められない）
- 正しい: 付いた作品を指す根拠があり（期の表記が一致する、話数や前後の枠の流れが付いた作品の範囲に収まる）、食い違う根拠がない
- 表に無い外部の知識（放送日など）を使ったときは、判定の理由にそう書く
`;

const DESC_HINT = /(期|シーズン|season|第.{1,3}部|話|ep\.?\s*\d|#\s*\d|最終回|劇場版|総集編|続編|前編|後編|映画)/i;

function jst(t: string | null): string {
  if (!t) return "?";
  return new Date(Date.parse(t) + 9 * 3_600_000).toISOString().slice(0, 16).replace("T", " ");
}

function fmtWork(w: SeriesWork): string {
  const parts = [w.media ?? "種別なし", w.seasonName ?? (w.releaseYear ? String(w.releaseYear) : "放送年なし")];
  if (w.episodesCount) parts.push(`全${w.episodesCount}話`);
  return `${w.title}（${parts.join(", ")}）`;
}

function bySeasonOrder(a: SeriesWork, b: SeriesWork): number {
  return (a.seasonName ?? String(a.releaseYear ?? 9999)).localeCompare(b.seasonName ?? String(b.releaseYear ?? 9999));
}

function fromCandidate(c: WorkCandidate): SeriesWork {
  return { key: c.sourceKey, title: c.title, media: c.media, seasonName: c.seasonName, releaseYear: c.releaseYear, episodesCount: c.episodesCount };
}

interface WorkRow {
  id: number; source: string; annict_id: number | null; anilist_id: number | null; wikidata_id: string | null;
  title: string; media: Media | null; season_name: string | null; release_year: number | null; episodes_count: number | null;
}

/** 期の取り違えの検証用に、複数期のシリーズの枠を抽出して確認表を書き出す */
export async function seasonSample(ctx: Ctx, cfg: ExtractConfig, opts: { n: number; seed: string }): Promise<string> {
  const db = ctx.db;
  const token = process.env.ANNICT_TOKEN;
  if (!token) throw new Error("ANNICT_TOKEN が必要です（Annict のシリーズの全作品を取るため）");
  const annict = new AnnictClient(ctx.http, new ResolveCache(db, 30), token, cfg.annict);
  const mk = (s: string) => matchKey(s, cfg);

  // 照会キャッシュに出てきた候補（前方一致でほかの期を探す母体）
  const animePool = new Map<string, WorkCandidate>();
  for (const r of db.prepare("SELECT response FROM resolve_cache WHERE source = 'annict'").all() as { response: string }[]) {
    for (const c of JSON.parse(r.response) as WorkCandidate[]) animePool.set(c.sourceKey, c);
  }
  const wdPool: SeriesWork[] = [];
  for (const r of db.prepare("SELECT response FROM resolve_cache WHERE source = 'wd_entity'").all() as { response: string }[]) {
    const e = JSON.parse(r.response) as EntityInfo | null;
    if (!e?.qid || !e.labelJa) continue;
    const media = workMedia(e, cfg);
    if (!media) continue;
    wdPool.push({ key: `wikidata:${e.qid}`, title: e.labelJa, media, seasonName: e.year ? String(e.year) : null, releaseYear: e.year, episodesCount: null });
  }
  const animeByKey = [...animePool.values()].map((c) => ({ k: mk(c.title), w: fromCandidate(c) }));
  const wdByKey = wdPool.map((w) => ({ k: mk(w.title), w }));

  const cutoff = farFutureCutoff(ctx.crawlCfg.upcoming.max_days_ahead);
  const works = db.prepare(`SELECT DISTINCT w.* FROM works w JOIN event_works ew ON ew.work_id = w.id
    JOIN watch_events e ON e.id = ew.watch_event_id WHERE ${activeEventSql("e")}`).all(cutoff) as unknown as WorkRow[];
  const series = await annict.seriesWorks(works.filter((w) => w.annict_id).map((w) => w.annict_id!));

  const siblingsOf = new Map<number, SeriesWork[]>();
  const qualifying = new Set<number>();
  for (const w of works) {
    const self: SeriesWork = {
      key: w.annict_id ? `annict:${w.annict_id}` : w.wikidata_id ? `wikidata:${w.wikidata_id}` : `anilist:${w.anilist_id}`,
      title: w.title, media: w.media, seasonName: w.season_name, releaseYear: w.release_year, episodesCount: w.episodes_count,
    };
    const key = mk(w.title);
    const sib = new Map<string, SeriesWork>();
    if (w.annict_id) for (const c of series.get(w.annict_id) ?? []) if (c.annictId !== w.annict_id) sib.set(c.sourceKey, fromCandidate(c));
    const pool = w.source === "wikidata" ? wdByKey : animeByKey;
    for (const p of pool) if (p.w.key !== self.key && isPrefixRelated(key, p.k)) sib.set(p.w.key, p.w);
    const list = [...sib.values()].sort(bySeasonOrder);
    siblingsOf.set(w.id, list);
    if (hasMultipleSeasons(self, list)) qualifying.add(w.id);
  }

  const events = db.prepare(`SELECT DISTINCT e.id, e.video_id FROM watch_events e JOIN event_works ew ON ew.watch_event_id = e.id
    WHERE ${activeEventSql("e")} AND ew.work_id IN (${[...qualifying].join(",") || "NULL"})`).all(cutoff) as { id: number; video_id: string }[];
  const idByVideo = new Map(events.map((e) => [e.video_id, e.id]));
  const picked = sampleOrder(opts.seed, events.map((e) => e.video_id)).slice(0, opts.n);

  const lastRun = db.prepare("SELECT id, finished_at FROM runs WHERE job = 'resolve' AND status IN ('ok','partial') ORDER BY started_at DESC LIMIT 1")
    .get() as { id: string; finished_at: string } | undefined;
  const dbState = lastRun ? `最後の名寄せ ${lastRun.id}（${jst(lastRun.finished_at)} 終了）の結果` : "名寄せの実行記録なし";
  const out: string[] = [PROCEDURE({ seed: opts.seed, n: opts.n, population: events.length, works: qualifying.size, dbState })];
  out.push("## 確認表\n");

  const evStmt = db.prepare(`SELECT e.*, s.name AS streamer FROM watch_events e JOIN streamers s ON s.id = e.streamer_id WHERE e.id = ?`);
  const ewStmt = db.prepare(`SELECT ew.extracted_text, ew.match_method, ew.work_id, w.title, w.media, w.season_name, w.release_year, w.episodes_count,
      GROUP_CONCAT(ep.number_text, ' / ') AS eps
    FROM event_works ew JOIN works w ON w.id = ew.work_id LEFT JOIN episodes ep ON ep.id = ew.episode_id
    WHERE ew.watch_event_id = ? GROUP BY ew.work_id, ew.extracted_text, ew.match_method ORDER BY ew.id`);
  const sameStreamer = db.prepare(`SELECT e.id, e.started_at, e.title_raw,
      (SELECT GROUP_CONCAT(DISTINCT w.title) FROM event_works ew JOIN works w ON w.id = ew.work_id WHERE ew.watch_event_id = e.id) AS works,
      (SELECT u.reason FROM unresolved u WHERE u.watch_event_id = e.id AND u.resolved_at IS NULL) AS reason,
      (SELECT GROUP_CONCAT(ew.work_id) FROM event_works ew WHERE ew.watch_event_id = e.id) AS work_ids
    FROM watch_events e WHERE e.streamer_id = ? AND e.id <> ? AND ${activeEventSql("e")} ORDER BY e.started_at`);

  picked.forEach((vid, i) => {
    const e = evStmt.get(idByVideo.get(vid)!) as Record<string, string | number | null>;
    const ews = ewStmt.all(e.id as number) as Record<string, string | number | null>[];
    out.push(`### ${i + 1}. ${vid}　${jst(e.started_at as string)}　${e.streamer}`);
    out.push(`- タイトル: ${e.title_raw}`);
    out.push(`- URL: https://www.youtube.com/watch?v=${vid}`);
    const desc = String(e.description_raw ?? "").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && DESC_HINT.test(l)).slice(0, 5);
    out.push(`- 概要欄（期・話数の行）: ${desc.length ? "" : "なし"}`);
    for (const l of desc) out.push(`  - ${l.slice(0, 100)}`);
    const texts = new Set<string>();
    const workIds = new Set<number>();
    for (const ew of ews) {
      texts.add(looseKey(String(ew.extracted_text)));
      workIds.add(ew.work_id as number);
      const w: SeriesWork = { key: "", title: String(ew.title), media: ew.media as Media | null, seasonName: ew.season_name as string | null,
        releaseYear: ew.release_year as number | null, episodesCount: ew.episodes_count as number | null };
      out.push(`- 同定: 区間「${ew.extracted_text}」→ **${fmtWork(w)}**［${ew.match_method}］${ew.eps ? ` 話: ${ew.eps}` : ""}`);
      const sibs = siblingsOf.get(ew.work_id as number) ?? [];
      if (qualifying.has(ew.work_id as number)) {
        out.push(`  - シリーズのほかの作品（${sibs.length}件）:`);
        for (const s of sibs.slice(0, 25)) out.push(`    - ${fmtWork(s)}`);
        if (sibs.length > 25) out.push(`    - …ほか ${sibs.length - 25} 件`);
      }
    }
    const rel = (sameStreamer.all(e.streamer_id as number, e.id as number, cutoff) as Record<string, string | null>[]).filter((r) => {
      const t = looseKey(String(r.title_raw));
      return [...texts].some((x) => x.length >= 2 && t.includes(x)) || String(r.work_ids ?? "").split(",").some((id) => workIds.has(Number(id)));
    });
    const at = String(e.started_at);
    const before = rel.filter((r) => String(r.started_at) < at).slice(-5);
    const after = rel.filter((r) => String(r.started_at) >= at).slice(0, 5);
    out.push(`- 同じ配信者の関連する枠（${rel.length}件中、前後5件）: ${rel.length ? "" : "なし"}`);
    for (const r of [...before, { started_at: at, title_raw: "（この枠）", works: null, reason: null }, ...after]) {
      if (rel.length === 0) break;
      out.push(`  - ${jst(r.started_at ?? null)} ${String(r.title_raw).slice(0, 70)}${r.works ? ` → ${r.works}` : r.reason ? ` → (未同定: ${r.reason})` : ""}`);
    }
    out.push("- 判定: ");
    out.push("");
  });

  const dir = join(DATA_DIR, "review");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `season-sample-${opts.seed}.md`);
  writeFileSync(path, out.join("\n"), "utf8");
  return `母集団 ${events.length} 枠（作品 ${qualifying.size} 件）から ${picked.length} 件を抽出 → ${path}`;
}
