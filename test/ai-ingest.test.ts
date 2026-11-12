// 塊 C: AI の答えの取り込み（D-03・D-09。docs/workflows.md 6・docs/ai-ops.md 2・4・5）
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// batch のフォルダ（data/ai/<batch>/）と quota.json は DATA_DIR の下。モジュールを読む前に決める
const DATA = mkdtempSync(join(tmpdir(), "ai-ingest-data-"));
process.env.DATA_DIR = DATA;

const { openDb } = await import("../src/lib/db.ts");
const { dbPack } = await import("../src/lib/dbfile.ts");
const { Quota, QuotaExhausted } = await import("../src/lib/quota.ts");
const { loadCrawlConfig } = await import("../src/lib/config.ts");
const { loadExtractConfig } = await import("../src/resolve/config.ts");
const ai = await import("../src/report/ai.ts");
const inbox = await import("../src/report/inbox.ts");
type Ctx = import("../src/lib/context.ts").Ctx;
type WorkCandidate = import("../src/resolve/types.ts").WorkCandidate;
type ApplyDeps = import("../src/report/ai.ts").ApplyDeps;

const cfg = loadExtractConfig();
let seq = 0;
function tmp(p = "ai-ingest-"): string {
  return mkdtempSync(join(tmpdir(), `${p}${++seq}-`));
}

const VIDEOS = ["v1", "v2", "v3", "v4", "v5", "v6", "v7", "v8"];

/** 小さな DB: 終わった枠 v1〜v8。v1 には +09:00 の、v2 には Z の判定がすでにある */
function setup(): { ctx: Ctx; path: string } {
  const dir = tmp("ai-db-");
  const path = join(dir, "db.sqlite");
  const db = openDb(path);
  db.exec("INSERT INTO streamers (id, name, affiliation, channel_id, tier, first_seen_at, updated_at) VALUES (1, 's', 'nijisanji', 'UCa', 1, 'n', 'n')");
  const ins = db.prepare(`INSERT INTO watch_events (id, streamer_id, video_id, title_raw, url, status, detected_at, detect_source, detect_keyword, found_via, updated_at)
    VALUES (?, 1, ?, 't', 'u', 'completed', 'n', 'title', 'k', 'rss', 'n')`);
  VIDEOS.forEach((v, i) => ins.run(i + 1, v));
  // 判定から外れた枠・アーカイブが消えた枠（「枠が無い」に数える）
  ins.run(101, "vx");
  ins.run(102, "va");
  db.exec("UPDATE watch_events SET excluded_at = 'n' WHERE id = 101; UPDATE watch_events SET archive_gone_at = 'n' WHERE id = 102");
  const dec = db.prepare(`INSERT INTO ai_decisions (watch_event_id, status, works, confidence, evidence, rationale, model, batch, decided_at)
    VALUES (?, 'unidentifiable', NULL, 'high', '{"looked":["title"]}', 'old', 'm', 'old', ?)`);
  dec.run(1, "2026-11-01T12:00:00+09:00"); // = 03:00Z
  dec.run(2, "2026-11-01T03:00:00Z");
  return { ctx: { db } as unknown as Ctx, path };
}

const WORK: WorkCandidate = {
  source: "annict", sourceKey: "annict:1", annictId: 1, anilistId: null, wikidataId: null, malId: null, title: "作品A", titleKana: null, titles: [],
  media: "tv", seasonName: null, releaseYear: 2020, episodesCount: 12, imageUrl: null, seriesId: null,
} as WorkCandidate;

/** 外部DBに照会しない（annict:1 だけ引ける。ほかは「引けない」）。属性の後始末はしない */
const deps: ApplyDeps = {
  fetchWorks: async (_c, _x, keys) => new Map(keys.filter((k) => k === "annict:1").map((k) => [k, WORK])),
  after: async () => {},
};

function ans(video_id: string, status = "unidentifiable", extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { video_id, status, confidence: "high", evidence: { looked: ["title", "lookup"], queries: ["q"] }, rationale: "r", ...extra };
}

function writeAnswers(dir: string, name: string, body: Record<string, unknown> | string): string {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, name);
  writeFileSync(p, typeof body === "string" ? body : JSON.stringify(body), "utf8");
  return p;
}

const file = (finished_at: string | undefined, answers: Record<string, unknown>[], batch = "b") =>
  ({ batch, model: "test-model", ...(finished_at !== undefined ? { finished_at } : {}), answers });

/** 取り消されていない判定の集合（比べる用） */
function live(ctx: Ctx): string[] {
  return (ctx.db.prepare(`SELECT e.video_id, a.status, a.works, a.decided_at, a.batch FROM ai_decisions a JOIN watch_events e ON e.id = a.watch_event_id
    WHERE a.revoked_at IS NULL ORDER BY e.video_id`).all() as Record<string, string>[])
    .map((r) => `${r.video_id}|${r.status}|${r.works ? (JSON.parse(r.works) as { key: string }[]).map((w) => w.key).join(",") : ""}|${r.decided_at}|${r.batch}`);
}
const rowCount = (ctx: Ctx) => (ctx.db.prepare("SELECT COUNT(*) AS n FROM ai_decisions").get() as { n: number }).n;

// ─── 時刻 ───

test("答えの時刻は瞬間で比べる（Z と +09:00 の混在）。時差の無い時刻は読まない", () => {
  assert.equal(ai.answerInstant("2026-11-01T12:00:00+09:00"), Date.parse("2026-11-01T03:00:00Z"));
  assert.equal(ai.answerInstant("2026-11-01T03:00:00.000Z"), Date.parse("2026-11-01T03:00:00Z"));
  assert.equal(ai.answerInstant("2026-11-01T03:00:00"), null);
  assert.equal(ai.answerInstant("2026-11-01"), null);
  assert.equal(ai.answerInstant("きのう"), null);
  assert.equal(ai.answerInstant(undefined), null);
  // 文字列では "…T04:00:00Z" < "…T12:00:00+09:00" だが、瞬間では 04:00Z のほうが新しい
  assert.equal(ai.answerFreshness("2026-11-01T12:00:00+09:00", Date.parse("2026-11-01T04:00:00Z")), "apply");
  // 文字列では "…T11:00:00+09:00" > "…T03:00:00Z" だが、瞬間では 02:00Z で古い
  assert.equal(ai.answerFreshness("2026-11-01T03:00:00Z", Date.parse("2026-11-01T11:00:00+09:00")), "stale");
  assert.equal(ai.answerFreshness("2026-11-01T12:00:00+09:00", Date.parse("2026-11-01T03:00:00Z")), "already");
  assert.equal(ai.answerFreshness(null, 0), "apply");
});

test("aiApply: 時刻の混在。瞬間で新しい答えは入り、古い答えは飛び、同じ瞬間は入れ済み。入れた時刻は UTC", async () => {
  const { ctx } = setup();
  const dir = tmp();
  writeAnswers(dir, "01.json", file("2026-11-01T04:00:00Z", [ans("v1", "not_a_work")]));              // v1 の 12:00+09:00（03:00Z）より新しい
  writeAnswers(dir, "02.json", file("2026-11-01T11:00:00+09:00", [ans("v2", "not_a_work")]));         // v2 の 03:00Z より古い（02:00Z）
  writeAnswers(dir, "03.json", file("2026-11-01T03:00:00.000Z", [ans("v1", "hold", { confidence: "low" })]));  // v1 の前の判定と同じ瞬間（でもこの回で 04:00Z が先に入った → 古い）
  const r = await ai.aiApply(ctx, cfg, dir, deps);
  assert.deepEqual(r.applied, ["v1"]);
  assert.deepEqual(r.stale.sort(), ["v1", "v2"]);
  const row = ctx.db.prepare("SELECT status, decided_at FROM ai_decisions WHERE watch_event_id = 1 AND revoked_at IS NULL").get() as { status: string; decided_at: string };
  assert.deepEqual({ ...row }, { status: "not_a_work", decided_at: "2026-11-01T04:00:00.000Z" });
  // 前の判定は取り消し（行は残る）
  assert.equal((ctx.db.prepare("SELECT COUNT(*) AS n FROM ai_decisions WHERE watch_event_id = 1").get() as { n: number }).n, 2);

  // 前の判定と同じ瞬間（書き方は違う）は「入れ済み」
  const { ctx: c2 } = setup();
  const d2 = tmp();
  writeAnswers(d2, "01.json", file("2026-11-01T03:00:00Z", [ans("v1", "not_a_work")]));
  const r2 = await ai.aiApply(c2, cfg, d2, deps);
  assert.deepEqual(r2.already, ["v1"]);
  assert.equal(r2.applied.length, 0);
});

test("aiApply: 同じ呼び出しでは名前の順。同じ時刻の fix-*.json はあとに入って残る。古い fix は飛ぶ", async () => {
  const { ctx } = setup();
  const dir = tmp();
  writeAnswers(dir, "01.json", file("2026-11-05T00:00:00Z", [ans("v3", "unidentifiable"), ans("v4", "unidentifiable")]));
  writeAnswers(dir, "fix-a.json", file("2026-11-05T09:00:00+09:00", [ans("v3", "not_a_work")]));    // 同じ瞬間（00:00Z）→ 名前の順で後ろなので入る
  writeAnswers(dir, "fix-b.json", file("2026-11-04T00:00:00Z", [ans("v4", "not_a_work")]));         // 01.json より古い → 飛ぶ
  const r = await ai.aiApply(ctx, cfg, dir, deps);
  assert.deepEqual(r.stale, ["v4"]);
  const st = (v: number) => (ctx.db.prepare("SELECT status FROM ai_decisions WHERE watch_event_id = ? AND revoked_at IS NULL").get(v) as { status: string }).status;
  assert.equal(st(3), "not_a_work");
  assert.equal(st(4), "unidentifiable");
});

test("aiApply: 同じファイルを2回入れても判定の集合も行の数も変わらない（2回目は全部入れ済み）", async () => {
  const { ctx } = setup();
  const dir = tmp();
  writeAnswers(dir, "01.json", file("2026-11-06T00:00:00Z", [ans("v3", "identified", { works: [{ key: "annict:1", episodes: [1] }] }), ans("v5", "not_a_work")]));
  writeAnswers(dir, "fix-1.json", file("2026-11-06T01:00:00Z", [ans("v5", "unidentifiable")]));
  await ai.aiApply(ctx, cfg, dir, deps);
  const before = live(ctx);
  const n = rowCount(ctx);
  const r = await ai.aiApply(ctx, cfg, dir, deps);
  assert.equal(r.applied.length, 0);
  assert.deepEqual(r.already.sort(), ["v3", "v5"]);
  assert.deepEqual(r.stale, ["v5"]); // 01.json の v5 は fix-1 より古い
  assert.deepEqual(live(ctx), before);
  assert.equal(rowCount(ctx), n);
});

test("aiApply: ai:revoke で取り消したあと、取り消した答え・それより古い答えはまた入らず、あとに作った答えだけが入る", async () => {
  const { ctx } = setup();
  const dir = tmp();
  writeAnswers(dir, "01.json", file("2026-11-07T00:00:00Z", [ans("v3", "not_a_work"), ans("v4", "not_a_work")]));
  await ai.aiApply(ctx, cfg, dir, deps);
  // 取り消す（行は残る）。v1 は前からある +09:00 の判定を取り消す
  assert.deepEqual(ai.aiRevoke(ctx, { videos: ["v3", "v4", "v1"] }).reresolve.sort(), ["v1", "v3", "v4"]);
  const n = rowCount(ctx);
  // 受け箱に残った同じ答え → 入れ済み。それより古い答え → 古い答え。v1 の取り消した判定（12:00+09:00 = 03:00Z）より古い 02:00Z の答えも入らない
  const again = await ai.aiApply(ctx, cfg, dir, deps);
  assert.deepEqual(again.already.sort(), ["v3", "v4"]);
  assert.equal(again.applied.length, 0);
  const d2 = tmp();
  writeAnswers(d2, "01.json", file("2026-11-06T00:00:00Z", [ans("v3", "unidentifiable")]));
  writeAnswers(d2, "02.json", file("2026-11-01T11:00:00+09:00", [ans("v1", "not_a_work")]));
  const old = await ai.aiApply(ctx, cfg, d2, deps);
  assert.deepEqual(old.stale.sort(), ["v1", "v3"]);
  assert.equal(rowCount(ctx), n);
  assert.equal((ctx.db.prepare("SELECT COUNT(*) AS n FROM ai_decisions WHERE watch_event_id IN (1, 3, 4) AND revoked_at IS NULL").get() as { n: number }).n, 0);
  // 取り消したあとに作った答え（finished_at があと）は入る
  const d3 = tmp();
  writeAnswers(d3, "fix-1.json", file("2026-11-08T00:00:00Z", [ans("v3", "unidentifiable")]));
  writeAnswers(d3, "fix-2.json", file("2026-11-01T04:00:00Z", [ans("v1", "unidentifiable")]));
  const fresh = await ai.aiApply(ctx, cfg, d3, deps);
  assert.deepEqual(fresh.applied.sort(), ["v1", "v3"]);
  const st = (v: number) => (ctx.db.prepare("SELECT status FROM ai_decisions WHERE watch_event_id = ? AND revoked_at IS NULL").get(v) as { status: string } | undefined)?.status;
  assert.equal(st(3), "unidentifiable");
  assert.equal(st(1), "unidentifiable");
  assert.equal(st(4), undefined);
});

test("readAnswerFile: batch・model・finished_at が無い・時刻が読めない・未来・壊れた JSON はファイル単位の問題", () => {
  const dir = tmp();
  const cases: [string, Record<string, unknown> | string, RegExp][] = [
    ["no-finished.json", file(undefined, [ans("v1")]), /finished_at が無い/],
    ["no-batch.json", { model: "m", finished_at: "2026-11-01T00:00:00Z", answers: [] }, /batch が無い/],
    ["no-model.json", { batch: "b", finished_at: "2026-11-01T00:00:00Z", answers: [] }, /model が無い/],
    ["local-time.json", file("2026-11-01T00:00:00", [ans("v1")]), /時刻として読めない/],
    ["future.json", file("2099-01-01T00:00:00Z", [ans("v1")]), /未来/],
    ["broken.json", "{ \"batch\": ", /読めない/],
    ["no-array.json", { batch: "b", model: "m", finished_at: "2026-11-01T00:00:00Z" }, /配列が無い/],
  ];
  for (const [name, body, re] of cases) {
    const r = ai.readAnswerFile(writeAnswers(dir, name, body));
    assert.equal(r.head, null, name);
    assert.equal(r.problems.length, 1, name);
    assert.equal(r.problems[0]!.kind, "file", name);
    assert.match(r.problems[0]!.message, re, name);
  }
});

// ─── 受け箱の取り込み（docs/workflows.md 6-3 の各区分） ───

/** ローカルのフォルダを R2 に見立てて、受け箱に batch を置く */
function inboxWith(batches: Record<string, Record<string, Record<string, unknown> | string>>): { root: string; remote: InstanceType<typeof inbox.LocalRemote> } {
  const root = tmp("remote-");
  for (const [b, files] of Object.entries(batches)) for (const [f, body] of Object.entries(files)) writeAnswers(join(root, "ai", "inbox", b), f, body);
  return { root, remote: new inbox.LocalRemote(root) };
}

const T = "2026-11-10T00:00:00Z";
const SECTIONS = {
  // すべて入った
  "b1-ok": { "01.json": file(T, [ans("v3"), ans("v4", "identified", { works: [{ key: "annict:1" }] })]) },
  // 枠が無い（行が無い・判定から外れた・アーカイブが消えた）と、候補（続きの回）の答え。候補の答えは塊 D3a で枠を作るまで「枠が無い」→ 入れた
  "b2-noevent": { "01.json": file(T, [ans("gone1"), ans("cand1", "not_watchalong"), ans("v5"), ans("vx"), ans("va")]) },
  // 答えの形が不正 → 入れた（結果に書いて人が直す）
  "b3-invalid": { "01.json": file(T, [ans("v6", "unidentifiable", { confidence: "sure" }), ans("v7", "not_a_work", { evidence: { looked: ["title"] } })]) },
  // 外部DBで引けない → やり直し（受け箱に残す）
  "b4-lookup": { "01.json": file(T, [ans("v8", "identified", { works: [{ key: "wikidata:Q999" }] })]) },
  // JSON が壊れている → failed
  "b5-broken": { "01.json": "{ broken" },
  // finished_at が無い → failed（ほかのファイルは入る）
  "b6-nofinished": { "01.json": file(undefined, [ans("v3", "hold", { confidence: "low" })]), "02.json": file(T, [ans("v1", "not_a_work")]) },
};

async function ingest(ctx: Ctx, remote: InstanceType<typeof inbox.LocalRemote>, runId: string, o: { maxBatches?: number; afterBatch?: (b: unknown) => void; d?: ApplyDeps } = {}) {
  const work = tmp("work-");
  const result = join(work, "result.json");
  const r = await inbox.aiIngest({
    remote, work, result, runId, apply: (dir) => ai.aiApply(ctx, cfg, dir, o.d ?? deps), log: () => {},
    ...(o.maxBatches !== undefined ? { maxBatches: o.maxBatches } : {}), ...(o.afterBatch ? { afterBatch: o.afterBatch } : {}),
  });
  return { r, result };
}

test("ai:ingest: 6-3 の区分ごとの結果と移す先。移すのは --settle（DB の書き戻しのあと）、移すのは取り込んだファイルだけ", async () => {
  const { ctx } = setup();
  const { root, remote } = inboxWith({ ...SECTIONS, "b7-later": { "01.json": file(T, [ans("v2", "hold", { confidence: "low" })]) } });
  const { r, result } = await ingest(ctx, remote, "run1");
  const by = Object.fromEntries(r.batches.map((b) => [b.batch, b]));
  // 1回に5つまで。名前の順で古いものから
  assert.deepEqual(r.batches.map((b) => b.batch), ["b1-ok", "b2-noevent", "b3-invalid", "b4-lookup", "b5-broken"]);
  assert.deepEqual(r.deferred, ["b6-nofinished", "b7-later"]);
  assert.equal(by["b1-ok"]!.outcome, "applied");
  assert.equal(by["b1-ok"]!.counts.applied, 2);
  assert.equal(by["b2-noevent"]!.outcome, "applied");
  assert.deepEqual(by["b2-noevent"]!.videos.no_event, ["gone1", "cand1", "vx", "va"]);
  assert.deepEqual(by["b2-noevent"]!.problems.map((p) => p.message), ["枠が無い", "枠が無い", "枠が判定から外れている（excluded_at）", "枠のアーカイブが消えた（archive_gone_at）"]);
  assert.equal(by["b2-noevent"]!.counts.applied, 1);
  assert.equal(by["b3-invalid"]!.outcome, "applied");
  assert.deepEqual(by["b3-invalid"]!.videos.invalid, ["v6", "v7"]);
  assert.equal(by["b4-lookup"]!.outcome, "retry");
  assert.equal(by["b4-lookup"]!.move_to, null);
  assert.deepEqual(by["b4-lookup"]!.videos.lookup, ["v8"]);
  assert.equal(by["b5-broken"]!.outcome, "failed");
  assert.equal(by["b5-broken"]!.move_to, "ai/failed/b5-broken/");
  // 結果の JSON とログには問題の中身を書くが、答えの根拠（rationale）は書かない
  assert.ok(!readFileSync(result, "utf8").includes("\"rationale\""));
  // 「始めた」の印が先に置かれる
  for (const b of r.batches) assert.match(readFileSync(join(root, "ai", "results", b.batch, "run1.json"), "utf8"), /"started"/);
  // --settle の前は受け箱に残っている
  assert.ok(existsSync(join(root, "ai", "inbox", "b1-ok", "01.json")));
  // 取り込みのあとに受け箱に置かれたファイルは移さない
  writeAnswers(join(root, "ai", "inbox", "b1-ok"), "fix-late.json", file(T, [ans("v3", "not_a_work")]));
  await inbox.aiIngestSettle(remote, result, () => {});
  assert.deepEqual(readdirSync(join(root, "ai", "applied", "b1-ok")), ["01.json"]);
  assert.deepEqual(readdirSync(join(root, "ai", "inbox", "b1-ok")), ["fix-late.json"]);
  assert.ok(existsSync(join(root, "ai", "applied", "b2-noevent", "01.json")));
  assert.ok(existsSync(join(root, "ai", "applied", "b3-invalid", "01.json")));
  assert.ok(existsSync(join(root, "ai", "inbox", "b4-lookup", "01.json")));
  assert.ok(existsSync(join(root, "ai", "failed", "b5-broken", "01.json")));
  assert.match(readFileSync(join(root, "ai", "results", "b4-lookup", "run1.json"), "utf8"), /"status": "retry"/);
  assert.match(readFileSync(join(root, "ai", "results", "b1-ok", "run1.json"), "utf8"), /"status": "applied"/);

  // 次の回: 残りの batch。finished_at の無いファイルがある batch は failed（ほかのファイルは入る）
  const { r: r2 } = await ingest(ctx, remote, "run2");
  const b6 = r2.batches.find((b) => b.batch === "b6-nofinished")!;
  assert.equal(b6.outcome, "failed");
  assert.equal(b6.counts.file, 1);
  assert.equal(b6.counts.applied, 1);
  // 外部DBで引けないまま3回目 → failed
  const b4 = r2.batches.find((b) => b.batch === "b4-lookup")!;
  assert.equal(b4.attempt, 2);
  assert.equal(b4.outcome, "retry");
  const { r: r3 } = await ingest(ctx, remote, "run3");
  const b4c = r3.batches.find((b) => b.batch === "b4-lookup")!;
  assert.equal(b4c.attempt, 3);
  assert.equal(b4c.outcome, "failed");
  assert.equal(b4c.move_to, "ai/failed/b4-lookup/");
});

test("ai:ingest: 作品の属性を埋められない・古い答え・入れ済みは「入れた」", async () => {
  const { ctx } = setup();
  const { remote } = inboxWith({
    "c1": { "01.json": file("2026-11-01T03:00:00Z", [ans("v1", "not_a_work"), ans("v2", "not_a_work")]), "02.json": file(T, [ans("v3")]) },
  });
  const { r } = await ingest(ctx, remote, "run1", { d: { ...deps, after: async () => { throw new Error("Annict が落ちている"); } } });
  const b = r.batches[0]!;
  assert.equal(b.outcome, "applied");
  assert.equal(b.counts.enrich, 1);
  // v1（12:00+09:00）と v2（03:00Z）の判定は、01.json の 03:00Z と同じ瞬間 → 入れ済み
  assert.deepEqual(b.videos.already, ["v1", "v2"]);
  assert.equal(b.counts.applied, 1);
  assert.equal(b.counts.stale, 0);
});

test("ai:ingest: 同じ受け箱を2回取り込んでも、判定の集合と行の数が変わらない", async () => {
  const { ctx } = setup();
  const { remote } = inboxWith({
    "d1": {
      "01.json": file("2026-11-08T00:00:00Z", [ans("v3", "identified", { works: [{ key: "annict:1", episodes: [2] }] }), ans("v4"), ans("v5", "not_a_work")]),
      "02.json": file("2026-11-08T00:00:00Z", [ans("v6", "hold", { confidence: "low" }), ans("v1", "not_a_work")]),
      "fix-1.json": file("2026-11-08T00:00:00Z", [ans("v4", "not_a_work")]),
    },
    "d2": { "fix-2.json": file("2026-11-09T00:00:00Z", [ans("v5", "unidentifiable")]), "01.json": file("2026-11-07T00:00:00Z", [ans("v3", "hold", { confidence: "low" })]) },
  });
  await ingest(ctx, remote, "run1");
  const before = live(ctx);
  const n = rowCount(ctx);
  const { r } = await ingest(ctx, remote, "run2");
  assert.deepEqual(live(ctx), before);
  assert.equal(rowCount(ctx), n);
  assert.ok(r.batches.every((b) => b.counts.applied === 0 && b.outcome === "applied"));
  // 中身: v4 は同じ時刻の fix、v5 は新しい batch の fix、v3 は新しい batch の古い答えに上書きされない
  assert.ok(before.some((x) => x.startsWith("v4|not_a_work|")));
  assert.ok(before.some((x) => x.startsWith("v5|unidentifiable|")));
  assert.ok(before.some((x) => x.startsWith("v3|identified|annict:1|")));
});

test("ai:ingest: 途中で殺された回（結果が無い・移していない）は、印が1回に数えられ、次の回で入れ直しても集合は同じ", async () => {
  const batches = {
    "e1": { "01.json": file("2026-11-08T00:00:00Z", [ans("v3", "identified", { works: [{ key: "annict:1" }] }), ans("v4", "not_a_work")]) },
    "e2": { "01.json": file("2026-11-08T00:00:00Z", [ans("v5"), ans("v1", "not_a_work")]) },
  };
  // 比べる相手: 殺されずに1回で入れた DB
  const { ctx: clean } = setup();
  await ingest(clean, inboxWith(batches).remote, "ok");

  const { ctx } = setup();
  const { root, remote } = inboxWith(batches);
  // 1つめの batch を入れた（DB に書いた）直後に殺される
  class Killed extends Error {}
  await assert.rejects(ingest(ctx, remote, "run1", { afterBatch: () => { throw new Killed("killed"); } }), Killed);
  assert.ok(existsSync(join(root, "ai", "results", "e1", "run1.json")));
  assert.ok(!existsSync(join(root, "ai", "results", "e2")));
  // 次の回は2回目として入れ直す。e1 は全部入れ済み
  const { r } = await ingest(ctx, remote, "run2");
  assert.equal(r.batches[0]!.attempt, 2);
  assert.equal(r.batches[0]!.counts.already, 2);
  assert.equal(r.batches[0]!.outcome, "applied");
  assert.equal(r.batches[1]!.attempt, 1);
  assert.deepEqual(live(ctx), live(clean));
  assert.equal(rowCount(ctx), rowCount(clean));
});

test("ai:ingest: 3回とも終わらなかった batch は入れずに failed。落とせないなどの例外はやり直し", async () => {
  const { ctx } = setup();
  const { root, remote } = inboxWith({ "f1": { "01.json": file(T, [ans("v3")]) }, "f2": { "01.json": file(T, [ans("v4")]) } });
  for (const id of ["k1", "k2", "k3"]) writeAnswers(join(root, "ai", "results", "f1"), `${id}.json`, { status: "started" });
  // f2 は落とすところで失敗する
  const flaky = Object.assign(Object.create(Object.getPrototypeOf(remote)), remote, {
    get: async (key: string, dest: string) => { if (key.includes("f2")) throw new Error("network"); return remote.get(key, dest); },
  });
  const work = tmp("work-");
  const r = await inbox.aiIngest({ remote: flaky, work, result: join(work, "r.json"), runId: "run4", apply: (d) => ai.aiApply(ctx, cfg, d, deps), log: () => {} });
  assert.equal(r.batches[0]!.outcome, "failed");
  assert.equal(r.batches[0]!.attempt, 4);
  assert.match(r.batches[0]!.reason, /やり直しが 3 回/);
  assert.equal(r.batches[1]!.outcome, "retry");
  // f1 は入れていない
  assert.equal((ctx.db.prepare("SELECT COUNT(*) AS n FROM ai_decisions WHERE watch_event_id = 3").get() as { n: number }).n, 0);
});

test("ai:ingest: 受け箱が空なら何もしない（結果は空）", async () => {
  const { ctx } = setup();
  const { remote } = inboxWith({});
  const { r, result } = await ingest(ctx, remote, "run1");
  assert.deepEqual(r.batches, []);
  assert.ok(existsSync(result));
});

// ─── ai:check・ai:push・ai:pull ───

/** data/ai/<batch>/ に待ち行列（queue.json）と答えを作る */
function batchDirWith(batch: string, queueVideos: string[], answers: Record<string, Record<string, unknown> | string>): string {
  const dir = join(DATA, "ai", batch);
  mkdirSync(join(dir, "answers"), { recursive: true });
  writeFileSync(join(dir, "queue.json"), JSON.stringify({ batch, items: queueVideos.map((video_id, i) => ({ no: i + 1, video_id })) }), "utf8");
  for (const [name, body] of Object.entries(answers)) {
    if (name.startsWith("fix-")) writeAnswers(dir, name, body);
    else writeAnswers(join(dir, "answers"), name, body);
  }
  return dir;
}

test("ai:check: finished_at の無いファイル・待ち行列の答え漏れ・重複を弾き、そろったファイルは通す", () => {
  batchDirWith("chk-1", ["v1", "v2", "v3"], {
    "01.json": file(T, [ans("v1"), ans("v2"), ans("v3")], "chk-1"),
    "fix-1.json": file(undefined, [ans("v1")], "chk-1"),
  });
  const r = ai.aiCheck("chk-1");
  assert.equal(r.ok, false);
  assert.equal(r.files.find((f) => f.file.endsWith("01.json"))!.ok, true);
  assert.match(r.files.find((f) => f.file.endsWith("fix-1.json"))!.problems.join(), /finished_at が無い/);

  batchDirWith("chk-2", ["v1", "v2", "v3"], { "01.json": file(T, [ans("v1"), ans("v2"), ans("v2"), ans("zz")], "chk-2") });
  const r2 = ai.aiCheck(join(DATA, "ai", "chk-2", "answers", "01.json"));
  assert.equal(r2.ok, false);
  const p = r2.files[0]!.problems.join("\n");
  assert.match(p, /v2: 同じ動画の答えが2つある/);
  assert.match(p, /答えが無い 1 件: v3/);
  assert.match(p, /待ち行列 01 に無い枠の答え 1 件: zz/);

  batchDirWith("chk-3", ["v1"], { "01.json": file(T, [ans("v1", "not_a_work", { evidence: { looked: ["title"] } })], "chk-3") });
  assert.match(ai.aiCheck("chk-3").text, /外部DBを照会していない/);
});

test("ai:push: ai:check に通らなければ何も置かない。通れば ai/inbox/<batch>/ にだけ置く（ローカルのフォルダ）", async () => {
  batchDirWith("push-1", ["v1", "v2"], {
    "01.json": file(T, [ans("v1"), ans("v2")], "push-1"),
    "fix-x.json": file(undefined, [ans("v1")], "push-1"),
  });
  const root = tmp("remote-");
  const remote = new inbox.LocalRemote(root);
  const r = await inbox.aiPush(remote, "push-1");
  assert.equal(r.ok, false);
  assert.deepEqual(r.pushed, []);
  assert.ok(!existsSync(join(root, "ai")));
  // 通ったファイルだけ置く
  const r2 = await inbox.aiPush(remote, "push-1", { skipFailed: true });
  assert.deepEqual(r2.pushed, ["01.json"]);
  assert.deepEqual(r2.skipped, ["fix-x.json"]);
  // 直して置き直す
  writeAnswers(join(DATA, "ai", "push-1"), "fix-x.json", file(T, [ans("v1", "not_a_work")], "push-1"));
  const r3 = await inbox.aiPush(remote, "push-1");
  assert.equal(r3.ok, true);
  assert.deepEqual(readdirSync(join(root, "ai", "inbox", "push-1")), ["01.json", "fix-x.json"]);
  assert.deepEqual(readdirSync(join(root, "ai")), ["inbox"]);
  // 受け箱に置いたものを ai:ingest が取り込める
  const { ctx } = setup();
  const { r: ing } = await ingest(ctx, remote, "run1");
  assert.equal(ing.batches[0]!.outcome, "applied");
  assert.equal(ing.batches[0]!.counts.applied, 3);
});

test("ai:pull: R2（ローカルのフォルダ）の DB を落として検査し写しにする。ai:pull で落としたのでない DB は上書きしない", async () => {
  // R2 に置く DB を db:pack で作る（docs/workflows.md 2-4 と同じ形）
  const src = tmp("pull-src-");
  const { ctx: c0, path } = setup();
  c0.db.close(); // WAL を本体に書き戻してから写す
  copyFileSync(path, join(src, "db.sqlite"));
  const p = await dbPack({ db: join(src, "db.sqlite"), initial: true, out: join(src, "out"), runId: "r1", writer: "daily" });
  assert.ok(p.ok, p.lines.join("\n"));
  const root = tmp("remote-");
  mkdirSync(join(root, "db"), { recursive: true });
  copyFileSync(join(src, "out", "db.sqlite.gz"), join(root, "db", "db.sqlite.gz"));
  copyFileSync(join(src, "out", "meta.json"), join(root, "db", "db.sqlite.gz.meta.json"));
  const remote = new inbox.LocalRemote(root);

  const local = tmp("pull-dst-");
  // ローカルの正の DB（.pulled.json が無い）は上書きしない
  writeFileSync(join(local, "db.sqlite"), "local truth");
  const refused = await inbox.aiPull(remote, join(local, "db.sqlite"), () => {});
  assert.equal(refused.ok, false);
  assert.equal(readFileSync(join(local, "db.sqlite"), "utf8"), "local truth");

  const dst = join(tmp("pull-dst-"), "db.sqlite");
  const r = await inbox.aiPull(remote, dst, () => {});
  assert.ok(r.ok, r.lines.join("\n"));
  assert.ok(existsSync(`${dst}.pulled.json`));
  const db = openDb(dst);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM watch_events").get() as { n: number }).n, VIDEOS.length + 2);
  db.close();
  // 2回目（前の写しを置き換える）
  const r2 = await inbox.aiPull(remote, dst, () => {});
  assert.ok(r2.ok);
  // sha256 が合わない DB は置き換えない
  const bad = JSON.parse(readFileSync(join(root, "db", "db.sqlite.gz.meta.json"), "utf8"));
  writeFileSync(join(root, "db", "db.sqlite.gz.meta.json"), JSON.stringify({ ...bad, sha256: "0".repeat(64) }));
  const r3 = await inbox.aiPull(remote, dst, () => {});
  assert.equal(r3.ok, false);
  assert.match(r3.lines.join("\n"), /sha256 が合わない/);
  // R2 に DB が無い
  const r4 = await inbox.aiPull(new inbox.LocalRemote(tmp("empty-")), join(tmp("x-"), "db.sqlite"), () => {});
  assert.equal(r4.ok, false);
});

// ─── AWS CLI の層（組み立てるコマンドまで。実際の往復は段6） ───

test("AwsRemote: 組み立てる aws のコマンド。鍵は環境変数で渡し、引数に出さない", async () => {
  const calls: { args: string[]; env: Record<string, string> }[] = [];
  const outs: { code: number; stdout: string; stderr: string }[] = [];
  const run = (args: string[], env: Record<string, string>) => { calls.push({ args, env }); return outs.shift() ?? { code: 0, stdout: "", stderr: "" }; };
  const env = { R2_ACCESS_KEY_ID: "AKID", R2_SECRET_ACCESS_KEY: "SECRET", CLOUDFLARE_ACCOUNT_ID: "acct", R2_BUCKET: "bkt" };
  const r = inbox.openRemote("r2", env, run);
  const E = ["--endpoint-url", "https://acct.r2.cloudflarestorage.com", "--region", "auto"];

  outs.push({ code: 0, stdout: "                           PRE ai-20261101/\n                           PRE ai-20261108/\n2026-11-09 05:00:00        123 stray.json\n", stderr: "" });
  assert.deepEqual(await r.list("ai/inbox/"), { dirs: ["ai-20261101", "ai-20261108"], files: ["stray.json"] });
  assert.deepEqual(calls[0]!.args, ["s3", "ls", "s3://bkt/ai/inbox/", ...E]);
  assert.deepEqual(calls[0]!.env, { AWS_ACCESS_KEY_ID: "AKID", AWS_SECRET_ACCESS_KEY: "SECRET", AWS_DEFAULT_REGION: "auto" });
  // 何も無い prefix は終了コード 1・出力なし
  outs.push({ code: 1, stdout: "", stderr: "" });
  assert.deepEqual(await r.list("ai/results/x/"), { dirs: [], files: [] });

  await r.get("ai/inbox/b/01.json", join(tmp(), "01.json"));
  assert.deepEqual(calls.at(-1)!.args.slice(0, 3), ["s3", "cp", "s3://bkt/ai/inbox/b/01.json"]);
  assert.deepEqual(calls.at(-1)!.args.slice(4), ["--only-show-errors", ...E]);
  await r.put("local.json", "ai/inbox/b/01.json");
  assert.deepEqual(calls.at(-1)!.args, ["s3", "cp", "local.json", "s3://bkt/ai/inbox/b/01.json", "--only-show-errors", ...E]);
  await r.move("ai/inbox/b/01.json", "ai/applied/b/01.json");
  assert.deepEqual(calls.at(-1)!.args, ["s3", "mv", "s3://bkt/ai/inbox/b/01.json", "s3://bkt/ai/applied/b/01.json", "--only-show-errors", ...E]);
  await r.putText("ai/results/b/run1.json", "{}");
  assert.equal(calls.at(-1)!.args[3], "s3://bkt/ai/results/b/run1.json");

  outs.push({ code: 0, stdout: JSON.stringify({ ContentLength: 5, Metadata: { sha256: "ab", "user-version": "11" } }), stderr: "" });
  assert.deepEqual(await r.head("db/db.sqlite.gz"), { sha256: "ab", "user-version": "11" });
  assert.deepEqual(calls.at(-1)!.args, ["s3api", "head-object", "--bucket", "bkt", "--key", "db/db.sqlite.gz", ...E]);
  outs.push({ code: 254, stdout: "", stderr: "An error occurred (404) when calling the HeadObject operation: Not Found" });
  assert.equal(await r.head("db/db.sqlite.gz"), null);
  outs.push({ code: 255, stdout: "", stderr: "Could not connect" });
  await assert.rejects(r.get("ai/inbox/b/01.json", join(tmp(), "x.json")), /終了コード 255/);

  // 鍵はどの引数にも出ない
  assert.ok(calls.every((c) => !c.args.join(" ").includes("SECRET") && !c.args.join(" ").includes("AKID")));
  // キーに .. を入れない
  await assert.rejects(r.put("x", "ai/inbox/../db/db.sqlite.gz"), /キーが不正/);
  // 設定が無ければ使わない
  assert.throws(() => inbox.openRemote("r2", { R2_BUCKET: "b" }, run), /R2_ACCESS_KEY_ID・R2_SECRET_ACCESS_KEY・CLOUDFLARE_ACCOUNT_ID/);
  assert.ok(inbox.openRemote(tmp(), {}, run) instanceof inbox.LocalRemote);
});

test("parseS3Ls: PRE と日付つきの行", () => {
  assert.deepEqual(inbox.parseS3Ls("                           PRE b2/\r\n                           PRE b1/\r\n2026-11-09 05:00:00          0 a b.json\r\n"),
    { dirs: ["b1", "b2"], files: ["a b.json"] });
});

// ─── ai:queue（同じシードの2回目・クォータ） ───

test("ai:queue: 同じシードの2回目は前の batch を使い、答えのそろったファイルを飛ばす。別のシードは断る", async () => {
  const batch = "q-reuse";
  const dir = join(DATA, "ai", batch);
  const vids = Array.from({ length: 120 }, (_, i) => `q${i}`);
  mkdirSync(join(dir, "sealed"), { recursive: true });
  writeFileSync(join(dir, "sealed", "answers.json"), JSON.stringify({ batch, seed: batch, population: 700, answers: vids.map((video_id) => ({ video_id })) }));
  batchDirWith(batch, vids, {
    "01.json": file(T, vids.slice(0, 50).map((v) => ans(v)), batch),                // そろっている
    "02.json": file(T, vids.slice(50, 99).map((v) => ans(v)), batch),               // 1件足りない
  });
  const ctx = {} as unknown as Ctx; // 前の待ち行列を使うときは DB も YouTube も使わない
  const r = await ai.aiQueueRoutes(ctx, cfg, { batch, seed: batch, maxFiles: 10 });
  assert.equal(r.reused, true);
  assert.deepEqual(r.files.map((f) => f.split("/").pop()), ["02.md", "03.md"]);
  assert.equal(r.remaining, 580);
  assert.equal(r.units, 0);
  assert.equal(r.quotaStopped, false);
  // finished_at の無い答えは「そろった」にしない
  writeAnswers(join(dir, "answers"), "01.json", file(undefined, vids.slice(0, 50).map((v) => ans(v)), batch));
  assert.equal((await ai.aiQueueRoutes(ctx, cfg, { batch, seed: batch })).files.length, 3);
  await assert.rejects(ai.aiQueueRoutes(ctx, cfg, { batch, seed: "other" }), /別のシード/);
});

test("ai:queue: --max-files は 1〜10", async () => {
  const ctx = {} as unknown as Ctx;
  await assert.rejects(ai.aiQueueRoutes(ctx, cfg, { batch: "q-max", seed: "q-max", maxFiles: 11 }), /1〜10/);
  await assert.rejects(ai.aiQueueRoutes(ctx, cfg, { batch: "q-max", seed: "q-max", maxFiles: 0 }), /1〜10/);
});

test("ローカルの AI の取り分: 太平洋時間の日ごとにファイルへ足す。Quota.limitRun で止まり exhausted が立つ", () => {
  const f = join(tmp(), "quota.json");
  assert.deepEqual(ai.readAiQuota(f), { days: {} });
  ai.addAiQuota(f, "2026-11-12", "a", 120);
  ai.addAiQuota(f, "2026-11-12", "b", 30);
  ai.addAiQuota(f, "2026-11-13", "c", 5);
  const q = ai.readAiQuota(f);
  assert.equal(q.days["2026-11-12"]!.units, 150);
  assert.equal(q.days["2026-11-12"]!.runs.length, 2);
  assert.equal(q.days["2026-11-13"]!.units, 5);
  // 壊れたファイルは空として読む（取り分を数え直す）
  writeFileSync(f, "{");
  assert.deepEqual(ai.readAiQuota(f), { days: {} });
  // 14日より古い日は消す
  for (let d = 1; d <= 16; d++) ai.addAiQuota(f, `2026-10-${String(d).padStart(2, "0")}`, "x", 1);
  assert.equal(Object.keys(ai.readAiQuota(f).days).length, 14);
  assert.ok(!("2026-10-01" in ai.readAiQuota(f).days));

  const { ctx } = setup();
  const quota = new Quota(ctx.db, loadCrawlConfig().quota, "r", "report");
  quota.limitRun(2);
  quota.reserve("commentThreads.list"); quota.record("commentThreads.list");
  quota.reserve("commentThreads.list"); quota.record("commentThreads.list");
  assert.equal(quota.exhausted, false);
  assert.throws(() => quota.reserve("commentThreads.list"), QuotaExhausted);
  assert.equal(quota.exhausted, true);
  // 上げることはしない
  quota.limitRun(100);
  assert.throws(() => quota.reserve("commentThreads.list"), QuotaExhausted);
  const q0 = new Quota(ctx.db, loadCrawlConfig().quota, "r", "report");
  q0.limitRun(0);
  assert.throws(() => q0.reserve("videos.list"), QuotaExhausted);
});

