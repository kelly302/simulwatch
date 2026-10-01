import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Ctx } from "../lib/context.ts";
import { tx } from "../lib/db.ts";
import { DATA_DIR } from "../lib/paths.ts";
import { nowIso } from "../lib/time.ts";
import { activeEventSql, farFutureCutoff } from "../lib/events.ts";
import { normalize, templateLines } from "../detect/detect.ts";
import type { ExtractConfig } from "../resolve/config.ts";
import { ResolveCache } from "../resolve/cache.ts";
import { AnnictClient } from "../resolve/sources/annict.ts";
import { AniListClient } from "../resolve/sources/anilist.ts";
import { WikipediaClient } from "../resolve/sources/wikipedia.ts";
import { labelCandidate, workMedia } from "../resolve/match.ts";
import { applyAiDecisions } from "../resolve/ai.ts";
import type { AiStatus, AiConfidence, AiWork } from "../resolve/ai.ts";
import type { WorkCandidate } from "../resolve/types.ts";
import { sampleOrder } from "./sample.ts";

// AI による判定の道具（ローカルの CLI。定期実行のジョブからは呼ばない）。
//
//   ai:queue   判定する枠を選び、タイトル・概要欄の行・切り出した区間・サムネイルを data/ai/<batch>/ に書き出す
//   （判定）   Claude Code のセッションで、queue.md とサムネイルを見て、外部作品DBを lookup で確かめ、decisions.json を書く
//   ai:apply   decisions.json を DB に入れる（外部DBから作品を引いて確定させる）。同じファイルを何度入れても同じ結果
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

const SELF = /(今日|本日|今回|この配信|この枠|を見ます|を観ます|みます|見ていく|観ていく|同時視聴)/;

function batchDir(batch: string): string {
  if (!/^[A-Za-z0-9_.-]+$/.test(batch)) throw new Error(`batch の名前は英数字と _ . - だけにしてください: ${batch}`);
  return join(DATA_DIR, "ai", batch);
}

/**
 * 概要欄の行を AI に見せる形にする。定型文（同じ配信者の枠に繰り返し出る行）と URL の行を除き、
 * その枠を指す行を先に、残りは先頭から（合わせて12行まで、1行120文字まで）
 */
export function descriptionReader(ctx: Ctx): (streamerId: number, raw: string | null) => string[] {
  const templates = new Map<number, Set<string>>();
  const templatesOf = (sid: number) => {
    let t = templates.get(sid);
    if (!t) {
      const ds = (ctx.db.prepare("SELECT description_raw FROM watch_events WHERE streamer_id = ?").all(sid) as { description_raw: string | null }[]).map((x) => x.description_raw);
      t = templateLines(ds, ctx.detectCfg);
      templates.set(sid, t);
    }
    return t;
  };
  return (sid, raw) => {
    const tpl = templatesOf(sid);
    const lines = String(raw ?? "").split(/\r?\n/).map((l) => l.trim())
      .filter((l) => l && !tpl.has(normalize(l, ctx.detectCfg.normalize)) && !/^https?:\/\//.test(l));
    const self = lines.filter((l) => SELF.test(l));
    return [...self, ...lines.filter((l) => !SELF.test(l))].slice(0, 12).map((l) => l.slice(0, 120));
  };
}

/** サムネイルを判定のためだけにローカルへ落とす（サイトには使わない）。取れなければ null（タイトル・概要欄だけで見る） */
export async function downloadThumb(ctx: Ctx, url: string | null, dir: string, videoId: string): Promise<string | null> {
  if (!url || !/^https:\/\/i\d?\.ytimg\.com\//.test(url)) return null;
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${videoId}.jpg`);
  if (!existsSync(path)) {
    try {
      const res = await fetch(url, { headers: { "user-agent": ctx.crawlCfg.http.user_agent }, signal: AbortSignal.timeout(15_000) });
      if (res.ok) writeFileSync(path, Buffer.from(await res.arrayBuffer()));
      await new Promise((ok) => setTimeout(ok, 150));
    } catch {
      // サムネイルが取れなくても判定はできる
    }
  }
  return existsSync(path) ? path : null;
}

/** 判定する枠を選んで書き出す。AI の判定がすでにある枠（hold を含む）は選ばない */
export async function aiQueue(ctx: Ctx, cfg: ExtractConfig, opts: { reason: string; n: number; seed: string; batch: string }): Promise<string> {
  const db = ctx.db;
  const cutoff = farFutureCutoff(ctx.crawlCfg.upcoming.max_days_ahead);
  const rows = db.prepare(`SELECT e.id, e.video_id, e.title_raw, e.description_raw, e.thumbnail_url, e.started_at, e.streamer_id, s.name AS streamer,
      u.reason, u.detail
    FROM unresolved u JOIN watch_events e ON e.id = u.watch_event_id JOIN streamers s ON s.id = e.streamer_id
    WHERE u.resolved_at IS NULL AND u.reason = ? AND ${activeEventSql("e")}
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
    `- 母集団: 一覧に出る枠のうち未同定の理由が ${opts.reason} で、AI の判定がまだ無いもの（${rows.length} 枠）`,
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
  if (ids("wikidata:").length) for (const [q, e] of await wp.entities(ids("wikidata:"))) if (workMedia(e, cfg)) got.set(`wikidata:${q}`, labelCandidate(e, cfg));
  return got;
}

/** 判定のファイルを検査して、作品の情報を外部DBから引いて DB に入れる */
export async function aiApply(ctx: Ctx, cfg: ExtractConfig, file: string): Promise<string> {
  const f = JSON.parse(readFileSync(file, "utf8")) as DecisionFile;
  if (!f.batch || !f.model || !Array.isArray(f.decisions)) throw new Error("batch・model・decisions が必要です");
  const db = ctx.db;
  const problems: string[] = [];
  const STATUS = new Set(["identified", "not_a_work", "unidentifiable", "hold"]);
  const CONF = new Set(["high", "medium", "low"]);
  const evOf = db.prepare("SELECT id FROM watch_events WHERE video_id = ?");
  const valid = f.decisions.filter((d) => {
    const why = !evOf.get(d.video_id) ? "枠が無い" : !STATUS.has(d.status) ? `status が不正: ${d.status}` : !CONF.has(d.confidence) ? `confidence が不正: ${d.confidence}`
      : !d.rationale?.trim() ? "rationale が空" : !Array.isArray(d.evidence?.looked) || d.evidence.looked.length === 0 ? "evidence.looked が空"
        : d.status === "identified" && !(d.works ?? []).length ? "identified なのに works が空"
          : (d.works ?? []).some((w) => !/^(annict:\d+|anilist:\d+|wikidata:Q\d+)$/.test(w.key)) ? "works の key が不正" : null;
    if (why) problems.push(`${d.video_id}: ${why}`);
    return !why;
  });

  // 作品の情報を外部DBから引く
  const got = await fetchWorks(ctx, cfg, [...new Set(valid.flatMap((d) => (d.works ?? []).map((w) => w.key)))]);

  const applied: number[] = [];
  const now = nowIso();
  tx(db, () => {
    for (const d of valid) {
      const works: AiWork[] = (d.works ?? []).map((w) => ({ key: w.key, work: got.get(w.key), ...(w.episodes?.length ? { episodes: w.episodes } : {}) }));
      const missing = works.filter((w) => !w.work).map((w) => w.key);
      if (missing.length) { problems.push(`${d.video_id}: 外部DBで引けない（作品クラスでない Wikidata の項目を含む）: ${missing.join(", ")}`); continue; }
      const ev = (evOf.get(d.video_id) as { id: number }).id;
      db.prepare("UPDATE ai_decisions SET revoked_at = ? WHERE watch_event_id = ? AND revoked_at IS NULL").run(now, ev);
      db.prepare(`INSERT INTO ai_decisions (watch_event_id, status, works, confidence, evidence, rationale, model, batch, seconds, decided_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(ev, d.status, works.length ? JSON.stringify(works) : null, d.confidence,
        JSON.stringify(d.evidence), d.rationale, f.model, f.batch, d.seconds ?? null, f.finished_at ?? now);
      applied.push(ev);
    }
    applyAiDecisions(db, cfg.version, applied);
  });
  const by = new Map<string, number>();
  for (const d of valid) by.set(`${d.status}/${d.confidence}`, (by.get(`${d.status}/${d.confidence}`) ?? 0) + 1);
  return [`入れた判定 ${applied.length} / ${f.decisions.length}（${[...by].map(([k, v]) => `${k} ${v}`).join("・")}）`, ...problems.map((p) => `  ✖ ${p}`)].join("\n");
}

/** 判定の根拠の一覧（採点用の表） */
export function aiReport(ctx: Ctx, batch: string): string {
  const rows = ctx.db.prepare(`SELECT a.status, a.works, a.confidence, a.evidence, a.rationale, a.seconds, a.revoked_at, e.video_id, e.title_raw, e.started_at, s.name AS streamer
    FROM ai_decisions a JOIN watch_events e ON e.id = a.watch_event_id JOIN streamers s ON s.id = e.streamer_id
    WHERE a.batch = ? ORDER BY a.id`).all(batch) as Record<string, string | number | null>[];
  const label: Record<string, string> = { identified: "同定", not_a_work: "作品ではない", unidentifiable: "作品を特定できない", hold: "保留" };
  const out = [
    `# AI の判定の根拠（${batch}）`,
    "",
    "採点のしかた: 「採点」欄に ○（正しい）/ ×（誤り。正しい答えを添える）/ ？（判断できない）を書く。保留は、決められたはずなのに保留にしたものを × にする。",
    "確度が low の同定はサイトに出さない（出すのは high と medium）。",
    "",
  ];
  // 採点に使う材料（待ち行列に書き出した概要欄の行とサムネイル）
  const dir = batchDir(batch);
  const queued = new Map<string, QueueItem>();
  if (existsSync(join(dir, "queue.json"))) {
    for (const x of (JSON.parse(readFileSync(join(dir, "queue.json"), "utf8")) as { items: QueueItem[] }).items) queued.set(x.video_id, x);
  }
  const count = new Map<string, number>();
  for (const r of rows) if (!r.revoked_at) count.set(String(r.status), (count.get(String(r.status)) ?? 0) + 1);
  out.push(`件数（取り消していないもの）: ${[...count].map(([k, v]) => `${label[k] ?? k} ${v}`).join("・")}`, "");
  rows.forEach((r, i) => {
    const works = r.works ? (JSON.parse(String(r.works)) as AiWork[]) : [];
    const ev = JSON.parse(String(r.evidence)) as DecisionInput["evidence"];
    const q = queued.get(String(r.video_id));
    const thumb = join(dir, "thumbs", `${r.video_id}.jpg`);
    out.push(`## ${i + 1}. ${r.video_id}　${r.streamer}　${String(r.started_at).slice(0, 10)}${r.revoked_at ? "（取り消し済み）" : ""}`);
    if (existsSync(thumb)) out.push(`![サムネイル](thumbs/${r.video_id}.jpg)`, "");
    out.push(`- タイトル: ${r.title_raw}`);
    out.push(`- URL: https://www.youtube.com/watch?v=${r.video_id}`);
    if (q) out.push(`- 概要欄（ローカルの確認用・公開しない）: ${q.description_lines.join(" ／ ") || "なし"}`);
    out.push(`- 判定: **${label[String(r.status)] ?? r.status}**（確度 ${r.confidence}）`);
    for (const w of works) {
      const c = w.work;
      out.push(`  - ${w.key} ${c?.title ?? "?"}（${c?.media ?? "?"}・${c?.releaseYear ?? "?"}）${w.episodes?.length ? ` 話数 ${w.episodes.join(",")}` : ""}`);
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
  return `${rows.length} 件 → ${path}`;
}

/** 判定を取り消す。取り消した枠の video_id を返す（呼び出し側でルールの名寄せをし直す） */
export function aiRevoke(ctx: Ctx, opts: { batch?: string; videos?: string[] }): string[] {
  const db = ctx.db;
  const where = opts.batch ? "a.batch = ?" : `e.video_id IN (${(opts.videos ?? []).map(() => "?").join(",") || "''"})`;
  const params = opts.batch ? [opts.batch] : opts.videos ?? [];
  const rows = db.prepare(`SELECT a.id, e.video_id FROM ai_decisions a JOIN watch_events e ON e.id = a.watch_event_id WHERE a.revoked_at IS NULL AND ${where}`)
    .all(...params) as { id: number; video_id: string }[];
  const now = nowIso();
  tx(db, () => {
    for (const r of rows) db.prepare("UPDATE ai_decisions SET revoked_at = ? WHERE id = ?").run(now, r.id);
  });
  return rows.map((r) => r.video_id);
}
