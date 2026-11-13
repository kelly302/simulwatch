// 塊 D3a の後半: 続きの回の候補を待ち行列に混ぜ、答えで枠を作る・同時視聴ではないを候補の表に持つ・取り消す（D-04。docs/ai-ops.md 3-3・3-4）
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// batch のフォルダ（data/ai/<batch>/）と quota.json は DATA_DIR の下。モジュールを読む前に決める
const DATA = mkdtempSync(join(tmpdir(), "cand-ai-data-"));
process.env.DATA_DIR = DATA;

const { openDb } = await import("../src/lib/db.ts");
const { Quota } = await import("../src/lib/quota.ts");
const { loadCrawlConfig, loadDetectConfig } = await import("../src/lib/config.ts");
const { loadExtractConfig } = await import("../src/resolve/config.ts");
const { publishState } = await import("../src/resolve/route.ts");
const { rerunDetect } = await import("../src/report/reports.ts");
const ai = await import("../src/report/ai.ts");
type Ctx = import("../src/lib/context.ts").Ctx;
type DB = import("../src/lib/db.ts").DB;
type WorkCandidate = import("../src/resolve/types.ts").WorkCandidate;
type ApplyDeps = import("../src/report/ai.ts").ApplyDeps;

const cfg = loadExtractConfig();
const crawlCfg = loadCrawlConfig();
const detectCfg = loadDetectConfig();
let seq = 0;

/**
 * 小さな DB。配信者1人・種の枠（語の枠 seed1。2026-10-01）と、AI に回す型でない語の枠 r1。候補:
 *   c1 メン限・終わった（ready）/ c2 公開・ready / c3 ready で、語彙の変更で外れた行（detect_rule）がある / c4 詳細がまだ（selected）/ c5 hold / c6 ready
 */
function setup(): Ctx {
  const db = openDb(join(mkdtempSync(join(tmpdir(), "cand-ai-db-")), "db.sqlite"));
  db.exec(`INSERT INTO streamers (id, name, affiliation, channel_id, tier, first_seen_at, updated_at) VALUES (1, 'テスト配信者', 'nijisanji', 'UCa', 1, 'n', 'n');
    INSERT INTO watch_events (id, streamer_id, video_id, title_raw, url, status, started_at, is_members_only, detected_at, detect_source, detect_keyword, found_via, updated_at) VALUES
      (1, 1, 'seed1', '【同時視聴】ARCANE 第1話', 'u', 'completed', '2026-10-01T12:00:00Z', 1, 'n', 'title', '同時視聴', 'rss', 'n'),
      (2, 1, 'r1', '【同時視聴】映画A', 'u', 'completed', '2026-10-05T12:00:00Z', 0, 'n', 'title', '同時視聴', 'rss', 'n'),
      (3, 1, 'c3', '【同時視聴会】ARCANE 第3話', 'u', 'completed', '2026-10-03T12:00:00Z', 0, 'n', 'title', '視聴会', 'rss', 'n');
    UPDATE watch_events SET excluded_at = 'n', excluded_reason = 'detect_rule:v0' WHERE id = 3;`);
  const seen = db.prepare(`INSERT INTO videos_seen (video_id, channel_id, title, published_at, first_seen_at, first_seen_via, last_seen_at, detect_result, detect_version, is_members_hint)
    VALUES (?, 'UCa', ?, ?, 'n', 'members_playlist', 'n', 'miss', 'v', ?)`);
  const cand = db.prepare(`INSERT INTO candidates (video_id, streamer_id, state, state_at, reasons, seeds, selected_at, last_selected_at,
      title_raw, description_raw, thumbnail_url, started_at, started_at_source, ended_at, status, is_members_only, view_count, fetched_at)
    VALUES (?, 1, ?, 'n', '["same_work_members","continuation_word"]', '[{"reason":"same_work_members","seed":1,"key":"arcane"}]', 'n', 'n',
      ?, '概要欄', NULL, ?, 'actual_start', ?, ?, ?, NULL, ?)`);
  const add = (id: string, state: string, title: string, at: string, members: number, detail = true) => {
    seen.run(id, title, at, members);
    cand.run(id, state, detail ? title : null, detail ? at : null, detail ? at : null, detail ? "completed" : null, members, detail ? "2026-11-13T00:00:00Z" : null);
  };
  add("c1", "ready", "ARCANE PART 2", "2026-10-02T12:00:00Z", 1);
  add("c2", "ready", "ARCANE 感想と続き", "2026-10-02T15:00:00Z", 0);
  add("c3", "ready", "ARCANE 第3話", "2026-10-03T12:00:00Z", 0);
  add("c4", "selected", "ARCANE PART 4", "2026-10-04T12:00:00Z", 1, false);
  add("c5", "hold", "ARCANE PART 5", "2026-10-06T12:00:00Z", 1);
  add("c6", "ready", "ARCANE 最終回", "2026-10-07T12:00:00Z", 1);
  const quota = new Quota(db, crawlCfg.quota, `r${++seq}`, "report");
  return { db, crawlCfg, detectCfg, quota, yt: null, http: null, summary: {}, errors: [], runId: "r", job: "report" } as unknown as Ctx;
}

const WORK: WorkCandidate = {
  source: "annict", sourceKey: "annict:1", annictId: 1, anilistId: null, wikidataId: null, malId: null, title: "ARCANE", titleKana: null, titles: [],
  media: "tv", seasonName: null, releaseYear: 2021, episodesCount: 9, imageUrl: null, seriesId: null,
} as WorkCandidate;
const deps: ApplyDeps = {
  fetchWorks: async (_c, _x, keys) => new Map(keys.filter((k) => k === "annict:1").map((k) => [k, WORK])),
  after: async () => {},
};

function ans(video_id: string, status: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    video_id, status, confidence: "high", evidence: { looked: ["title", "lookup"], queries: ["q"] }, rationale: "r",
    ...(status === "identified" ? { works: [{ key: "annict:1", episodes: [2] }] } : {}), ...extra,
  };
}

function answerFile(finished_at: string, answers: Record<string, unknown>[], name = "01.json", batch = "cand-b"): string {
  const dir = join(DATA, "answers-in", String(++seq));
  mkdirSync(dir, { recursive: true });
  const p = join(dir, name);
  writeFileSync(p, JSON.stringify({ batch, model: "test-model", finished_at, answers }), "utf8");
  return p;
}

const ev = (db: DB, v: string) => db.prepare("SELECT * FROM watch_events WHERE video_id = ?").get(v) as Record<string, unknown> | undefined;
const cand = (db: DB, v: string) => db.prepare("SELECT * FROM candidates WHERE video_id = ?").get(v) as Record<string, unknown>;
const liveDecision = (db: DB, v: string) => db.prepare(`SELECT a.* FROM ai_decisions a JOIN watch_events e ON e.id = a.watch_event_id
  WHERE e.video_id = ? AND a.revoked_at IS NULL`).get(v) as Record<string, unknown> | undefined;

/** 今の出し方（publishState。型は記録していないので AI の判定だけで決まる） */
function stateOf(db: DB, v: string): string {
  const e = ev(db, v);
  if (!e || e.excluded_at) return "not_listed";
  const a = liveDecision(db, v);
  return publishState({ type: null, sub: null, ai: a ? { status: String(a.status), confidence: String(a.confidence) } : null, hasWorks: false, unresolvedReason: null }, cfg.ai_routes ?? []);
}

test("ai:queue: 候補（ready）を混ぜ、候補であることと種の枠を見せ、層は見せない。hold は --include-hold のときだけ。詳細の無い候補・一覧に出る枠のある候補は入れない", async () => {
  const ctx = setup();
  const r = await ai.aiQueueRoutes(ctx, cfg, { batch: "cq1", seed: "s", candidatesOnly: true });
  const dir = join(DATA, "ai", "cq1");
  const q = JSON.parse(readFileSync(join(dir, "queue.json"), "utf8")) as { items: { video_id: string; candidate?: { seeds: { date: string; title: string }[] }; other_same_name: { title: string }[] }[] };
  assert.deepEqual(q.items.map((x) => x.video_id).sort(), ["c1", "c2", "c3", "c6"]);
  assert.equal(r.remaining, 0);
  for (const x of q.items) {
    assert.deepEqual(x.candidate?.seeds, [{ date: "2026-10-01", title: "【同時視聴】ARCANE 第1話" }]);
    // 枠にならなかった動画（同じ作品名の動画）に自分は出ない
    assert.ok(!x.other_same_name.some((o) => o.title === ctx.db.prepare("SELECT title_raw FROM candidates WHERE video_id = ?").get(x.video_id)!.title_raw));
  }
  const md = readFileSync(join(dir, "queue", "01.md"), "utf8");
  assert.match(md, /- 候補: 題名に同時視聴の語が無い動画。まず同時視聴の枠かどうかを判断する（同時視聴でなければ status は not_watchalong）/);
  assert.match(md, /- 候補にした同時視聴の枠: 2026-10-01 【同時視聴】ARCANE 第1話/);
  assert.ok(!/same_work_members|continuation_word|same_title_body/.test(md), "層は見せない");
  assert.ok(!/same_work_members/.test(readFileSync(join(dir, "queue.json"), "utf8")), "queue.json にも層は書かない");
  // 層は sealed/ にだけ残す
  const sealed = JSON.parse(readFileSync(join(dir, "sealed", "answers.json"), "utf8")) as { answers: { video_id: string; candidate?: { reasons: string[] } }[] };
  assert.deepEqual(sealed.answers.find((a) => a.video_id === "c1")?.candidate?.reasons, ["same_work_members", "continuation_word"]);
  // 前後の枠: 候補の日付の位置に入れて選ぶ（seed1 と r1）
  const plan = readFileSync(join(dir, "plan.md"), "utf8");
  assert.match(plan, /続きの回の候補（candidates の ready）。4 本/);

  const r2 = await ai.aiQueueRoutes(ctx, cfg, { batch: "cq2", seed: "s", candidatesOnly: true, includeHold: true });
  assert.ok(r2.text.includes("5 件"), r2.text);
  // 動画を指定: 状態に関係なく（詳細のある候補だけ）
  const r3 = await ai.aiQueueRoutes(ctx, cfg, { batch: "cq3", seed: "s", candidatesOnly: true, videos: ["c5", "c4"] });
  assert.ok(r3.text.includes("1 件"), r3.text);
  // --type を付けると候補は入れない
  const r4 = await ai.aiQueueRoutes(ctx, cfg, { batch: "cq4", seed: "s", routes: ["no_such_route"] });
  assert.match(r4.text, /判定する枠が無い/);
});

test("ai:apply: 同時視聴と答えた候補は枠（ai_candidate）を作ってから判定を入れる。is_members_only は候補の表の値。not_watchalong・hold は候補の表に持つ", async () => {
  const ctx = setup();
  const T = "2026-11-01T10:00:00Z";
  const r = await ai.aiApply(ctx, cfg, answerFile(T, [
    ans("c1", "identified"), ans("c2", "not_watchalong"), ans("c3", "unidentifiable"), ans("c4", "identified"), ans("c5", "hold"),
    ans("c6", "not_a_work"), ans("r1", "not_watchalong"), ans("zz", "not_watchalong"),
  ]), deps);
  assert.deepEqual(r.candidates, { framed: ["c1", "c3", "c6"], notWatchalong: ["c2"], hold: ["c5"] });
  assert.deepEqual(r.applied, ["c1", "c2", "c3", "c5", "c6"]);
  assert.deepEqual(r.problems.map((p) => `${p.kind}:${p.video_id}`).sort(), ["invalid:r1", "no_event:c4", "no_event:zz"]);
  assert.match(r.problems.find((p) => p.video_id === "c4")!.message, /候補から枠を作れない: 候補の詳細/);

  const db = ctx.db;
  // c1: 新しく作った枠。メン限
  const e1 = ev(db, "c1")!;
  assert.equal(e1.detect_source, "ai_candidate");
  assert.equal(e1.detect_keyword, "same_work_members+continuation_word");
  assert.equal(e1.is_members_only, 1);
  assert.equal(e1.excluded_at, null);
  assert.equal(liveDecision(db, "c1")!.status, "identified");
  assert.equal(liveDecision(db, "c1")!.decided_at, "2026-11-01T10:00:00.000Z");
  assert.equal(cand(db, "c1").state, "framed");
  assert.equal(cand(db, "c1").watch_event_id, e1.id);
  assert.equal(stateOf(db, "c1"), "work");
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM event_works WHERE watch_event_id = ?").get(Number(e1.id)) as { n: number }).n, 1);
  // c2: 枠は作らない。答えは候補の表
  assert.equal(ev(db, "c2"), undefined);
  const c2 = cand(db, "c2");
  assert.equal(c2.state, "not_watchalong");
  assert.equal(c2.answer_status, "not_watchalong");
  assert.equal(c2.answer_batch, "cand-b");
  assert.equal(c2.answered_at, "2026-11-01T10:00:00.000Z");
  assert.equal(JSON.parse(String(c2.answer_detail)).confidence, "high");
  // c3: 語彙の変更で外れていた行を ai_candidate の枠として戻す（行は1つ）
  const e3 = ev(db, "c3")!;
  assert.equal(e3.id, 3);
  assert.equal(e3.detect_source, "ai_candidate");
  assert.equal(e3.excluded_at, null);
  assert.equal(stateOf(db, "c3"), "frame");
  // c5: 保留は候補のまま
  assert.equal(ev(db, "c5"), undefined);
  assert.equal(cand(db, "c5").state, "hold");
  // c6: 作品ではない → 枠は作るがサイトには出ない
  assert.equal(stateOf(db, "c6"), "hidden");
  // 公開の候補（c2 以外の公開の候補は無い）→ c3 は候補の表で公開
  assert.equal(e3.is_members_only, 0);
  // 語の枠 r1 には not_watchalong は入らない
  assert.equal(liveDecision(db, "r1"), undefined);

  // 同じファイルを2回入れても変わらない
  const before = JSON.stringify([db.prepare("SELECT * FROM candidates ORDER BY id").all(), db.prepare("SELECT id, status, decided_at, revoked_at FROM ai_decisions ORDER BY id").all()]);
  const again = await ai.aiApply(ctx, cfg, r.files[0]!, deps);
  assert.deepEqual(again.applied, []);
  assert.deepEqual(again.already.sort(), ["c1", "c2", "c3", "c5", "c6"]);
  assert.equal(JSON.stringify([db.prepare("SELECT * FROM candidates ORDER BY id").all(), db.prepare("SELECT id, status, decided_at, revoked_at FROM ai_decisions ORDER BY id").all()]), before);

  // detect:rerun で外れない
  rerunDetect(db, detectCfg);
  for (const v of ["c1", "c3", "c6"]) assert.equal(ev(db, v)!.excluded_at, null, v);
});

test("古い答えの決まり: 候補の答えの時刻（not_watchalong・hold）と枠の判定の時刻（取り消した判定も含む）の大きいほうより古い答えは入れない", async () => {
  const ctx = setup();
  const db = ctx.db;
  await ai.aiApply(ctx, cfg, answerFile("2026-11-01T10:00:00Z", [ans("c1", "identified"), ans("c2", "not_watchalong")]), deps);
  // 古い答え: c1 を not_watchalong・c2 を identified にしようとしても入らない（時差の違う書き方でも瞬間で比べる）
  const old = await ai.aiApply(ctx, cfg, answerFile("2026-11-01T18:59:00+09:00", [ans("c1", "not_watchalong"), ans("c2", "identified")]), deps);
  assert.deepEqual(old.stale.sort(), ["c1", "c2"]);
  assert.equal(stateOf(db, "c1"), "work");
  assert.equal(ev(db, "c2"), undefined);
  // 直しの答え（新しい）: c1 は同時視聴ではない → 判定を取り消し、枠を外し（ai_revoked。行は残す）、候補の表に答え。c2 は同時視聴 → 枠を作る
  const fix = await ai.aiApply(ctx, cfg, answerFile("2026-11-02T10:00:00Z", [ans("c1", "not_watchalong"), ans("c2", "identified")], "fix-1.json"), deps);
  assert.deepEqual(fix.candidates, { framed: ["c2"], notWatchalong: ["c1"], hold: [] });
  const e1 = ev(db, "c1")!;
  assert.equal(e1.excluded_reason, "ai_revoked");
  assert.equal(liveDecision(db, "c1"), undefined);
  assert.equal(cand(db, "c1").state, "not_watchalong");
  assert.equal(stateOf(db, "c1"), "not_listed");
  assert.equal(stateOf(db, "c2"), "work");
  assert.equal(cand(db, "c2").state, "framed");
  // 取り消した判定（10:00Z の identified）を入れ直しても入らない
  const replay = await ai.aiApply(ctx, cfg, answerFile("2026-11-01T10:00:00Z", [ans("c1", "identified")]), deps);
  assert.deepEqual(replay.stale, ["c1"]);
  // もっと新しい identified なら同じ行を戻す
  const back = await ai.aiApply(ctx, cfg, answerFile("2026-11-03T10:00:00Z", [ans("c1", "identified")]), deps);
  assert.deepEqual(back.candidates.framed, ["c1"]);
  assert.equal(ev(db, "c1")!.id, e1.id);
  assert.equal(ev(db, "c1")!.excluded_at, null);
  assert.equal(stateOf(db, "c1"), "work");
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM watch_events WHERE video_id = 'c1'").get() as { n: number }).n, 1);
});

test("ai:revoke: AI が足した枠は外し（ai_revoked）候補を ready に戻す。候補の表の答えも取り消す。ルールの枠は名寄せし直しに返す。取り消した答えはもう入らない", async () => {
  const ctx = setup();
  const db = ctx.db;
  db.exec(`INSERT INTO ai_decisions (watch_event_id, status, confidence, evidence, rationale, model, batch, decided_at)
    VALUES (2, 'unidentifiable', 'high', '{"looked":["title"]}', 'r', 'm', 'cand-b', '2026-10-31T00:00:00Z')`);
  await ai.aiApply(ctx, cfg, answerFile("2026-11-01T10:00:00Z", [ans("c1", "identified"), ans("c2", "not_watchalong"), ans("c6", "hold")]), deps);
  const r = ai.aiRevoke(ctx, { batch: "cand-b" });
  assert.deepEqual(r.reresolve, ["r1"]);
  assert.deepEqual(r.candidateFrames, ["c1"]);
  assert.deepEqual(r.candidateAnswers.sort(), ["c2", "c6"]);
  assert.equal(ev(db, "c1")!.excluded_reason, "ai_revoked");
  assert.equal(stateOf(db, "c1"), "not_listed");
  for (const v of ["c1", "c2", "c6"]) assert.equal(cand(db, v).state, "ready", v);
  assert.ok(cand(db, "c2").answer_revoked_at);
  assert.equal(cand(db, "c2").answered_at, "2026-11-01T10:00:00.000Z");
  // 待ち行列に戻る
  const q = await ai.aiQueueRoutes(ctx, cfg, { batch: "rv1", seed: "s", candidatesOnly: true });
  assert.ok(q.text.includes("4 件"), q.text);
  // 取り消した答え（同じ時刻）・それより古い答えは入らない。新しい答えは入る
  const replay = await ai.aiApply(ctx, cfg, answerFile("2026-11-01T10:00:00Z", [ans("c1", "identified"), ans("c2", "not_watchalong")]), deps);
  assert.deepEqual(replay.applied, []);
  assert.deepEqual([...replay.already, ...replay.stale].sort(), ["c1", "c2"]);
  const fresh = await ai.aiApply(ctx, cfg, answerFile("2026-11-04T10:00:00Z", [ans("c2", "not_watchalong")]), deps);
  assert.deepEqual(fresh.candidates.notWatchalong, ["c2"]);
  assert.equal(cand(db, "c2").answer_revoked_at, null);
  // 動画を指定しての取り消し
  const r2 = ai.aiRevoke(ctx, { videos: ["c2"] });
  assert.deepEqual(r2.candidateAnswers, ["c2"]);
});

test("ai:check: not_watchalong は待ち行列で候補にした動画だけ（枠の答えに書くと外れる）", async () => {
  const ctx = setup();
  ctx.db.exec("UPDATE watch_events SET excluded_at = NULL, excluded_reason = NULL WHERE id = 3");
  // 候補（c1・c2・c6）と、枠（c3 はルールの枠として待ち行列に入らないので、queue.json を直接足す）
  await ai.aiQueueRoutes(ctx, cfg, { batch: "chk1", seed: "s", candidatesOnly: true });
  const dir = join(DATA, "ai", "chk1");
  const qj = JSON.parse(readFileSync(join(dir, "queue.json"), "utf8")) as { items: { video_id: string }[] };
  const vids = qj.items.map((x) => x.video_id);
  assert.ok(existsSync(join(dir, "queue", "01.md")));
  writeFileSync(join(dir, "answers", "01.json"), JSON.stringify({ batch: "chk1", model: "m", finished_at: "2026-11-01T00:00:00Z", answers: vids.map((v) => ans(v, "not_watchalong")) }), "utf8");
  assert.equal(ai.aiCheck(join(dir, "answers")).ok, true);
  // 枠の動画を待ち行列に足して not_watchalong と答える → 外れる
  qj.items.push({ video_id: "seed1" });
  writeFileSync(join(dir, "queue.json"), JSON.stringify(qj), "utf8");
  writeFileSync(join(dir, "queue", "01.md"), readFileSync(join(dir, "queue", "01.md"), "utf8") + "\n## 99. seed1　テスト配信者　2026-10-01 21:00\n", "utf8");
  writeFileSync(join(dir, "answers", "01.json"), JSON.stringify({ batch: "chk1", model: "m", finished_at: "2026-11-01T00:00:00Z", answers: [...vids, "seed1"].map((v) => ans(v, "not_watchalong")) }), "utf8");
  const c = ai.aiCheck(join(dir, "answers"));
  assert.equal(c.ok, false);
  assert.match(c.text, /seed1: not_watchalong は続きの回の候補の動画だけ/);
  // not_watchalong に works は書かない
  writeFileSync(join(dir, "answers", "01.json"), JSON.stringify({ batch: "chk1", model: "m", finished_at: "2026-11-01T00:00:00Z", answers: vids.map((v) => ans(v, "not_watchalong", { works: [{ key: "annict:1" }] })) }), "utf8");
  assert.match(ai.aiCheck(join(dir, "answers")).text, /not_watchalong（同時視聴ではない）に works・title は書かない/);
});

test("ai:report: 候補の表の答え（not_watchalong・枠の無い hold）も採点の表に出す。あとで枠を作った候補の前の答えは取り消し済み", async () => {
  const ctx = setup();
  await ai.aiApply(ctx, cfg, answerFile("2026-11-01T10:00:00Z", [ans("c1", "identified"), ans("c2", "not_watchalong"), ans("c5", "hold", { confidence: "low" })], "01.json", "rep-b"), deps);
  const text = ai.aiReport(ctx, "rep-b", { includeHigh: true });
  assert.match(text, /3 件/);
  const dir = join(DATA, "ai", "rep-b");
  const md = readFileSync(join(dir, "report.md"), "utf8");
  assert.match(md, /## \d+\. c2　テスト配信者[^\n]*\n[\s\S]*?- 判定: \*\*同時視聴ではない\*\*（確度 high）/);
  assert.match(md, /件数（取り消していないもの）: 同定 1・同時視聴ではない 1・保留 1/);
  const html = readFileSync(join(dir, "report.html"), "utf8");
  for (const v of ["c1", "c2", "c5"]) assert.ok(html.includes(`"id":"${v}"`), v);
  assert.match(html, /同時視聴の配信なのに/);
  // 確度 high の not_watchalong は、--include-high が無ければ抜き取りに回る（確度 high 以外・保留は出す）
  ai.aiReport(ctx, "rep-b", {});
  const html2 = readFileSync(join(dir, "report.html"), "utf8");
  assert.ok(!html2.includes('"id":"c2"') && html2.includes('"id":"c5"'));
  // あとの回で c2 に枠を作ると、前の回の not_watchalong は取り消し済み（採点の表に出さない）
  await ai.aiApply(ctx, cfg, answerFile("2026-11-02T10:00:00Z", [ans("c2", "identified")], "01.json", "rep-c"), deps);
  ai.aiReport(ctx, "rep-b", { includeHigh: true });
  assert.match(readFileSync(join(dir, "report.md"), "utf8"), /c2　テスト配信者[^\n]*（取り消し済み）/);
  assert.ok(!readFileSync(join(dir, "report.html"), "utf8").includes('"id":"c2"'));
});

test("ai:queue: 弱い語だけの候補（種の枠が無い）は「候補にした同時視聴の枠: なし」", async () => {
  const ctx = setup();
  ctx.db.prepare(`UPDATE candidates SET reasons = '["weak_word"]', seeds = '[{"reason":"weak_word","word":"一緒に観る"}]' WHERE video_id = 'c6'`).run();
  await ai.aiQueueRoutes(ctx, cfg, { batch: "cq-weak", seed: "s", candidatesOnly: true, videos: ["c6"] });
  const md = readFileSync(join(DATA, "ai", "cq-weak", "queue", "01.md"), "utf8");
  assert.match(md, /- 候補にした同時視聴の枠: なし/);
  assert.ok(!/weak_word|一緒に観る」/.test(md));
  const guide = readFileSync(join(DATA, "ai", "cq-weak", "GUIDE.md"), "utf8");
  assert.match(guide, /## 続きの回の候補/);
  assert.match(guide, /- not_watchalong: 同時視聴ではない。\*\*候補の動画だけ\*\*/);
});

test("ai:queue: 待ち行列に「メン限」と「配信の長さ」の行を出す（候補・枠とも）", async () => {
  const blind = await import("../src/report/blind.ts");
  // 長さの書き方
  assert.equal(blind.streamLength({ started_at: "2026-10-01T12:00:00Z", started_at_source: "actual_start", ended_at: "2026-10-01T14:05:30Z" }), "2時間6分（実開始〜実終了）");
  assert.equal(blind.streamLength({ started_at: "2026-10-01T12:00:00Z", started_at_source: "published_at", ended_at: null }), "ライブ配信ではない（投稿した動画）");
  assert.equal(blind.streamLength({ started_at: "2026-10-01T12:00:00Z", started_at_source: "actual_start", ended_at: null }), "分からない");
  assert.equal(blind.streamLength({ started_at: "2026-10-01T12:00:00Z" }), "分からない");
  // 候補（c6 はメン限・2時間5分）
  const ctx = setup();
  ctx.db.prepare(`UPDATE candidates SET ended_at = '2026-10-07T14:05:00Z' WHERE video_id = 'c6'`).run();
  ctx.db.prepare(`UPDATE candidates SET started_at_source = 'published_at', ended_at = NULL WHERE video_id = 'c2'`).run();
  await ai.aiQueueRoutes(ctx, cfg, { batch: "cq-len", seed: "s", candidatesOnly: true, videos: ["c6", "c2"] });
  const md = readFileSync(join(DATA, "ai", "cq-len", "queue", "01.md"), "utf8");
  assert.match(md, /## \d+\. c6[^\n]*\n- タイトル: ARCANE 最終回\n- メン限: はい\n- 配信の長さ: 2時間5分（実開始〜実終了）\n/);
  assert.match(md, /## \d+\. c2[^\n]*\n- タイトル: [^\n]*\n- メン限: いいえ\n- 配信の長さ: ライブ配信ではない（投稿した動画）\n/);
  const guide = readFileSync(join(DATA, "ai", "cq-len", "GUIDE.md"), "utf8");
  assert.match(guide, /- 配信の長さ・メン限:/);
  assert.match(guide, /\*\*長さだけで作品・期・話数を決めない\*\*/);
  assert.match(guide, /\*\*長さだけでは同時視聴にしない\*\*/);
  // 枠（ルールの答えのある行）も同じ行を出す
  const dir = join(DATA, "ai", "cq-len-frame");
  const ev = { id: 2, video_id: "r1", title_raw: "【同時視聴】映画A", description_raw: null, started_at: "2026-10-05T12:00:00Z", streamer_id: 1,
    thumbnail_url: null, streamer: "テスト配信者", is_members_only: 0, started_at_source: "actual_start", ended_at: "2026-10-05T13:59:00Z" };
  await blind.writeBlindQueue(ctx, dir, { batch: "cq-len-frame", seed: "s", rows: [{ ev, rule: { video_id: "r1" } as never }], sealedNote: "t" });
  assert.match(readFileSync(join(dir, "queue", "01.md"), "utf8"), /- タイトル: 【同時視聴】映画A\n- メン限: いいえ\n- 配信の長さ: 1時間59分（実開始〜実終了）\n/);
});
