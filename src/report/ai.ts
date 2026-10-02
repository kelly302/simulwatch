import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync } from "node:fs";
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
import { liftLiveSeasons } from "../resolve/lift.ts";
import { enrichWorks } from "../resolve/enrich.ts";
import { linkAnimeIds } from "../resolve/link.ts";
import type { AiStatus, AiConfidence, AiWork } from "../resolve/ai.ts";
import type { WorkCandidate } from "../resolve/types.ts";
import { sampleOrder } from "./sample.ts";
import { descriptionReader, downloadThumb, writeBlindQueue } from "./blind.ts";
import { collectRoutes } from "../resolve/routing.ts";
import type { RuleAnswer } from "../resolve/routing.ts";
import { needsAi, stratumOf } from "../resolve/route.ts";
import { writeReviewHtml } from "./review.ts";
import { validateAnswer } from "./answer.ts";
import type { AuditAnswer } from "./answer.ts";
import type { ReviewItem } from "./review.ts";

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

function batchDir(batch: string): string {
  if (!/^[A-Za-z0-9_.-]+$/.test(batch)) throw new Error(`batch の名前は英数字と _ . - だけにしてください: ${batch}`);
  return join(DATA_DIR, "ai", batch);
}

/** 判定する枠を選んで書き出す。AI の判定がすでにある枠（hold を含む）は選ばない */
/**
 * 本番の待ち行列（2026-10-01）。AI に回す型（config/extract.yaml の ai_routes）の枠のうち、AI の判定がまだ無いもの
 * （includeHold なら保留も）から、sha256(シード:video_id) の昇順で先頭 n 件。候補を見せない形で書き出す（src/report/blind.ts）。
 * ルールの答えは sealed/ に残し、採点の表（ai:report）で並べる
 */
export async function aiQueueRoutes(
  ctx: Ctx, cfg: ExtractConfig,
  opts: { batch: string; seed: string; n: number; routes?: string[]; includeHold?: boolean; videos?: string[] },
): Promise<string> {
  const dir = batchDir(opts.batch);
  if (existsSync(join(dir, "sealed", "answers.json"))) throw new Error(`${dir} はもうあります。別の batch 名にしてください`);
  const routes = opts.routes ?? cfg.ai_routes ?? [];
  if (!routes.length) throw new Error("AI に回す型がありません（config/extract.yaml の ai_routes）");
  const { routed } = await collectRoutes(ctx, cfg);
  const decided = new Map((ctx.db.prepare("SELECT watch_event_id, status FROM ai_decisions WHERE revoked_at IS NULL").all() as
    { watch_event_id: number; status: string }[]).map((r) => [r.watch_event_id, r.status]));
  const pool = routed.filter((r) => needsAi(r.rule, routes) && (!decided.has(r.ev.id) || (opts.includeHold && decided.get(r.ev.id) === "hold"))
    && (!opts.videos || opts.videos.includes(r.ev.video_id)));
  const byVid = new Map(pool.map((r) => [r.ev.video_id, r]));
  const rows = sampleOrder(opts.seed, [...byVid.keys()]).slice(0, opts.n).map((v) => byVid.get(v)!);
  const perRoute: Record<string, number> = {};
  for (const r of pool) perRoute[stratumOf(r.rule)] = (perRoute[stratumOf(r.rule)] ?? 0) + 1;
  const picked: Record<string, number> = {};
  for (const r of rows) picked[stratumOf(r.rule)] = (picked[stratumOf(r.rule)] ?? 0) + 1;
  const created = nowIso();
  const { items, chunks } = await writeBlindQueue(ctx, dir, {
    batch: opts.batch, seed: opts.seed, rows,
    sealed: { created_at: created, routes, population: pool.length, per_route: perRoute }, sealedNote: "ai:report が採点の表に使う",
  });
  const plan = [
    `# AI の判定の待ち行列（${opts.batch}）`, "",
    `- 母集団: 一覧に出る枠のうち、AI に回す型（${routes.join("・")}）で、AI の判定がまだ無いもの${opts.includeHold ? "（保留の枠を含む）" : ""}${opts.videos ? `のうち、指定した動画（${opts.videos.join("・")}）` : ""}。${pool.length} 枠`,
    `- 抽出: sha256(シード + ":" + video_id) の昇順で先頭 ${rows.length} 件。シード「${opts.seed}」。待ち行列の並びは sha256(シード + ":queue:" + video_id) の昇順`,
    "- AI に見せるもの: 配信者・日時・タイトル・概要欄（定型文と URL の行を除き、その枠を指す行を先に12行まで）・サムネイル・概要欄のリンク先の題名・同じ配信者の同じ作品名の枠と前後の枠（タイトルと日付だけ）。型・区間・候補・ルールの答えは見せない（GUIDE.md）",
    "- 判定のあと: ai:apply data/ai/<batch>/answers で入れ、ai:report <batch> --sample N --seed S で採点の表を作る", "",
    "| 型 | 母集団 | この待ち行列 |", "| --- | ---: | ---: |",
    ...Object.entries(perRoute).sort((a, b) => b[1] - a[1]).map(([k, v]) => `| ${k} | ${v} | ${picked[k] ?? 0} |`), "",
  ];
  writeFileSync(join(dir, "plan.md"), plan.join("\n"), "utf8");
  return `母集団 ${pool.length} 枠から ${items.length} 件（${Object.entries(picked).map(([k, v]) => `${k} ${v}`).join("・")}）・待ち行列 ${chunks} ファイル → ${dir}`;
}

/** 判定する枠を未同定の理由で選ぶ（ai-trial-1 の形。区間と注記を見せる） */
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
 * 判定のファイルを検査して、作品の情報を外部DBから引いて DB に入れる。
 * file はファイルかフォルダ（中の *.json をすべて）。形式は2つ:
 *   decisions（ai-trial-1 の形）と answers（候補を見ない判定の形。src/report/answer.ts。not_in_db・missing・also を持つ）
 */
export async function aiApply(ctx: Ctx, cfg: ExtractConfig, file: string): Promise<string> {
  const files = statSync(file).isDirectory()
    ? readdirSync(file).filter((x) => x.endsWith(".json")).sort().map((x) => join(file, x))
    : [file];
  const db = ctx.db;
  const problems: string[] = [];
  const CONF = new Set(["high", "medium", "low"]);
  const evOf = db.prepare("SELECT id FROM watch_events WHERE video_id = ?");
  type Item = DecisionInput & { title?: string; missing?: string[]; kind?: string; movie?: boolean; model: string; batch: string; finished_at?: string };
  const items: Item[] = [];
  for (const f of files) {
    const j = JSON.parse(readFileSync(f, "utf8")) as Partial<DecisionFile> & { answers?: AuditAnswer[] };
    if (!j.batch || !j.model || (!Array.isArray(j.decisions) && !Array.isArray(j.answers))) { problems.push(`${f}: batch・model・decisions（または answers）が必要`); continue; }
    if (j.answers) {
      for (const a of j.answers) {
        const why = !evOf.get(a.video_id) ? "枠が無い" : validateAnswer(a);
        if (why) { problems.push(`${a.video_id}: ${why}`); continue; }
        // 2026-10-02 より前の答えには無い（受け付けて、UI の絞り込みから漏れることだけ知らせる）
        if (a.status === "not_in_db" && (!a.kind || a.movie === undefined)) problems.push(`${a.video_id}: not_in_db に kind・movie が無い（映像の種類・映画での絞り込みに出ない）`);
        items.push({
          video_id: a.video_id, status: a.status as AiStatus, confidence: a.confidence, evidence: a.evidence, rationale: a.rationale, seconds: a.seconds,
          works: (a.works ?? []).map((w) => ({ key: w.key, ...(w.episodes?.length ? { episodes: w.episodes } : {}) })),
          ...(a.title ? { title: a.title } : {}), ...(a.missing?.length ? { missing: a.missing } : {}),
          ...(a.kind ? { kind: a.kind } : {}), ...(a.movie !== undefined ? { movie: a.movie } : {}),
          model: j.model, batch: j.batch, finished_at: j.finished_at,
        });
      }
    } else {
      const STATUS = new Set(["identified", "not_a_work", "unidentifiable", "hold"]);
      for (const d of j.decisions!) {
        const why = !evOf.get(d.video_id) ? "枠が無い" : !STATUS.has(d.status) ? `status が不正: ${d.status}` : !CONF.has(d.confidence) ? `confidence が不正: ${d.confidence}`
          : !d.rationale?.trim() ? "rationale が空" : !Array.isArray(d.evidence?.looked) || d.evidence.looked.length === 0 ? "evidence.looked が空"
            : d.status === "identified" && !(d.works ?? []).length ? "identified なのに works が空"
              : (d.works ?? []).some((w) => !/^(annict:\d+|anilist:\d+|wikidata:Q\d+)$/.test(w.key)) ? "works の key が不正" : null;
        if (why) { problems.push(`${d.video_id}: ${why}`); continue; }
        items.push({ ...d, model: j.model, batch: j.batch, finished_at: j.finished_at });
      }
    }
  }

  // 作品の情報を外部DBから引く
  const got = await fetchWorks(ctx, cfg, [...new Set(items.flatMap((d) => (d.works ?? []).map((w) => w.key)))]);

  const applied: number[] = [];
  const now = nowIso();
  tx(db, () => {
    for (const d of items) {
      // シリーズの項目に付け替えた作品には話数を付けない（どのシーズンの話か分からない）
      const works: AiWork[] = (d.works ?? []).map((w) => ({ key: w.key, work: got.get(w.key), ...(w.episodes?.length && !got.get(w.key)?.liftedFrom ? { episodes: w.episodes } : {}) }));
      const unknown = works.filter((w) => !w.work).map((w) => w.key);
      if (unknown.length) { problems.push(`${d.video_id}: 外部DBで引けない（作品クラスでない Wikidata の項目を含む）: ${unknown.join(", ")}`); continue; }
      const ev = (evOf.get(d.video_id) as { id: number }).id;
      const extra = d.title || d.missing?.length || d.kind ? JSON.stringify({
        ...(d.title ? { title: d.title } : {}), ...(d.missing?.length ? { missing: d.missing } : {}),
        ...(d.kind ? { kind: d.kind } : {}), ...(d.movie !== undefined ? { movie: d.movie } : {}),
      }) : null;
      db.prepare("UPDATE ai_decisions SET revoked_at = ? WHERE watch_event_id = ? AND revoked_at IS NULL").run(now, ev);
      db.prepare(`INSERT INTO ai_decisions (watch_event_id, status, works, confidence, evidence, rationale, model, batch, seconds, decided_at, extra)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(ev, d.status, works.length ? JSON.stringify(works) : null, d.confidence,
        JSON.stringify(d.evidence), d.rationale, d.model, d.batch, d.seconds ?? null, d.finished_at ?? now, extra);
      applied.push(ev);
    }
    applyAiDecisions(db, cfg.version, applied);
  });
  // Wikidata で引いたアニメをアニメのDBの行にまとめ、新しく入った作品の属性（映像の種類・制作国・シリーズの名前）を埋める
  try {
    await linkAnimeIds(ctx, cfg);
    await enrichWorks(ctx, cfg);
  } catch (e) {
    problems.push(`作品の属性を埋められなかった（次の resolve で埋める）: ${String(e).slice(0, 200)}`);
  }
  const by = new Map<string, number>();
  for (const d of items) by.set(`${d.status}/${d.confidence}`, (by.get(`${d.status}/${d.confidence}`) ?? 0) + 1);
  return [`入れた判定 ${applied.length} / ${items.length + problems.filter((x) => !x.includes("外部DBで引けない")).length}（${[...by].map(([k, v]) => `${k} ${v}`).join("・")}）`, ...problems.map((x) => `  ✖ ${x}`)].join("\n");
}

/** 判定の根拠の一覧（採点用の表） */
export function aiReport(ctx: Ctx, batch: string, opts: { sample?: number; seed?: string; excludeScored?: string[]; videos?: string[] } = {}): string {
  const rows = ctx.db.prepare(`SELECT a.status, a.works, a.confidence, a.evidence, a.rationale, a.seconds, a.revoked_at, e.video_id, e.title_raw, e.started_at, s.name AS streamer
    FROM ai_decisions a JOIN watch_events e ON e.id = a.watch_event_id JOIN streamers s ON s.id = e.streamer_id
    WHERE a.batch = ? ORDER BY a.id`).all(batch) as Record<string, string | number | null>[];
  const label: Record<string, string> = { identified: "同定", not_a_work: "作品ではない", unidentifiable: "作品を特定できない", not_in_db: "作品だが外部DBに無い", hold: "保留" };
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

  // 採点用の HTML（正しい / 誤り / 判断できない とメモ。scores.md に書き出す）。取り消した判定は出さない
  const order = ["identified", "not_a_work", "unidentifiable", "not_in_db", "hold"];
  // 採点の表に出す枠。抽出（--sample）や採点済みの除外（--exclude-scored）をしても、
  // 保留・作品を特定できない・外部DBに無い（must）と --video で指定した枠は必ず全部出す（2026-10-02 決定。抽出の外に保留が残っていた）
  const MUST = new Set(["hold", "unidentifiable", "not_in_db"]);
  const scoredMd = (opts.excludeScored ?? []).map((f) => readFileSync(f, "utf8"));
  const scored = new Set(scoredMd.flatMap((md) => scoredVideos(md)));
  // 採点の表に出したのに採点していない枠（「（未）」）は、残りの表にも出す（抽出を最後まで採点するため）
  const forced = new Set([...(opts.videos ?? []), ...scoredMd.flatMap((md) => scoredVideos(md, true))]);
  let live = rows.filter((r) => !r.revoked_at && !scored.has(String(r.video_id)));
  const must = live.filter((r) => MUST.has(String(r.status)) || forced.has(String(r.video_id)));
  if (opts.sample !== undefined || scored.size) {
    const mustIds = new Set(must.map((r) => String(r.video_id)));
    const rest = live.filter((r) => !mustIds.has(String(r.video_id)));
    const keep = new Set(sampleOrder(opts.seed ?? `${batch}-score`, rest.map((r) => String(r.video_id))).slice(0, opts.sample ?? 0));
    live = live.filter((r) => mustIds.has(String(r.video_id)) || keep.has(String(r.video_id)));
  }
  // 判定の前のルールの答え（本番の待ち行列は sealed/ に残している）
  const sealedRule = new Map<string, RuleAnswer>();
  if (existsSync(join(dir, "sealed", "answers.json"))) {
    for (const a of (JSON.parse(readFileSync(join(dir, "sealed", "answers.json"), "utf8")) as { answers: RuleAnswer[] }).answers) sealedRule.set(a.video_id, a);
  }
  const ruleBlock = (vid: string, q: QueueItem | undefined) => {
    const ru = sealedRule.get(vid);
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
    .map((k) => ({ key: k, label: label[k] ?? k, required: true, ...(k === "hold" ? { note: "決められたはずなのに保留にしたものを「誤り」にする（英語のタイトルの枠は無理に同定しないので、保留を誤りにしない）" } : {}) }));
  const items: ReviewItem[] = sections.flatMap((sec) => live.filter((r) => r.status === sec.key).map((r, i) => {
    const works = r.works ? (JSON.parse(String(r.works)) as AiWork[]) : [];
    const ev = JSON.parse(String(r.evidence)) as DecisionInput["evidence"];
    const q = queued.get(String(r.video_id));
    const vid = String(r.video_id);
    return {
      id: vid, no: i + 1, section: sec.key, type: sec.label, typeLabel: `AI の判定: ${sec.label}`,
      streamer: String(r.streamer), started_at: String(r.started_at ?? "").slice(0, 10), title: String(r.title_raw),
      url: `https://www.youtube.com/watch?v=${vid}`, thumb: existsSync(join(dir, "thumbs", `${vid}.jpg`)) ? `thumbs/${vid}.jpg` : null,
      desc: q?.description_lines ?? [],
      rule: ruleBlock(vid, q),
      ai: {
        status: label[String(r.status)] ?? String(r.status), confidence: String(r.confidence),
        lines: works.map((w) => `${w.work?.title ?? "?"}（${w.key}・${w.work?.media ?? "?"}・${w.work?.releaseYear ?? "?"}）${w.episodes?.length ? ` 話 ${w.episodes.join(",")}` : ""}`),
        looked: `${ev.looked.join("・")}${ev.queries?.length ? `（照会: ${ev.queries.join(" ／ ")}）` : ""}`,
        thumbnail: ev.thumbnail ?? "", rationale: String(r.rationale),
      },
      why: "",
    };
  }));
  // 採点済みを除いた「残り」の表は、別のファイル・別の保存先（ブラウザの記録）にする
  const rest = scored.size > 0;
  const html = join(dir, rest ? "report-rest.html" : "report.html");
  const file = rest ? "scores-rest.md" : opts.sample !== undefined ? `scores-sample${opts.sample}.md` : "scores.md";
  writeReviewHtml(html, { mode: "score", batch: rest ? `${batch}（残り）` : batch, source: path, file, sections, items });
  const byStatus = [...new Set(items.map((x) => x.section))].map((k) => `${label[k] ?? k} ${items.filter((x) => x.section === k).length}`).join("・");
  return `${rows.length} 件 → ${path}・採点用 ${html}（${items.length} 件: ${byStatus}。必ず出す保留・特定できない・外部DBに無い・指定の枠 ${must.length}${scored.size ? `、採点済みで除いた ${scored.size}` : ""}）`;
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
