import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, basename, relative } from "node:path";
import type { Ctx } from "../lib/context.ts";
import { tx } from "../lib/db.ts";
import type { DB } from "../lib/db.ts";
import { DATA_DIR } from "../lib/paths.ts";
import { nowIso, quotaDay } from "../lib/time.ts";
import { activeEventSql, farFutureCutoff } from "../lib/events.ts";
import { normalize, templateLines } from "../detect/detect.ts";
import type { ExtractConfig } from "../resolve/config.ts";
import { ResolveCache } from "../resolve/cache.ts";
import { AnnictClient } from "../resolve/sources/annict.ts";
import { AniListClient } from "../resolve/sources/anilist.ts";
import { WikipediaClient } from "../resolve/sources/wikipedia.ts";
import { labelCandidate, workMedia } from "../resolve/match.ts";
import { applyAiDecisions } from "../resolve/ai.ts";
import { liftLiveSeasons } from "../resolve/lift.ts";
import { enrichWorks } from "../resolve/enrich.ts";
import { linkAnimeIds } from "../resolve/link.ts";
import { mergeSplitCours } from "../resolve/splitcour.ts";
import type { AiStatus, AiConfidence, AiWork } from "../resolve/ai.ts";
import type { WorkCandidate } from "../resolve/types.ts";
import { sampleOrder } from "./sample.ts";
import { CHUNK, descriptionReader, downloadThumb, writeBlindQueue } from "./blind.ts";
import type { QueueRow } from "./blind.ts";
import { candidateQueueRows } from "../candidates/store.ts";
import { frameFromCandidate, revokeCandidateFrames } from "../candidates/frames.ts";
import { collectRoutes } from "../resolve/routing.ts";
import type { RuleAnswer } from "../resolve/routing.ts";
import { needsAi, stratumOf } from "../resolve/route.ts";
import { writeReviewHtml } from "./review.ts";
import { validateAnswer } from "./answer.ts";
import type { AuditAnswer } from "./answer.ts";
import type { ReviewItem } from "./review.ts";

// AI による判定の道具。判定（答えのファイル）は人が起動した Claude Code の回でだけ作る。日次のジョブは答えのファイルを ai:ingest で取り込むだけ
// （ジョブから Claude は呼ばない。D-03・docs/ai-ops.md の 1）。受け箱の出し入れ（ai:ingest・ai:pull・ai:push）は src/report/inbox.ts。
//
//   ai:queue   判定する枠を選び、タイトル・概要欄の行・切り出した区間・サムネイルを data/ai/<batch>/ に書き出す
//   （判定）   Claude Code のセッションで、queue.md とサムネイルを見て、外部作品DBを lookup で確かめ、decisions.json を書く
//   ai:check   答えのファイルの形・finished_at・待ち行列を全部答えたかを確かめる（受け箱に置く前）
//   ai:apply   答えのファイルを DB に入れる（外部DBから作品を引いて確定させる）。古い答えは入れない。同じファイルを何度入れても同じ結果。
//              ジョブの ai:ingest も同じ aiApply を通す（D-09）
//   ai:report  判定の根拠の一覧（人が採点するための表）を書き出す
//   ai:revoke  判定を取り消す（行は残して revoked_at を立てる）。取り消した枠はルールで名寄せし直す
//
// サムネイルは判定のためだけにローカルへ一時的に落とす（サイトには使わない）。判定が済んだら ai:queue --clean で消す

export interface QueueItem {
  video_id: string;
  event_id: number;
  streamer: string;
  started_at: string;
  reason: string;
  title: string;
  segments: string[];
  notes: string[];
  description_lines: string[];
  thumbnail: string | null;
}

export interface DecisionInput {
  video_id: string;
  status: AiStatus;
  works?: { key: string; episodes?: number[] }[];
  confidence: AiConfidence;
  /** 見たもの。looked: title / description / thumbnail / lookup、queries: 照会した語、thumbnail: サムネイルに見えたもの */
  evidence: { looked: string[]; queries?: string[]; thumbnail?: string; notes?: string };
  rationale: string;
  seconds?: number;
}

export interface DecisionFile {
  batch: string;
  model: string;
  started_at?: string;
  finished_at?: string;
  decisions: DecisionInput[];
}

function batchDir(batch: string): string {
  if (!/^[A-Za-z0-9_.-]+$/.test(batch)) throw new Error(`batch の名前は英数字と _ . - だけにしてください: ${batch}`);
  return join(DATA_DIR, "ai", batch);
}

export interface QueueResult {
  text: string;
  batch: string;
  /** 判定する待ち行列のファイル（作業フォルダからの相対パス）。同じシードの2回目は、答えのそろったファイルを除く */
  files: string[];
  /** 上限（--max-files・--n）で切って残った件数（次の回で続ける） */
  remaining: number;
  /** AI の判定の取り分（1日 600）を使い切って、コメント・YouTube のリンク先の取得をやめた */
  quotaStopped: boolean;
  /** この回で使った YouTube のクォータ */
  units: number;
  /** 前の回の batch のフォルダをそのまま使った */
  reused: boolean;
}

/** 1回の上限（docs/ai-ops.md の決定 5。10ファイル＝500件） */
export const MAX_FILES = 10;

/** ローカルの AI の判定の YouTube の消費（太平洋時間の日付ごと）。R2 の DB に戻らないのでファイルで数える（docs/ai-ops.md の 5） */
export const AI_QUOTA_FILE = join(DATA_DIR, "ai", "quota.json");
type AiQuotaLog = { days: Record<string, { units: number; runs: { at: string; batch: string; units: number }[] }> };

export function readAiQuota(path: string = AI_QUOTA_FILE): AiQuotaLog {
  try {
    const j = JSON.parse(readFileSync(path, "utf8")) as AiQuotaLog;
    return j && typeof j.days === "object" && j.days ? j : { days: {} };
  } catch {
    return { days: {} };
  }
}

export function addAiQuota(path: string, day: string, batch: string, units: number, at: string = nowIso()): void {
  const q = readAiQuota(path);
  const d = (q.days[day] ??= { units: 0, runs: [] });
  d.units += units;
  d.runs.push({ at, batch, units });
  // 古い日は消す（14日ぶんを残す）
  for (const k of Object.keys(q.days).sort().slice(0, -14)) delete q.days[k];
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(q, null, 2) + "\n", "utf8");
}

/**
 * 待ち行列のファイルごとの動画。queue/NN.md の見出し（`## 番号. video_id　配信者　日時`）から読む。
 * queue/ が無ければ queue.json の並びを 50件ずつ（writeBlindQueue と同じ切り方）
 */
function queueChunks(dir: string): { nn: string; videoIds: string[] }[] {
  const qdir = join(dir, "queue");
  if (existsSync(qdir)) {
    const mds = readdirSync(qdir).filter((x) => /^\d+\.md$/.test(x)).sort();
    if (mds.length) {
      return mds.map((f) => ({
        nn: f.replace(/\.md$/, ""),
        videoIds: [...readFileSync(join(qdir, f), "utf8").matchAll(/^## \d+\. (\S+)　/gm)].map((m) => m[1]!),
      }));
    }
  }
  const items = (JSON.parse(readFileSync(join(dir, "queue.json"), "utf8")) as { items: { video_id: string }[] }).items;
  const out: { nn: string; videoIds: string[] }[] = [];
  for (let c = 0; c * CHUNK < items.length; c++) out.push({ nn: String(c + 1).padStart(2, "0"), videoIds: items.slice(c * CHUNK, (c + 1) * CHUNK).map((x) => x.video_id) });
  return out;
}

/** 答えのファイルがそろっているか（読めて finished_at があり、待ち行列の枠を全部答えている） */
function answersComplete(path: string, videoIds: string[]): boolean {
  if (!existsSync(path)) return false;
  const r = readAnswerFile(path);
  if (!r.head) return false;
  const got = new Set(r.videoIds);
  return videoIds.every((v) => got.has(v));
}

const rel = (p: string) => relative(process.cwd(), p).replaceAll("\\", "/");

/**
 * 同じシードの2回目（会話をまたいだ再開。docs/ai-ops.md 4-1）: batch のフォルダをそのまま使い、答えのそろったファイルを飛ばす。
 * DB の今の状態では選び直さない（前の回の待ち行列のまま）
 */
function reuseQueue(dir: string, opts: { batch: string; seed: string }): QueueResult {
  const sealed = JSON.parse(readFileSync(join(dir, "sealed", "answers.json"), "utf8")) as { seed?: string; population?: number; answers: unknown[] };
  if (sealed.seed !== undefined && sealed.seed !== opts.seed) throw new Error(`${dir} は別のシード（${sealed.seed}）で作った batch です。別の batch 名にしてください`);
  const chunks = queueChunks(dir);
  const todo = chunks.filter((c) => !answersComplete(join(dir, "answers", `${c.nn}.json`), c.videoIds));
  const remaining = Math.max(0, (sealed.population ?? sealed.answers.length) - sealed.answers.length);
  return {
    text: `前の回の待ち行列を使う（${opts.batch}）: ${chunks.length} ファイルのうち答えのそろった ${chunks.length - todo.length} を飛ばし、${todo.length} ファイル → ${dir}`,
    batch: opts.batch, files: todo.map((c) => rel(join(dir, "queue", `${c.nn}.md`))), remaining, quotaStopped: false, units: 0, reused: true,
  };
}

/**
 * 判定する枠を選んで書き出す。AI の判定がすでにある枠（hold を含む）は選ばない。
 * 本番の待ち行列（2026-10-01）。AI に回す型（config/extract.yaml の ai_routes）の終わった枠のうち、AI の判定がまだ無いもの
 * （includeHold なら保留も）から、sha256(シード:video_id) の昇順で先頭 n 件（--max-files なら 50×N 件）。候補を見せない形で書き出す（src/report/blind.ts）。
 * ルールの答えは sealed/ に残し、採点の表（ai:report）で並べる。
 * 同じ batch の2回目は前の待ち行列を使う（reuseQueue）。YouTube はローカルの AI の判定の取り分（data/ai/quota.json）で止める（docs/ai-ops.md の 5）。
 * 続きの回の候補（D-04。candidates の表の ready、includeHold なら hold も）も同じ待ち行列に混ぜる（docs/ai-ops.md 3-3）。--type（routes）を付けたときは入れない。
 * candidatesOnly なら候補だけ
 */
export async function aiQueueRoutes(
  ctx: Ctx, cfg: ExtractConfig,
  opts: { batch: string; seed: string; n?: number; maxFiles?: number; routes?: string[]; includeHold?: boolean; videos?: string[]; quotaFile?: string; candidatesOnly?: boolean },
): Promise<QueueResult> {
  const dir = batchDir(opts.batch);
  if (existsSync(join(dir, "sealed", "answers.json"))) return reuseQueue(dir, opts);
  if (opts.maxFiles !== undefined && !(Number.isInteger(opts.maxFiles) && opts.maxFiles >= 1 && opts.maxFiles <= MAX_FILES)) {
    throw new Error(`--max-files は 1〜${MAX_FILES}（1回の上限は ${MAX_FILES} ファイル＝${MAX_FILES * CHUNK} 件。docs/ai-ops.md の決定 5）`);
  }
  const n = opts.maxFiles !== undefined ? Math.min(opts.n ?? Infinity, opts.maxFiles * CHUNK) : opts.n ?? 300;
  const routes = opts.routes ?? cfg.ai_routes ?? [];
  if (!routes.length && !opts.candidatesOnly) throw new Error("AI に回す型がありません（config/extract.yaml の ai_routes）");
  const { routed } = opts.candidatesOnly ? { routed: [] } : await collectRoutes(ctx, cfg);
  const decided = new Map((ctx.db.prepare("SELECT watch_event_id, status FROM ai_decisions WHERE revoked_at IS NULL").all() as
    { watch_event_id: number; status: string }[]).map((r) => [r.watch_event_id, r.status]));
  // 終わった枠だけ（2026-10-27 の決定 D-01。予定枠・配信中の枠はサイトに出さず、終わってから判定する。動画を指定しても入れない）
  const ended = new Set((ctx.db.prepare("SELECT id FROM watch_events WHERE status = 'completed'").all() as { id: number }[]).map((r) => r.id));
  // 動画を指定したときは、判定の有無と型に関係なく入れる（判定し直し用。判定済みの枠を入れ直すと、ai:apply で前の判定は取り消しになる）
  const framePool = (opts.videos
    ? routed.filter((r) => opts.videos!.includes(r.ev.video_id))
    : routed.filter((r) => needsAi(r.rule, routes) && (!decided.has(r.ev.id) || (opts.includeHold && decided.get(r.ev.id) === "hold"))))
    .filter((r) => ended.has(r.ev.id));
  // 続きの回の候補（終わった動画で、一覧に出る枠の無いもの）。判定役には候補であることと種の枠を見せ、層は見せない
  const candPool = opts.routes && !opts.candidatesOnly ? [] : candidateQueueRows(ctx.db, { includeHold: !!opts.includeHold, ...(opts.videos ? { videos: opts.videos } : {}) });
  const pool: QueueRow[] = [...framePool, ...candPool];
  const stratum = (r: QueueRow) => (r.rule ? stratumOf(r.rule) : "candidate");
  const byVid = new Map(pool.map((r) => [r.ev.video_id, r]));
  const rows = sampleOrder(opts.seed, [...byVid.keys()]).slice(0, n).map((v) => byVid.get(v)!);
  const perRoute: Record<string, number> = {};
  for (const r of pool) perRoute[stratum(r)] = (perRoute[stratum(r)] ?? 0) + 1;
  const picked: Record<string, number> = {};
  for (const r of rows) picked[stratum(r)] = (picked[stratum(r)] ?? 0) + 1;
  if (!rows.length) {
    return { text: `母集団 ${pool.length} 枠。判定する枠が無い（batch は作らない）`, batch: opts.batch, files: [], remaining: 0, quotaStopped: false, units: 0, reused: false };
  }
  // AI の判定の取り分（config/crawl.yaml の quota.ai_reserve）から、今日（太平洋時間）ローカルで使ったぶんを引いた残りで止める。
  // 止めてもコメント・YouTube のリンク先を取らないだけで、待ち行列は作る（docs/ai-ops.md の 5）
  const quotaFile = opts.quotaFile ?? AI_QUOTA_FILE;
  const day = quotaDay();
  const usedLocal = readAiQuota(quotaFile).days[day]?.units ?? 0;
  const allowance = Math.max(0, (ctx.crawlCfg.quota.ai_reserve ?? 0) - usedLocal);
  ctx.quota.limitRun(allowance);
  const created = nowIso();
  let written: { items: unknown[]; chunks: number };
  try {
    written = await writeBlindQueue(ctx, dir, {
      batch: opts.batch, seed: opts.seed, rows,
      sealed: { created_at: created, routes, population: pool.length, per_route: perRoute }, sealedNote: "ai:report が採点の表に使う",
    });
  } finally {
    addAiQuota(quotaFile, day, opts.batch, ctx.quota.runUsed);
  }
  const { items, chunks } = written;
  const plan = [
    `# AI の判定の待ち行列（${opts.batch}）`, "",
    opts.videos
      ? `- 母集団: 一覧に出る終わった枠のうち、指定した動画（${opts.videos.join("・")}。判定の有無と型に関係なく入れる）。${pool.length} 枠`
      : opts.candidatesOnly ? `- 母集団: 続きの回の候補（candidates の ready${opts.includeHold ? "・hold" : ""}）。${pool.length} 本`
      : `- 母集団: 一覧に出る終わった枠のうち、AI に回す型（${routes.join("・")}）で、AI の判定がまだ無いもの${opts.includeHold ? "（保留の枠を含む）" : ""} ${framePool.length} 枠と、` +
        `続きの回の候補（candidates の ready${opts.includeHold ? "・hold" : ""}。型は candidate）${candPool.length} 本`,
    `- 抽出: sha256(シード + ":" + video_id) の昇順で先頭 ${rows.length} 件。シード「${opts.seed}」。待ち行列の並びは sha256(シード + ":queue:" + video_id) の昇順`,
    "- AI に見せるもの: 配信者・日時・タイトル・概要欄（定型文と URL で始まる行を除き（題名を見せるリンクの行は残す）、その枠を指す行を先に12行まで）・サムネイル・概要欄のリンク先の題名・YouTube のリンク先（題名・チャンネル名・公開日）・公開の枠のコメント欄・" +
      "同じ配信者の同じ作品名の枠と前後の枠・同時視聴枠にならなかった同じ配信者の動画（同じ作品名の動画と、メン限の枠では前後のメン限の動画。タイトルと日付だけ）。型・区間・候補・ルールの答えは見せない（GUIDE.md）。" +
      "続きの回の候補には、候補であること（同時視聴でなければ not_watchalong）と候補にした同時視聴の枠（近い5枠）を足す。候補の理由（層）は見せない（docs/ai-ops.md 3-3）",
    "- 判定のあと: ai:apply data/ai/<batch>/answers で入れ、ai:report <batch> --sample N --seed S で採点の表を作る", "",
    "| 型 | 母集団 | この待ち行列 |", "| --- | ---: | ---: |",
    ...Object.entries(perRoute).sort((a, b) => b[1] - a[1]).map(([k, v]) => `| ${k} | ${v} | ${picked[k] ?? 0} |`), "",
  ];
  writeFileSync(join(dir, "plan.md"), plan.join("\n"), "utf8");
  const quotaStopped = ctx.quota.exhausted;
  return {
    text: `母集団 ${pool.length} 枠から ${items.length} 件（${Object.entries(picked).map(([k, v]) => `${k} ${v}`).join("・")}）・待ち行列 ${chunks} ファイル → ${dir}` +
      `\nYouTube のクォータ ${ctx.quota.runUsed} ユニット（今日のローカルの AI の判定 ${usedLocal + ctx.quota.runUsed} / 取り分 ${ctx.crawlCfg.quota.ai_reserve ?? 0}）` +
      (quotaStopped ? "。取り分を使い切ったので、残りの枠はコメント・YouTube のリンク先を取らなかった" : ""),
    batch: opts.batch,
    files: Array.from({ length: chunks }, (_, c) => rel(join(dir, "queue", `${String(c + 1).padStart(2, "0")}.md`))),
    remaining: pool.length - rows.length, quotaStopped, units: ctx.quota.runUsed, reused: false,
  };
}

/** 判定する枠を未同定の理由で選ぶ（ai-trial-1 の形。区間と注記を見せる） */
export async function aiQueue(ctx: Ctx, cfg: ExtractConfig, opts: { reason: string; n: number; seed: string; batch: string }): Promise<string> {
  const db = ctx.db;
  const cutoff = farFutureCutoff(ctx.crawlCfg.upcoming.max_days_ahead);
  const rows = db.prepare(`SELECT e.id, e.video_id, e.title_raw, e.description_raw, e.thumbnail_url, e.started_at, e.streamer_id, s.name AS streamer,
      u.reason, u.detail
    FROM unresolved u JOIN watch_events e ON e.id = u.watch_event_id JOIN streamers s ON s.id = e.streamer_id
    WHERE u.resolved_at IS NULL AND u.reason = ? AND ${activeEventSql("e")} AND e.status = 'completed'
      AND e.id NOT IN (SELECT watch_event_id FROM ai_decisions WHERE revoked_at IS NULL)`).all(opts.reason, cutoff) as Record<string, string | number | null>[];
  const byVideo = new Map(rows.map((r) => [String(r.video_id), r]));
  const picked = sampleOrder(opts.seed, [...byVideo.keys()]).slice(0, opts.n);
  const dir = batchDir(opts.batch);
  mkdirSync(join(dir, "thumbs"), { recursive: true });

  const desc = descriptionReader(ctx);
  const items: QueueItem[] = [];
  for (const vid of picked) {
    const r = byVideo.get(vid)!;
    const d = r.detail ? (JSON.parse(String(r.detail)) as Record<string, unknown>) : {};
    const lines = desc(Number(r.streamer_id), r.description_raw as string | null);
    const thumb = await downloadThumb(ctx, r.thumbnail_url as string | null, join(dir, "thumbs"), vid);
    const notes = d.notes && typeof d.notes === "object" ? Object.entries(d.notes as Record<string, string>).map(([k, v]) => `${k} → ${v}`) : [];
    items.push({
      video_id: vid, event_id: Number(r.id), streamer: String(r.streamer), started_at: String(r.started_at ?? ""), reason: String(r.reason),
      title: String(r.title_raw), segments: [...((d.segments ?? []) as string[]), ...((d.subs ?? []) as string[]).map((x) => `(小区間) ${x}`)],
      notes, description_lines: lines, thumbnail: thumb,
    });
  }
  writeFileSync(join(dir, "queue.json"), JSON.stringify({ batch: opts.batch, reason: opts.reason, seed: opts.seed, population: rows.length, created_at: nowIso(), items }, null, 2), "utf8");
  const md = [
    `# AI 判定の待ち行列（${opts.batch}）`,
    "",
    `- 母集団: 一覧に出る終わった枠のうち未同定の理由が ${opts.reason} で、AI の判定がまだ無いもの（${rows.length} 枠）`,
    `- 抽出: sha256(シード + ":" + video_id) の昇順で先頭 ${picked.length} 件。シード「${opts.seed}」`,
    `- 概要欄は定型文（同じ配信者の枠に ${ctx.detectCfg.description.template_min_repeats} 本以上出る行）と URL の行を除き、その枠を指す行を先に12行まで。メン限枠の本文を含むのでローカルだけで使う`,
    "",
    ...items.flatMap((x, i) => [
      `## ${i + 1}. ${x.video_id}　${x.streamer}　${x.started_at.slice(0, 10)}`,
      `- タイトル: ${x.title}`,
      `- 区間: ${x.segments.join(" ／ ") || "なし"}`,
      `- 注記: ${x.notes.join(" ／ ") || "なし"}`,
      `- 概要欄: ${x.description_lines.join(" ／ ") || "なし"}`,
      `- サムネイル: ${x.thumbnail ?? "なし"}`,
      "",
    ]),
  ];
  writeFileSync(join(dir, "queue.md"), md.join("\n"), "utf8");
  return `母集団 ${rows.length} 枠から ${items.length} 件（サムネイル ${items.filter((x) => x.thumbnail).length} 件）→ ${join(dir, "queue.md")}`;
}

/** 外部DBのキー（annict:1 / anilist:2 / wikidata:Q3）から作品の情報を引く。Wikidata は作品クラスの項目だけ */
export async function fetchWorks(ctx: Ctx, cfg: ExtractConfig, keys: string[]): Promise<Map<string, WorkCandidate>> {
  const cache = new ResolveCache(ctx.db, 30);
  const token = process.env.ANNICT_TOKEN;
  const annict = token ? new AnnictClient(ctx.http, cache, token, cfg.annict) : null;
  const anilist = new AniListClient(ctx.http, cache, cfg.anilist);
  const wp = new WikipediaClient(ctx.http, cache);
  const ids = (p: string) => keys.filter((k) => k.startsWith(p)).map((k) => k.slice(p.length));
  const got = new Map<string, WorkCandidate>();
  if (ids("annict:").length) {
    if (!annict) throw new Error("annict の作品を引くには ANNICT_TOKEN が必要です");
    for (const [id, w] of await annict.byIds(ids("annict:").map(Number))) got.set(`annict:${id}`, w);
  }
  if (ids("anilist:").length) for (const [id, w] of await anilist.byIds(ids("anilist:").map(Number))) got.set(`anilist:${id}`, w);
  // AI が選んだ項目は、ルールの作品クラスに加えて ai_extra_work_classes も受け付ける（仮面ライダーの「テレビ番組」など）
  const extra = cfg.wikipedia.ai_extra_work_classes ?? {};
  if (ids("wikidata:").length) {
    for (const [q, e] of await wp.entities(ids("wikidata:"))) {
      const media = workMedia(e, cfg) ?? e.p31.map((x) => extra[x]).find((m) => !!m) ?? null;
      if (media) got.set(`wikidata:${q}`, { ...labelCandidate(e, cfg), media });
    }
  }
  // 実写のシーズンの項目はシリーズの項目に付け替える（src/resolve/lift.ts。話数は ai:apply が外す）
  const lifted = await liftLiveSeasons([...got.values()], wp, cfg, extra);
  for (const [k, c] of got) { const l = lifted.get(c.sourceKey); if (l) got.set(k, l); }
  return got;
}

/**
 * 答えの時刻（ISO 8601 の文字列）を瞬間（ミリ秒）にする。読めなければ null。
 * ai_decisions.decided_at には `Z` と `+09:00` が混ざっている（2026-10 の答えのファイルの finished_at をそのまま入れていた）ので、
 * 文字列のまま比べない（D-03・docs/workflows.md 6-2）
 */
export function answerInstant(s: string | null | undefined): number | null {
  if (typeof s !== "string" || !s.trim()) return null;
  // 日付だけ・時差の無い時刻は、どの瞬間か決まらない（Date.parse は地方時として読む）ので受け付けない
  if (!/T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i.test(s.trim())) return null;
  const t = Date.parse(s.trim());
  return Number.isNaN(t) ? null : t;
}

/**
 * 古い答えの決まり（D-03・D-09。docs/workflows.md 6-2）。その枠のすでにある判定の時刻（existing。aiApply は取り消した行も含めた decided_at の最大を渡す）と、入れる答えの時刻（answer。ファイルの finished_at）を瞬間で比べる。
 *   apply    入れる（前の判定は取り消す。行は残る）。すでにある判定が無い・読めない・答えより古いとき
 *   already  入れ済み（同じ時刻。何度入れても同じ）
 *   stale    古い答え（すでにある判定のほうが新しい）。飛ばす
 * 同じ aiApply の呼び出しの中で先に入れた答えとの比べは aiApply がする（同じ時刻ならあと＝名前の順で後ろのファイル（fix-*.json）を入れる）。
 * 候補（続きの回）の答えの not_watchalong も、candidates の表に持つ答えの時刻とこれで比べる（塊 D3a）
 */
export function answerFreshness(existing: string | number | null | undefined, answer: number): "apply" | "already" | "stale" {
  const e = typeof existing === "number" ? existing : answerInstant(existing);
  if (e === null) return "apply";
  return e > answer ? "stale" : e === answer ? "already" : "apply";
}

/** 答えの時刻の未来の許し（PC の時計のずれ）。これより先の finished_at は、以後の直しを全部「古い答え」にしてしまうので受け付けない */
const FUTURE_SLACK_MS = 3_600_000;

/**
 * 取り込みの問題の種類（docs/workflows.md 6-3）。ai:ingest が batch の結果（入れた・やり直し・failed）をこれで決める
 *   file      ファイル単位（読めない・batch・model・finished_at が無いか読めない・答えの配列が無い）→ failed
 *   no_event  枠が無い（判定から外れた・アーカイブが消えた枠。候補の表に無い動画。候補の詳細が無く枠を作れない）→ 入れた
 *   invalid   答えの形が不正 → 入れた（結果に書いて人が直す）
 *   lookup    外部DBで引けない（照会のエラー・作品クラスでない項目）→ やり直し
 *   enrich    作品の属性を埋められなかった → 入れた（次の resolve で埋める）
 */
export type ApplyProblemKind = "file" | "no_event" | "invalid" | "lookup" | "enrich";
export interface ApplyProblem { kind: ApplyProblemKind; file?: string; video_id?: string; message: string }

export interface ApplyResult {
  text: string;
  /** 確定した判定を保留に置き換えた枠（呼び出し側でルールの名寄せをし直す） */
  reresolve: string[];
  /** 読んだファイル（名前の順） */
  files: string[];
  /** 入れた答えの動画 */
  applied: string[];
  /** 古い答え（すでにある判定のほうが新しい）で飛ばした動画 */
  stale: string[];
  /** 入れ済み（同じ時刻の判定がもうある）で飛ばした動画 */
  already: string[];
  problems: ApplyProblem[];
  /** 結果を変えない知らせ（not_in_db に kind・movie が無いなど） */
  notices: string[];
  /** 続きの回の候補の答え（D-04）: 枠を作った（作った・戻した）・同時視聴ではない（候補の表に持つ）・保留（候補のまま） */
  candidates: { framed: string[]; notWatchalong: string[]; hold: string[] };
}

type AnswerItem = Omit<DecisionInput, "status"> & { status: AiStatus | "not_watchalong"; title?: string; missing?: string[]; kind?: string; movie?: boolean; model: string; batch: string; at: number; file: string };

/**
 * 答えのファイル1つを読んで検査する（aiApply と ai:check が同じものを使う）。
 * noEvent を渡すと、枠が無い答え（noEvent が理由を返す）を no_event にする（渡さなければ見ない。ai:check）
 */
export function readAnswerFile(f: string, opts: { noEvent?: (videoId: string) => string | null; now?: number } = {}): {
  head: { batch: string; model: string; finished_at: string; at: number } | null; items: AnswerItem[]; problems: ApplyProblem[]; notices: string[]; videoIds: string[];
} {
  const problems: ApplyProblem[] = [];
  const notices: string[] = [];
  const items: AnswerItem[] = [];
  const fail = (message: string) => ({ head: null, items, problems: [{ kind: "file" as const, file: f, message }], notices, videoIds: [] });
  let j: Partial<DecisionFile> & { answers?: AuditAnswer[] };
  try {
    j = JSON.parse(readFileSync(f, "utf8").replace(/^﻿/, ""));
  } catch (e) {
    return fail(`読めない（${(e as Error).message.slice(0, 120)}）`);
  }
  if (!j || typeof j !== "object" || Array.isArray(j)) return fail("JSON のオブジェクトでない");
  const missing = (["batch", "model", "finished_at"] as const).filter((k) => typeof j[k] !== "string" || !j[k]!.trim());
  if (missing.length) return fail(`${missing.join("・")} が無い`);
  const at = answerInstant(j.finished_at);
  if (at === null) return fail(`finished_at を時刻として読めない（${j.finished_at}。時差（Z か +09:00）付きの ISO 8601 で書く）`);
  if (at > (opts.now ?? Date.now()) + FUTURE_SLACK_MS) return fail(`finished_at が未来（${j.finished_at}）`);
  if (!Array.isArray(j.decisions) && !Array.isArray(j.answers)) return fail("answers（または decisions）の配列が無い");
  const head = { batch: j.batch!, model: j.model!, finished_at: j.finished_at!, at };
  const base = { model: head.model, batch: head.batch, at, file: f };
  const videoIds: string[] = [];
  const CONF = new Set(["high", "medium", "low"]);
  const noEvent = (vid: string) => opts.noEvent?.(vid) ?? null;
  if (j.answers) {
    for (const a of j.answers) {
      if (!a || typeof a.video_id !== "string") { problems.push({ kind: "invalid", file: f, message: "video_id が無い答え" }); continue; }
      videoIds.push(a.video_id);
      // 続きの回の候補（候補の表にある動画）は、枠が無くても noEvent が通す（aiApply が枠を作ってから入れる。D-04）
      const gone = noEvent(a.video_id);
      if (gone) { problems.push({ kind: "no_event", file: f, video_id: a.video_id, message: gone }); continue; }
      const why = validateAnswer(a);
      if (why) { problems.push({ kind: "invalid", file: f, video_id: a.video_id, message: why }); continue; }
      // 2026-10-02 より前の答えには無い（受け付けて、UI の絞り込みから漏れることだけ知らせる）
      if (a.status === "not_in_db" && (!a.kind || a.movie === undefined)) notices.push(`${a.video_id}: not_in_db に kind・movie が無い（映像の種類・映画での絞り込みに出ない）`);
      items.push({
        video_id: a.video_id, status: a.status, confidence: a.confidence, evidence: a.evidence, rationale: a.rationale, seconds: a.seconds,
        works: (a.works ?? []).map((w) => ({ key: w.key, ...(w.episodes?.length ? { episodes: w.episodes } : {}) })),
        ...(a.title ? { title: a.title } : {}), ...(a.missing?.length ? { missing: a.missing } : {}),
        ...(a.kind ? { kind: a.kind } : {}), ...(a.movie !== undefined ? { movie: a.movie } : {}),
        ...base,
      });
    }
  } else {
    const STATUS = new Set(["identified", "not_a_work", "unidentifiable", "hold"]);
    for (const d of j.decisions!) {
      if (!d || typeof d.video_id !== "string") { problems.push({ kind: "invalid", file: f, message: "video_id が無い答え" }); continue; }
      videoIds.push(d.video_id);
      const gone = noEvent(d.video_id);
      if (gone) { problems.push({ kind: "no_event", file: f, video_id: d.video_id, message: gone }); continue; }
      const why = !STATUS.has(d.status) ? `status が不正: ${d.status}` : !CONF.has(d.confidence) ? `confidence が不正: ${d.confidence}`
        : !d.rationale?.trim() ? "rationale が空" : !Array.isArray(d.evidence?.looked) || d.evidence.looked.length === 0 ? "evidence.looked が空"
          : d.status === "identified" && !(d.works ?? []).length ? "identified なのに works が空"
            : (d.works ?? []).some((w) => !/^(annict:\d+|anilist:\d+|wikidata:Q\d+)$/.test(w.key)) ? "works の key が不正" : null;
      if (why) { problems.push({ kind: "invalid", file: f, video_id: d.video_id, message: why }); continue; }
      items.push({ ...d, ...base });
    }
  }
  return { head, items, problems, notices, videoIds };
}

/** 答えのファイルの並び。フォルダなら中の *.json を名前の順（`01.json`〜 の後ろに `fix-*.json`。docs/workflows.md 6-2） */
export function answerFiles(path: string): string[] {
  return statSync(path).isDirectory()
    ? readdirSync(path).filter((x) => x.endsWith(".json")).sort().map((x) => join(path, x))
    : [path];
}

export interface ApplyDeps {
  /** 外部DBから作品を引く（テストで差し替える） */
  fetchWorks?: typeof fetchWorks;
  /** 入れたあとの作品の後始末（アニメの ID の付け合わせ・分割クール・属性）。テストで差し替える */
  after?: (ctx: Ctx, cfg: ExtractConfig) => Promise<void>;
}

/**
 * 判定のファイルを検査して、作品の情報を外部DBから引いて DB に入れる。ローカルの ai:apply と日次のジョブの ai:ingest がここを通す（D-09。決まりを2つにしない）。
 * file はファイルかフォルダ（中の *.json を名前の順に）。形式は2つ:
 *   decisions（ai-trial-1 の形）と answers（候補を見ない判定の形。src/report/answer.ts。not_in_db・missing・also を持つ）
 *
 * - ファイルには batch・model・finished_at（時差付き）が要る。無いファイルは入れない（problems の file。ai:ingest は failed にする）
 * - 古い答えは入れない（answerFreshness）。時刻はファイルの finished_at で、その枠の判定（取り消した行も含む）の decided_at の最大と瞬間で比べ、decided_at には UTC で入れる。
 *   ai:revoke で取り消したあとも、取り消した答え・それより古い答えは入らない（取り消したあとに作った新しい答えだけが入る）
 * - 同じ呼び出しの中では名前の順に入れ、同じ枠の答えは時刻の新しいほう（同じ時刻ならあとのファイル。`fix-*.json`）が残る
 * - 同じファイルを何度入れても判定の集合は変わらない（2回目は全部「入れ済み」）
 */
export async function aiApply(ctx: Ctx, cfg: ExtractConfig, file: string, deps: ApplyDeps = {}): Promise<ApplyResult> {
  const files = answerFiles(file);
  const db = ctx.db;
  const problems: ApplyProblem[] = [];
  const notices: string[] = [];
  // 枠が無い = 行が無い・判定から外れた（excluded_at）・アーカイブが消えた（archive_gone_at）。docs/workflows.md 6-3。入れ直しても入らない。
  // ただし続きの回の候補（candidates の表にある動画。D-04）は、行が無い・外れた枠でも通し、枠を作る関数（src/candidates/frames.ts）で作るか戻してから入れる
  // （語彙の変更で外れていた行（detect_rule）・取り消しで外した ai_candidate の枠（ai_revoked）も戻す）。アーカイブが消えた枠は候補でも入れない
  const evOf = db.prepare("SELECT id, excluded_at, archive_gone_at, detect_source FROM watch_events WHERE video_id = ?");
  const evRow = (vid: string) => evOf.get(vid) as { id: number; excluded_at: string | null; archive_gone_at: string | null; detect_source: string } | undefined;
  const candOf = db.prepare("SELECT state, answered_at FROM candidates WHERE video_id = ?");
  const candRow = (vid: string) => candOf.get(vid) as { state: string; answered_at: string | null } | undefined;
  const items: AnswerItem[] = [];
  for (const f of files) {
    const r = readAnswerFile(f, {
      noEvent: (v) => {
        const e = evRow(v);
        if (e?.archive_gone_at) return "枠のアーカイブが消えた（archive_gone_at）";
        if ((!e || e.excluded_at) && candRow(v)) return null;
        return !e ? "枠が無い" : e.excluded_at ? "枠が判定から外れている（excluded_at）" : null;
      },
    });
    items.push(...r.items);
    problems.push(...r.problems);
    notices.push(...r.notices);
  }
  // 比べる時刻は、その枠の取り消した行も含めた全部の判定の decided_at の最大（瞬間で比べる）。
  // 取り消されていない判定だけを見ると、ai:revoke のあとに受け箱に残った取り消した答え・それより古い答えがまた入る。
  // revoked_at は使わない（aiApply の置き換えで立つ revoked_at は取り込んだ時刻なので、あとの正しい答えまで古い答えになる）
  const allAt = db.prepare("SELECT decided_at FROM ai_decisions WHERE watch_event_id = ?");
  const dbAt = (ev: number): number | null => {
    let max: number | null = null;
    for (const r of allAt.all(ev) as { decided_at: string }[]) {
      const t = answerInstant(r.decided_at);
      if (t !== null && (max === null || t > max)) max = t;
    }
    return max;
  };

  // 続きの回の候補は、枠（行があれば。外れた行も含む）の判定の時刻と、候補の表の答えの時刻（not_watchalong・hold。取り消した答えも含む）の大きいほう
  const existingAt = (vid: string): number | null => {
    const e = evRow(vid);
    const ts = [e ? dbAt(e.id) : null, answerInstant(candRow(vid)?.answered_at)].filter((t): t is number => t !== null);
    return ts.length ? Math.max(...ts) : null;
  };

  // 作品の情報を外部DBから引く。DB の判定より古い・同じ時刻の答えは入らないので引かない（同じ呼び出しの中の比べは下で）
  const fresh = items.filter((d) => answerFreshness(existingAt(d.video_id), d.at) === "apply");
  const got = await (deps.fetchWorks ?? fetchWorks)(ctx, cfg, [...new Set(fresh.flatMap((d) => (d.works ?? []).map((w) => w.key)))]);

  const applied: number[] = [];
  const appliedVids: string[] = [];
  const stale: string[] = [];
  const already: string[] = [];
  // この呼び出しで入れた答えの時刻（動画ごと）。同じ時刻なら名前の順で後ろのファイルを入れる
  const inCall = new Map<string, number>();
  // 続きの回の候補の答え（D-04）: 枠を作った（作った・戻した）・同時視聴ではない・保留（候補のまま）
  const cand = { framed: [] as string[], notWatchalong: [] as string[], hold: [] as string[] };
  const setAnswer = db.prepare(`UPDATE candidates SET state = ?, state_at = ?, answer_status = ?, answer_batch = ?, answer_detail = ?, answered_at = ?, answer_revoked_at = NULL
    WHERE video_id = ?`);
  const revokeOf = db.prepare("UPDATE ai_decisions SET revoked_at = ? WHERE watch_event_id = ? AND revoked_at IS NULL");
  // 確定した判定（hold 以外）を hold に置き換えた枠。取り消した判定の結果（未同定の理由など）が残るので、ルールで名寄せし直す（ai:revoke と同じ）
  const reresolve = new Set<string>();
  const locked = db.prepare("SELECT 1 FROM ai_decisions WHERE watch_event_id = ? AND revoked_at IS NULL AND status != 'hold'");
  const now = nowIso();
  tx(db, () => {
    for (const d of items) {
      const prev = inCall.get(d.video_id);
      const verdict = prev !== undefined ? (d.at >= prev ? "apply" : "stale") : answerFreshness(existingAt(d.video_id), d.at);
      if (verdict === "stale") { stale.push(d.video_id); continue; }
      if (verdict === "already") { already.push(d.video_id); continue; }
      const e0 = evRow(d.video_id);
      const live = !!e0 && !e0.excluded_at;
      const c = candRow(d.video_id);
      const detail = () => JSON.stringify({ model: d.model, confidence: d.confidence, rationale: d.rationale, evidence: d.evidence, ...(d.seconds !== undefined ? { seconds: d.seconds } : {}) });
      // 同時視聴ではない（続きの回の候補だけ）。枠は作らず、候補の表に答えを持つ。AI が足した枠があれば（直しの答え）判定を取り消して枠を外す
      if (d.status === "not_watchalong") {
        if (!c) { problems.push({ kind: "invalid", file: d.file, video_id: d.video_id, message: "not_watchalong は続きの回の候補の動画だけ" }); continue; }
        if (live && e0!.detect_source !== "ai_candidate") {
          problems.push({ kind: "invalid", file: d.file, video_id: d.video_id, message: "同時視聴の語で枠になった動画に not_watchalong は入れない" });
          continue;
        }
        if (live) {
          revokeOf.run(now, e0!.id);
          revokeCandidateFrames(db, [e0!.id], now);
        }
        setAnswer.run("not_watchalong", now, "not_watchalong", d.batch, detail(), new Date(d.at).toISOString(), d.video_id);
        inCall.set(d.video_id, d.at);
        cand.notWatchalong.push(d.video_id);
        appliedVids.push(d.video_id);
        continue;
      }
      // 保留で一覧に出る枠が無い候補は、枠を作らず候補のまま（次の回に --include-hold で出す）
      if (d.status === "hold" && !live && c) {
        setAnswer.run("hold", now, "hold", d.batch, detail(), new Date(d.at).toISOString(), d.video_id);
        inCall.set(d.video_id, d.at);
        cand.hold.push(d.video_id);
        appliedVids.push(d.video_id);
        continue;
      }
      // シリーズの項目に付け替えた作品には話数を付けない（どのシーズンの話か分からない）
      const works: AiWork[] = (d.works ?? []).map((w) => ({ key: w.key, work: got.get(w.key), ...(w.episodes?.length && !got.get(w.key)?.liftedFrom ? { episodes: w.episodes } : {}) }));
      const unknown = works.filter((w) => !w.work).map((w) => w.key);
      if (unknown.length) {
        problems.push({ kind: "lookup", file: d.file, video_id: d.video_id, message: `外部DBで引けない（照会のエラーか、作品クラスでない Wikidata の項目）: ${unknown.join(", ")}` });
        continue;
      }
      // 枠は判定より先に作る（ai_decisions.watch_event_id は NOT NULL）。一覧に出る枠が無いのは、noEvent が通した続きの回の候補だけ
      let ev: number;
      if (live) ev = e0!.id;
      else {
        const fr = frameFromCandidate(db, d.video_id, now);
        if (!fr.ok) { problems.push({ kind: "no_event", file: d.file, video_id: d.video_id, message: `候補から枠を作れない: ${fr.why}` }); continue; }
        ev = fr.eventId;
        cand.framed.push(d.video_id);
      }
      const extra = d.title || d.missing?.length || d.kind ? JSON.stringify({
        ...(d.title ? { title: d.title } : {}), ...(d.missing?.length ? { missing: d.missing } : {}),
        ...(d.kind ? { kind: d.kind } : {}), ...(d.movie !== undefined ? { movie: d.movie } : {}),
      }) : null;
      if (d.status === "hold" && locked.get(ev)) reresolve.add(d.video_id);
      else if (d.status !== "hold") reresolve.delete(d.video_id);
      revokeOf.run(now, ev);
      db.prepare(`INSERT INTO ai_decisions (watch_event_id, status, works, confidence, evidence, rationale, model, batch, seconds, decided_at, extra)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(ev, d.status, works.length ? JSON.stringify(works) : null, d.confidence,
        JSON.stringify(d.evidence), d.rationale, d.model, d.batch, d.seconds ?? null, new Date(d.at).toISOString(), extra);
      inCall.set(d.video_id, d.at);
      applied.push(ev);
      appliedVids.push(d.video_id);
    }
    applyAiDecisions(db, cfg.version, [...new Set(applied)]);
  });
  // Wikidata で引いたアニメをアニメのDBの行にまとめ、分割クールを前の作品にまとめ、新しく入った作品の属性（映像の種類・制作国・シリーズの名前）を埋める
  if (applied.length) {
    try {
      await (deps.after ?? (async (c, x) => { await linkAnimeIds(c, x); await mergeSplitCours(c, x); await enrichWorks(c, x); }))(ctx, cfg);
    } catch (e) {
      problems.push({ kind: "enrich", message: `作品の属性を埋められなかった（次の resolve で埋める）: ${String(e).slice(0, 200)}` });
    }
  }
  const by = new Map<string, number>();
  for (const d of items) by.set(`${d.status}/${d.confidence}`, (by.get(`${d.status}/${d.confidence}`) ?? 0) + 1);
  const KIND: Record<ApplyProblemKind, string> = { file: "ファイル", no_event: "枠が無い", invalid: "形が不正", lookup: "外部DBで引けない", enrich: "属性" };
  const text = [
    `入れた判定 ${applied.length} / 答え ${items.length + problems.filter((p) => p.kind === "no_event" || p.kind === "invalid").length}（${[...by].map(([k, v]) => `${k} ${v}`).join("・")}）` +
      `・古い答え ${stale.length}・入れ済み ${already.length}・ファイル ${files.length}`,
    ...(cand.framed.length || cand.notWatchalong.length || cand.hold.length
      ? [`続きの回の候補: 枠を作った ${cand.framed.length}・同時視聴ではない ${cand.notWatchalong.length}・保留（候補のまま）${cand.hold.length}`] : []),
    ...(reresolve.size ? [`確定した判定を保留に置き換えた ${reresolve.size} 件はルールで名寄せし直す`] : []),
    ...problems.map((p) => `  ✖ [${KIND[p.kind]}] ${p.video_id ?? (p.file ? basename(p.file) : "")}: ${p.message}`),
    ...notices.map((x) => `  ・ ${x}`),
  ].join("\n");
  return { text, reresolve: [...reresolve], files, applied: appliedVids, stale, already, problems, notices, candidates: cand };
}

/**
 * batch の答えのファイル（受け箱に置くもの）。answers/*.json と、batch のフォルダの直下の fix-*.json（ai-judging.md の直しの置き場所）。
 * 名前の順（受け箱の中も名前の順に入る）。同じ名前が両方にあれば例外
 */
export function batchAnswerFiles(batch: string): string[] {
  const dir = batchDir(batch);
  const a = existsSync(join(dir, "answers")) ? readdirSync(join(dir, "answers")).filter((x) => x.endsWith(".json")).map((x) => join(dir, "answers", x)) : [];
  const f = existsSync(dir) ? readdirSync(dir).filter((x) => /^fix-.*\.json$/.test(x)).map((x) => join(dir, x)) : [];
  const names = new Set<string>();
  for (const p of [...a, ...f]) {
    if (names.has(basename(p))) throw new Error(`同じ名前の答えのファイルが answers/ と batch の直下にある: ${basename(p)}`);
    names.add(basename(p));
  }
  return [...a, ...f].sort((x, y) => (basename(x) < basename(y) ? -1 : basename(x) > basename(y) ? 1 : 0));
}

export interface CheckFileResult { file: string; ok: boolean; problems: string[]; notices: string[] }

/**
 * 受け箱に置く前の答えの検査（ai:check。docs/ai-ops.md 2・4-2、docs/workflows.md 6-2）。aiApply と同じ readAnswerFile を使う。
 * 見ること: 読める・batch・model・finished_at（時差付き・未来でない）・答えの形（status・confidence・rationale・evidence・works の key・
 * not_a_work / not_in_db の照会の記録）・同じ動画の重複・待ち行列（queue.json）の枠を全部答えているか（answers/NN.json だけ）。
 * DB は見ない（枠が無い答えは ai:ingest が no_event にする）。path はファイル・フォルダ・batch の名前
 */
export function aiCheck(path: string, opts: { now?: number } = {}): { ok: boolean; text: string; files: CheckFileResult[] } {
  const files = existsSync(path) ? answerFiles(path) : batchAnswerFiles(path);
  if (!files.length) return { ok: false, text: `答えのファイルが無い（${path}）`, files: [] };
  const out: CheckFileResult[] = [];
  for (const f of files) {
    const r = readAnswerFile(f, { now: opts.now });
    const problems = r.problems.map((p) => `${p.video_id ? `${p.video_id}: ` : ""}${p.message}`);
    const notices = [...r.notices];
    const seen = new Set<string>();
    for (const v of r.videoIds) {
      if (seen.has(v)) problems.push(`${v}: 同じ動画の答えが2つある`);
      seen.add(v);
    }
    // answers/NN.json は待ち行列 NN の枠を全部答える（迷ったら hold）。fix-*.json は一部だけでよい
    const m = basename(f).match(/^(\d+)\.json$/);
    const batchRoot = join(f, "..", "..");
    if (r.head && m && basename(join(f, "..")) === "answers" && existsSync(join(batchRoot, "queue.json"))) {
      // not_watchalong は待ち行列で続きの回の候補にした動画だけ（D-04。枠に not_watchalong は入らない）
      const qItems = (JSON.parse(readFileSync(join(batchRoot, "queue.json"), "utf8")) as { items: { video_id: string; candidate?: unknown }[] }).items;
      const candVids = new Set(qItems.filter((x) => x.candidate).map((x) => x.video_id));
      for (const it of r.items) if (it.status === "not_watchalong" && !candVids.has(it.video_id)) problems.push(`${it.video_id}: not_watchalong は続きの回の候補の動画だけ（この動画は枠）`);
      const chunk = queueChunks(batchRoot).find((c) => c.nn === m[1]);
      if (!chunk) problems.push(`待ち行列 ${m[1]} が無い`);
      else {
        const lack = chunk.videoIds.filter((v) => !seen.has(v));
        const extra = [...seen].filter((v) => !chunk.videoIds.includes(v));
        if (lack.length) problems.push(`待ち行列 ${m[1]} の枠のうち答えが無い ${lack.length} 件: ${lack.slice(0, 10).join(", ")}${lack.length > 10 ? " …" : ""}`);
        if (extra.length) problems.push(`待ち行列 ${m[1]} に無い枠の答え ${extra.length} 件: ${extra.slice(0, 10).join(", ")}${extra.length > 10 ? " …" : ""}`);
      }
      if (r.head.batch !== basename(batchRoot)) notices.push(`batch が "${r.head.batch}"（フォルダは ${basename(batchRoot)}）`);
    }
    out.push({ file: f, ok: problems.length === 0, problems, notices });
  }
  const ok = out.every((x) => x.ok);
  const text = [
    `ai:check ${out.filter((x) => x.ok).length}/${out.length} ファイルが通った`,
    ...out.flatMap((x) => [`${x.ok ? "ok  " : "FAIL"} ${rel(x.file)}`, ...x.problems.map((p) => `       ✖ ${p}`), ...x.notices.map((p) => `       ・ ${p}`)]),
  ].join("\n");
  return { ok, text, files: out };
}

/** 判定の根拠の一覧（採点用の表）。batch をカンマでつなぐと、複数の回を1つの表にまとめる（出力は data/ai/<回を _ でつないだ名前>/） */
export function aiReport(ctx: Ctx, batch: string, opts: { sample?: number; seed?: string; excludeScored?: string[]; videos?: string[]; includeHigh?: boolean } = {}): string {
  const rows = ctx.db.prepare(`SELECT a.status, a.works, a.confidence, a.evidence, a.rationale, a.seconds, a.revoked_at, e.video_id, e.title_raw, e.started_at, s.name AS streamer
    FROM ai_decisions a JOIN watch_events e ON e.id = a.watch_event_id JOIN streamers s ON s.id = e.streamer_id
    WHERE a.batch IN (${batch.split(",").map(() => "?").join(",")}) ORDER BY a.id`).all(...batch.split(",")) as Record<string, string | number | null>[];
  rows.push(...candidateAnswerRows(ctx.db, batch.split(",")));
  const label: Record<string, string> = {
    identified: "同定", not_a_work: "作品ではない", unidentifiable: "作品を特定できない", not_in_db: "作品だが外部DBに無い", hold: "保留", not_watchalong: "同時視聴ではない",
  };
  // 作品名は DB の今の行から出す（判定の記録の作品名は判定のときのまま。日本語のラベルが無い項目は QID になっていた）
  const nowTitle = (key: string, fallback: string | undefined) => {
    const [src, id] = key.split(":");
    const col = src === "annict" ? "annict_id" : src === "anilist" ? "anilist_id" : src === "wikidata" ? "wikidata_id" : null;
    const row = col && id ? (ctx.db.prepare(`SELECT title FROM works WHERE ${col} = ?`).get(src === "wikidata" ? id : Number(id)) as { title: string } | undefined) : undefined;
    return row?.title ?? fallback ?? "?";
  };
  const out = [
    `# AI の判定の根拠（${batch}）`,
    "",
    "採点のしかた: 「採点」欄に ○（正しい）/ ×（誤り。正しい答えを添える）/ ？（判断できない）を書く。保留は、決められたはずなのに保留にしたものを × にする。",
    "確度が low の同定はサイトに出さない（出すのは high と medium）。",
    "",
  ];
  // 採点に使う材料（待ち行列に書き出した概要欄の行とサムネイル）
  const batches = batch.split(",");
  const dirs = batches.map(batchDir);
  const dir = batchDir(batches.join("_"));
  const queued = new Map<string, QueueItem>();
  for (const d of dirs) {
    if (!existsSync(join(d, "queue.json"))) continue;
    for (const x of (JSON.parse(readFileSync(join(d, "queue.json"), "utf8")) as { items: QueueItem[] }).items) queued.set(x.video_id, x);
  }
  // サムネイルは回ごとのフォルダにある（複数の回をまとめた表では、あとの回のフォルダから探して相対パスで指す）
  const thumbOf = (vid: string): string | null => {
    for (const d of [...dirs].reverse()) {
      if (existsSync(join(d, "thumbs", `${vid}.jpg`))) return batches.length > 1 ? `../${basename(d)}/thumbs/${vid}.jpg` : `thumbs/${vid}.jpg`;
    }
    return null;
  };
  const count = new Map<string, number>();
  for (const r of rows) if (!r.revoked_at) count.set(String(r.status), (count.get(String(r.status)) ?? 0) + 1);
  out.push(`件数（取り消していないもの）: ${[...count].map(([k, v]) => `${label[k] ?? k} ${v}`).join("・")}`, "");
  rows.forEach((r, i) => {
    const works = r.works ? (JSON.parse(String(r.works)) as AiWork[]) : [];
    const ev = JSON.parse(String(r.evidence)) as DecisionInput["evidence"];
    const q = queued.get(String(r.video_id));
    const thumb = thumbOf(String(r.video_id));
    out.push(`## ${i + 1}. ${r.video_id}　${r.streamer}　${String(r.started_at).slice(0, 10)}${r.revoked_at ? "（取り消し済み）" : ""}`);
    if (thumb) out.push(`![サムネイル](${thumb})`, "");
    out.push(`- タイトル: ${r.title_raw}`);
    out.push(`- URL: https://www.youtube.com/watch?v=${r.video_id}`);
    if (q) out.push(`- 概要欄（ローカルの確認用・公開しない）: ${q.description_lines.join(" ／ ") || "なし"}`);
    out.push(`- 判定: **${label[String(r.status)] ?? r.status}**（確度 ${r.confidence}）`);
    for (const w of works) {
      const c = w.work;
      out.push(`  - ${w.key} ${nowTitle(w.key, c?.title)}（${c?.media ?? "?"}・${c?.releaseYear ?? "?"}）${w.episodes?.length ? ` 話数 ${w.episodes.join(",")}` : ""}`);
    }
    out.push(`- 見たもの: ${ev.looked.join("・")}${ev.queries?.length ? `（照会: ${ev.queries.join(" ／ ")}）` : ""}`);
    if (ev.thumbnail) out.push(`- サムネイル: ${ev.thumbnail}`);
    out.push(`- 理由: ${r.rationale}`);
    out.push(`- 採点: `);
    out.push("");
  });
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "report.md");
  writeFileSync(path, out.join("\n"), "utf8");

  // 採点用の HTML（正しい / 誤り / 判断できない とメモ。scores.md に書き出す）。取り消した判定は出さない
  const order = ["identified", "not_a_work", "unidentifiable", "not_in_db", "hold", "not_watchalong"];
  // 採点の表に出す枠（2026-10-03 決定。AI の判定は正しそうなので、確度 high は見せない）:
  // 確度が high でない判定・保留・作品を特定できない・--video で指定した枠は全部出す。確度 high は出さない
  // （--sample N で high からシードで N 件を抜き取りで出す。--include-high で全部出す）
  const MUST = new Set(["hold", "unidentifiable"]);
  const scoredMd = (opts.excludeScored ?? []).map((f) => readFileSync(f, "utf8"));
  const scored = new Set(scoredMd.flatMap((md) => scoredVideos(md)));
  // 採点の表に出したのに採点していない枠（「（未）」）は、残りの表にも出す（抽出を最後まで採点するため）
  const forced = new Set([...(opts.videos ?? []), ...scoredMd.flatMap((md) => scoredVideos(md, true))]);
  let live = rows.filter((r) => !r.revoked_at && !scored.has(String(r.video_id)));
  const must = live.filter((r) => MUST.has(String(r.status)) || String(r.confidence) !== "high" || forced.has(String(r.video_id)));
  if (!opts.includeHigh) {
    const mustIds = new Set(must.map((r) => String(r.video_id)));
    const rest = live.filter((r) => !mustIds.has(String(r.video_id)));
    const keep = new Set(sampleOrder(opts.seed ?? `${batch}-score`, rest.map((r) => String(r.video_id))).slice(0, opts.sample ?? 0));
    live = live.filter((r) => mustIds.has(String(r.video_id)) || keep.has(String(r.video_id)));
  }
  // 判定の前のルールの答え（本番の待ち行列は sealed/ に残している）
  const sealedRule = new Map<string, RuleAnswer>();
  for (const d of dirs) {
    if (!existsSync(join(d, "sealed", "answers.json"))) continue;
    for (const a of (JSON.parse(readFileSync(join(d, "sealed", "answers.json"), "utf8")) as { answers: RuleAnswer[] }).answers) sealedRule.set(a.video_id, a);
  }
  const ruleBlock = (vid: string, q: QueueItem | undefined) => {
    const ru = sealedRule.get(vid);
    // 続きの回の候補（D-04）はルールの答えが無い。候補の理由（層）を出す
    const cand = (ru as unknown as { candidate?: { reasons: string[] } } | undefined)?.candidate;
    if (cand) return { status: `判定の前: 続きの回の候補（題名に同時視聴の語が無い。層 ${cand.reasons.join("・")}）`, lines: [], flags: "" };
    if (ru) {
      return {
        status: `判定の前のルール（型 ${stratumOf(ru)}）: ${ru.status === "identified" ? "同定" : `未同定（${ru.reason ?? ru.status}）`}`,
        lines: ru.status === "identified" ? ru.works.map((w) => `${w.title}（${w.keys.join(" ")}・${w.media ?? "?"}・${w.season ?? w.year ?? "?"}）${w.episodes.length ? ` 話 ${w.episodes.join(",")}` : ""}`) : (ru.text ? [`「${ru.text}」`] : []),
        flags: ru.flags.join("・"),
      };
    }
    return {
      status: `判定の前のルール: 未同定（${q?.reason ?? "?"}）`,
      lines: q?.segments?.length ? [`区間: ${q.segments.join(" ／ ")}`] : [],
      flags: q?.notes?.join(" ／ ") ?? "",
    };
  };
  const sections = order.filter((k) => live.some((r) => r.status === k))
    .map((k) => ({
      key: k, label: label[k] ?? k, required: true,
      ...(k === "hold" ? { note: "決められたはずなのに保留にしたものを「誤り」にする（英語のタイトルの枠は無理に同定しないので、保留を誤りにしない）" } : {}),
      ...(k === "not_watchalong" ? { note: "続きの回の候補の答え。同時視聴の配信なのに「同時視聴ではない」としたものを「誤り」にする（作品ではないものを観る同時視聴は not_a_work が正しい）" } : {}),
    }));
  const items: ReviewItem[] = sections.flatMap((sec) => live.filter((r) => r.status === sec.key).map((r, i) => {
    const works = r.works ? (JSON.parse(String(r.works)) as AiWork[]) : [];
    const ev = JSON.parse(String(r.evidence)) as DecisionInput["evidence"];
    const q = queued.get(String(r.video_id));
    const vid = String(r.video_id);
    return {
      id: vid, no: i + 1, section: sec.key, type: sec.label, typeLabel: `AI の判定: ${sec.label}`,
      streamer: String(r.streamer), started_at: String(r.started_at ?? "").slice(0, 10), title: String(r.title_raw),
      url: `https://www.youtube.com/watch?v=${vid}`, thumb: thumbOf(vid),
      desc: q?.description_lines ?? [],
      rule: ruleBlock(vid, q),
      ai: {
        status: label[String(r.status)] ?? String(r.status), confidence: String(r.confidence),
        lines: works.map((w) => `${nowTitle(w.key, w.work?.title)}（${w.key}・${w.work?.media ?? "?"}・${w.work?.releaseYear ?? "?"}）${w.episodes?.length ? ` 話 ${w.episodes.join(",")}` : ""}`),
        looked: `${ev.looked.join("・")}${ev.queries?.length ? `（照会: ${ev.queries.join(" ／ ")}）` : ""}`,
        thumbnail: ev.thumbnail ?? "", rationale: String(r.rationale),
      },
      why: "",
    };
  }));
  // 採点済みを除いた「残り」の表は、別のファイル・別の保存先（ブラウザの記録）にする
  const rest = scored.size > 0;
  const html = join(dir, rest ? "report-rest.html" : "report.html");
  const file = rest ? "scores-rest.md" : "scores.md";
  writeReviewHtml(html, { mode: "score", batch: rest ? `${batch}（残り）` : batch, source: path, file, sections, items });
  const byStatus = [...new Set(items.map((x) => x.section))].map((k) => `${label[k] ?? k} ${items.filter((x) => x.section === k).length}`).join("・");
  return `${rows.length} 件 → ${path}・採点用 ${html}（${items.length} 件: ${byStatus}。確度 high 以外・保留・特定できない・指定の枠 ${must.length}${opts.includeHigh ? "（確度 high も全部）" : opts.sample ? `、確度 high から抜き取り ${opts.sample}` : ""}${scored.size ? `、採点済みで除いた ${scored.size}` : ""}）`;
}

/**
 * 続きの回の候補（D-04）で、枠を作らない答え（not_watchalong と、一覧に出る枠の無い候補の hold）は ai_decisions に無く、候補の表に持つ。
 * ai:report の表に ai_decisions の行と同じ形で出す。候補の表は動画ごとに最後の答えだけを持つので、その batch の答えがあとの答えで置き換わっていれば出ない。
 * 取り消した答え（answer_revoked_at）と、あとで枠を作った候補（state が答えと違う）は取り消し済みとして出す
 */
export function candidateAnswerRows(db: DB, batches: string[]): Record<string, string | number | null>[] {
  const rows = db.prepare(`SELECT c.answer_status AS status, c.answer_detail, c.answer_revoked_at, c.state, c.answered_at, c.video_id, c.title_raw, c.started_at, s.name AS streamer
    FROM candidates c JOIN streamers s ON s.id = c.streamer_id
    WHERE c.answer_status IS NOT NULL AND c.answer_batch IN (${batches.map(() => "?").join(",")}) ORDER BY c.answered_at, c.id`).all(...batches) as Record<"status" | "answer_detail" | "answer_revoked_at" | "state" | "answered_at" | "video_id" | "title_raw" | "started_at" | "streamer", string | null>[];
  return rows.map((r) => {
    const d = JSON.parse(String(r.answer_detail ?? "{}")) as { confidence?: string; rationale?: string; evidence?: unknown; seconds?: number };
    return {
      status: r.status, works: null, confidence: d.confidence ?? "low", evidence: JSON.stringify(d.evidence ?? { looked: [] }), rationale: d.rationale ?? "", seconds: d.seconds ?? null,
      revoked_at: r.answer_revoked_at ?? (r.state !== r.status ? r.answered_at : null),
      video_id: r.video_id, title_raw: r.title_raw, started_at: r.started_at, streamer: r.streamer,
    };
  });
}

/** 採点の書き出し（scores*.md）から、採点済みの枠（「採点: （未）」でないもの）の動画 ID。unscored なら採点していない枠 */
export function scoredVideos(md: string, unscored = false): string[] {
  const out: string[] = [];
  for (const block of md.split(/\n(?=### )/)) {
    const id = block.match(/^### \d+\. (\S+)　/)?.[1];
    const score = block.match(/\n- 採点: (.*)/)?.[1]?.trim();
    if (id && score && (score === "（未）") === unscored) out.push(id);
  }
  return out;
}


/**
 * 判定を取り消す（行は残して revoked_at を立てる）。
 * - ルールの枠: video_id を reresolve に返す（呼び出し側でルールの名寄せをし直す）
 * - AI が続きの回の候補から足した枠（detect_source = 'ai_candidate'。D-04）: ルールでは枠にならないので、枠を外す（excluded_reason = 'ai_revoked'。行は消さない）。
 *   候補は判定に回す状態（ready）に戻る（src/candidates/frames.ts の revokeCandidateFrames）
 * - 候補の表に持つ答え（not_watchalong・hold）: answer_revoked_at を立てて ready に戻す（答えの時刻 answered_at は残す。古い答えの決まりで、取り消した答え・それより古い答えはもう入らない）
 */
export function aiRevoke(ctx: Ctx, opts: { batch?: string; videos?: string[] }): { reresolve: string[]; candidateFrames: string[]; candidateAnswers: string[] } {
  const db = ctx.db;
  const where = opts.batch ? "a.batch = ?" : `e.video_id IN (${(opts.videos ?? []).map(() => "?").join(",") || "''"})`;
  const params = opts.batch ? [opts.batch] : opts.videos ?? [];
  const rows = db.prepare(`SELECT a.id, a.watch_event_id, e.video_id, e.detect_source FROM ai_decisions a JOIN watch_events e ON e.id = a.watch_event_id
    WHERE a.revoked_at IS NULL AND ${where}`).all(...params) as { id: number; watch_event_id: number; video_id: string; detect_source: string }[];
  const cwhere = opts.batch ? "answer_batch = ?" : `video_id IN (${(opts.videos ?? []).map(() => "?").join(",") || "''"})`;
  const answers = (db.prepare(`SELECT video_id FROM candidates WHERE state IN ('not_watchalong', 'hold') AND answer_revoked_at IS NULL AND ${cwhere}`)
    .all(...params) as { video_id: string }[]).map((r) => r.video_id);
  const now = nowIso();
  tx(db, () => {
    for (const r of rows) db.prepare("UPDATE ai_decisions SET revoked_at = ? WHERE id = ?").run(now, r.id);
    revokeCandidateFrames(db, rows.filter((r) => r.detect_source === "ai_candidate").map((r) => r.watch_event_id), now);
    const back = db.prepare("UPDATE candidates SET state = 'ready', state_at = ?, answer_revoked_at = ? WHERE video_id = ?");
    for (const v of answers) back.run(now, now, v);
  });
  return {
    reresolve: rows.filter((r) => r.detect_source !== "ai_candidate").map((r) => r.video_id),
    candidateFrames: rows.filter((r) => r.detect_source === "ai_candidate").map((r) => r.video_id),
    candidateAnswers: answers,
  };
}
