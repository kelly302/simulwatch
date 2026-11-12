import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, schemaVersion } from "../src/lib/db.ts";
import type { DB } from "../src/lib/db.ts";
import { countKeepTables } from "../src/lib/dbfile.ts";
import { loadDetectConfig } from "../src/lib/config.ts";
import type { VideoItem } from "../src/youtube/api.ts";
import type { Ctx } from "../src/lib/context.ts";
import { saveCandidates, fetchCandidates } from "../src/candidates/store.ts";
import { frameFromCandidate, revokeCandidateFrames } from "../src/candidates/frames.ts";
import type { Candidate } from "../src/candidates/select.ts";
import { rerunDetect } from "../src/report/reports.ts";
import { judgeCandidates, fetchAndUpsert, emptyStats, emptyUpsertStats } from "../src/crawl/ingest.ts";

// 続きの回の候補の表（マイグレーション 12）・保存・詳細の取得・枠を作る・外す（docs/ai-ops.md 3章。決定 D-04）

const detectCfg = loadDetectConfig();
const T0 = "2026-11-13T00:00:00.000Z";

function setup(): DB {
  const db = openDb(":memory:");
  db.exec(`INSERT INTO streamers (id, name, affiliation, channel_id, tier, first_seen_at, updated_at) VALUES (1, 's', 'nijisanji', 'UCx', 1, 'n', 'n');`);
  // 種の枠（語彙で当たった枠）
  db.exec(`INSERT INTO watch_events (id, streamer_id, video_id, title_raw, url, status, detected_at, detect_source, detect_keyword, found_via, updated_at)
    VALUES (1, 1, 'seed1', '【同時視聴】ARCANE 第1話', 'u', 'completed', 'n', 'title', '同時視聴', 'rss', 'n')`);
  return db;
}

function seen(db: DB, id: string, title: string, membersHint = 0): void {
  db.prepare(`INSERT INTO videos_seen (video_id, channel_id, title, published_at, first_seen_at, first_seen_via, last_seen_at, detect_result, detect_version, is_members_hint)
    VALUES (?, 'UCx', ?, '2026-11-01T12:00:00Z', 'n', 'members_playlist', 'n', 'miss', ?, ?)`).run(id, title, detectCfg.version, membersHint);
}

const cand = (videoId: string, members = true): Candidate => ({
  videoId, streamerId: 1, streamer: "s", title: "ARCANE PART 2", date: "2026-11-01", members,
  reasons: ["same_work_members", "continuation_word"],
  hits: [{ reason: "same_work_members", seed: 1, key: "arcane" }, { reason: "continuation_word", seed: 1, key: "arcane" }],
});

function item(id: string, o: { title?: string; lbc?: "none" | "upcoming" | "live"; privacy?: "public" | "private"; live?: boolean; views?: string } = {}): VideoItem {
  return {
    id,
    snippet: { publishedAt: "2026-11-01T11:00:00Z", channelId: "UCx", title: o.title ?? "ARCANE PART 2", description: "概要欄", liveBroadcastContent: o.lbc ?? "none",
      thumbnails: { high: { url: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`, width: 480, height: 360 } } },
    ...(o.live === false ? {} : { liveStreamingDetails: o.lbc === "upcoming" ? { scheduledStartTime: "2026-11-20T12:00:00Z" }
      : { actualStartTime: "2026-11-01T12:00:00Z", ...(o.lbc === "live" ? {} : { actualEndTime: "2026-11-01T14:00:00Z" }), scheduledStartTime: "2026-11-01T12:00:00Z" } }),
    ...(o.views === undefined ? {} : { statistics: { viewCount: o.views } }),
    status: { privacyStatus: o.privacy ?? "public" },
  };
}

/** videos.list の代わり。呼ばれた ID を覚える */
function fakeYt(byId: Record<string, VideoItem>) {
  const calls: string[][] = [];
  return { calls, yt: { videos: async (ids: string[]) => { calls.push(ids); return ids.flatMap((id) => (byId[id] ? [byId[id]!] : [])); } } };
}

const row = (db: DB, id: string) => db.prepare("SELECT * FROM candidates WHERE video_id = ?").get(id) as Record<string, unknown>;
const ev = (db: DB, id: string) => db.prepare("SELECT * FROM watch_events WHERE video_id = ?").get(id) as Record<string, unknown> | undefined;

test("マイグレーション 12: candidates の表ができ、行を消さない表として数える", () => {
  const db = setup();
  assert.equal(schemaVersion(), 12);
  assert.equal((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 12);
  saveCandidates(db, [cand("v1")], T0);
  assert.equal(countKeepTables(db).candidates, 1);
  // 状態と詳細の status は決めた値だけ
  assert.throws(() => db.prepare("UPDATE candidates SET state = 'deleted'").run());
  assert.throws(() => db.prepare("UPDATE candidates SET status = 'done'").run());
});

test("candidates:select の保存: 同じ動画は1回だけ。答える前は理由と種の枠を新しくし、答えたあとは最後に選んだ時刻だけ。語で枠になった候補は判定に回さない", () => {
  const db = setup();
  let s = saveCandidates(db, [cand("v1", false), cand("v2"), cand("v3")], T0);
  assert.deepEqual(s, { selected: 3, inserted: 3, updated: 0, touched: 0, detected: 0 });
  const r = row(db, "v1");
  assert.equal(r.state, "selected");
  assert.equal(r.selected_at, T0);
  assert.deepEqual(JSON.parse(String(r.reasons)), ["same_work_members", "continuation_word"]);
  assert.equal(JSON.parse(String(r.seeds))[0].seed, 1);
  assert.equal(r.is_members_only, 0);
  assert.equal(row(db, "v2").is_members_only, 1);

  db.prepare("UPDATE candidates SET state = 'not_watchalong', answered_at = ? WHERE video_id = 'v2'").run(T0);
  // v3 は題名が変わって巡回が語で枠にした
  db.exec(`INSERT INTO watch_events (streamer_id, video_id, title_raw, url, status, detected_at, detect_source, detect_keyword, found_via, updated_at)
    VALUES (1, 'v3', '【同時視聴】ARCANE PART 2', 'u', 'completed', 'n', 'title', '同時視聴', 'rss', 'n')`);
  const later = "2026-11-14T00:00:00.000Z";
  const c1 = { ...cand("v1", true), reasons: ["same_work_members" as const], hits: [{ reason: "same_work_members" as const, seed: 1, key: "arcane" }] };
  s = saveCandidates(db, [c1, cand("v2"), cand("v3")], later);
  assert.deepEqual(s, { selected: 3, inserted: 0, updated: 2, touched: 1, detected: 1 });
  assert.deepEqual(JSON.parse(String(row(db, "v1").reasons)), ["same_work_members"]);
  assert.equal(row(db, "v1").selected_at, T0);
  assert.equal(row(db, "v1").last_selected_at, later);
  assert.equal(row(db, "v1").is_members_only, 1);
  assert.equal(row(db, "v2").state, "not_watchalong");
  assert.equal(row(db, "v2").last_selected_at, later);
  assert.equal(row(db, "v3").state, "detected");
  assert.equal(row(db, "v3").watch_event_id, ev(db, "v3")!.id);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM candidates").get() as { n: number }).n, 3);
});

test("candidates:fetch: 終わった動画は ready、予定・配信中は waiting（次の日に取り直す）、取れない動画は unavailable。メン限の印は表の値・videos_seen・題名", async () => {
  const db = setup();
  for (const id of ["done", "up", "live", "priv", "gone", "upload", "memtitle"]) seen(db, id, "t", id === "done" ? 1 : 0);
  saveCandidates(db, ["done", "up", "live", "priv", "gone", "upload", "memtitle"].map((id) => cand(id, false)), T0);
  const f = fakeYt({
    done: item("done", { views: "1234" }), up: item("up", { lbc: "upcoming" }), live: item("live", { lbc: "live" }), priv: item("priv", { privacy: "private" }),
    upload: item("upload", { live: false, views: "10" }), memtitle: item("memtitle", { title: "【メン限】ARCANE PART 3" }),
  });
  const s = await fetchCandidates({ db, yt: f.yt, detectCfg });
  assert.deepEqual(s, { targets: 7, requested: 7, ready: 3, waiting: 2, unavailable: 1, missing: 1 });
  const d = row(db, "done");
  assert.equal(d.state, "ready");
  assert.equal(d.status, "completed");
  assert.equal(d.title_raw, "ARCANE PART 2");
  assert.equal(d.description_raw, "概要欄");
  assert.equal(d.started_at, "2026-11-01T12:00:00Z");
  assert.equal(d.started_at_source, "actual_start");
  assert.equal(d.ended_at, "2026-11-01T14:00:00Z");
  assert.equal(d.view_count, 1234);
  assert.ok(d.view_count_fetched_at && d.fetched_at);
  assert.equal(d.is_members_only, 1); // videos_seen の is_members_hint
  assert.equal(row(db, "up").state, "waiting");
  assert.equal(row(db, "up").status, "upcoming");
  assert.equal(row(db, "live").state, "waiting");
  assert.equal(row(db, "priv").state, "unavailable");
  assert.equal(row(db, "priv").fetch_note, "privacy:private");
  assert.equal(row(db, "gone").state, "unavailable");
  assert.equal(row(db, "gone").fetch_note, "missing_in_videos_list");
  assert.equal(row(db, "upload").state, "ready"); // ライブでない投稿は公開日時で代用（require_live: false）
  assert.equal(row(db, "upload").started_at_source, "published_at");
  assert.equal(row(db, "memtitle").is_members_only, 1); // 題名のメン限の語
  assert.equal(row(db, "upload").is_members_only, 0);

  // 次の日: waiting だけを引き直す（ready・unavailable は引かない）
  const g = fakeYt({ up: item("up"), live: item("live", { lbc: "live" }) });
  const s2 = await fetchCandidates({ db, yt: g.yt, detectCfg });
  assert.deepEqual(g.calls, [["up", "live"]]);
  assert.equal(s2.ready, 1);
  assert.equal(row(db, "up").state, "ready");
  assert.equal(row(db, "up").ended_at, "2026-11-01T14:00:00Z");
  assert.equal(row(db, "live").state, "waiting");

  // API キーが無ければ何も変えない
  const before = JSON.stringify(db.prepare("SELECT * FROM candidates ORDER BY id").all());
  assert.equal((await fetchCandidates({ db, yt: null, detectCfg })).requested, 0);
  assert.equal(JSON.stringify(db.prepare("SELECT * FROM candidates ORDER BY id").all()), before);
});

test("candidates:fetch: 50本ごとに書くので、途中で止まっても取れたぶんは残る", async () => {
  const db = setup();
  const ids = Array.from({ length: 60 }, (_, i) => `x${String(i).padStart(2, "0")}`);
  saveCandidates(db, ids.map((id) => cand(id)), T0);
  let n = 0;
  const yt = { videos: async (part: string[]) => {
    if (n++ > 0) throw new Error("quota");
    return part.map((id) => item(id));
  } };
  await assert.rejects(fetchCandidates({ db, yt, detectCfg }), /quota/);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM candidates WHERE state = 'ready'").get() as { n: number }).n, 50);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM candidates WHERE state = 'selected'").get() as { n: number }).n, 10);
});

async function readyCandidate(db: DB, id: string, o: { members?: boolean; hint?: number; title?: string } = {}): Promise<void> {
  seen(db, id, "t", o.hint ?? 0);
  saveCandidates(db, [cand(id, o.members ?? false)], T0);
  await fetchCandidates({ db, yt: fakeYt({ [id]: item(id, { title: o.title ?? "ARCANE PART 2", views: "5" }) }).yt, detectCfg });
}

test("枠を作る: 候補の表の詳細を写し、detect_source = ai_candidate・detect_keyword に候補の理由。is_members_only は候補の表の値", async () => {
  const db = setup();
  await readyCandidate(db, "m1", { members: true });
  // 候補の表ではメン限だが、videos_seen の印は落ちている（候補の表の値を使う）
  db.prepare("UPDATE videos_seen SET is_members_hint = 0 WHERE video_id = 'm1'").run();
  const r = frameFromCandidate(db, "m1", T0);
  assert.ok(r.ok);
  assert.equal(r.how, "created");
  const e = ev(db, "m1")!;
  assert.equal(e.id, r.eventId);
  assert.equal(e.detect_source, "ai_candidate");
  assert.equal(e.detect_keyword, "same_work_members+continuation_word");
  assert.equal(e.is_members_only, 1);
  assert.equal(e.title_raw, "ARCANE PART 2");
  assert.equal(e.description_raw, "概要欄");
  assert.equal(e.status, "completed");
  assert.equal(e.started_at, "2026-11-01T12:00:00Z");
  assert.equal(e.view_count, 5);
  assert.equal(e.found_via, "members_playlist");
  assert.equal(e.excluded_at, null);
  assert.equal(e.url, "https://www.youtube.com/watch?v=m1");
  assert.equal(row(db, "m1").state, "framed");
  assert.equal(row(db, "m1").watch_event_id, r.eventId);
  // 判定を枠に結びつけられる（watch_event_id は NOT NULL）
  db.prepare(`INSERT INTO ai_decisions (watch_event_id, status, confidence, evidence, rationale, model, batch, decided_at)
    VALUES (?, 'identified', 'high', '{}', 'r', 'm', 'b', ?)`).run(r.eventId, T0);
  // 2回目は同じ枠（作り直さない）
  const again = frameFromCandidate(db, "m1", T0);
  assert.ok(again.ok);
  assert.equal(again.how, "existing");
  assert.equal(again.eventId, r.eventId);
  assert.equal(row(db, "m1").state, "framed");

  // 公開の動画（印が無い）は公開の枠
  await readyCandidate(db, "p1", { members: false });
  const p = frameFromCandidate(db, "p1", T0);
  assert.ok(p.ok);
  assert.equal(ev(db, "p1")!.is_members_only, 0);
  // 候補の表では公開だが videos_seen の印が後から立った（メン限プレイリストで見つけた）→ メン限
  await readyCandidate(db, "p2", { members: false });
  db.prepare("UPDATE videos_seen SET is_members_hint = 1 WHERE video_id = 'p2'").run();
  assert.ok(frameFromCandidate(db, "p2", T0).ok);
  assert.equal(ev(db, "p2")!.is_members_only, 1);
});

test("枠を作る: 詳細が無い・終わっていない・候補に無い動画は作らない（DB は変えない）", async () => {
  const db = setup();
  saveCandidates(db, [cand("s1"), cand("w1")], T0);
  await fetchCandidates({ db, yt: fakeYt({ s1: item("s1", { privacy: "private" }), w1: item("w1", { lbc: "upcoming" }) }).yt, detectCfg });
  db.prepare("INSERT INTO candidates (video_id, streamer_id, state, state_at, reasons, seeds, selected_at, last_selected_at) VALUES ('n1', 1, 'selected', ?, '[]', '[]', ?, ?)").run(T0, T0, T0);
  for (const [id, why] of [["s1", /詳細/], ["w1", /終わっていない/], ["n1", /詳細/], ["zz", /候補に無い/]] as const) {
    const r = frameFromCandidate(db, id, T0);
    assert.equal(r.ok, false);
    assert.match((r as { why: string }).why, why);
    assert.equal(ev(db, id), undefined);
  }
});

test("枠を作る: 語彙の変更で外れていた行は ai_candidate として戻す。一覧に出る語の枠があればそのまま（detected）", async () => {
  const db = setup();
  await readyCandidate(db, "ex1");
  db.exec(`INSERT INTO watch_events (streamer_id, video_id, title_raw, url, status, is_members_only, detected_at, detect_source, detect_keyword, found_via, excluded_at, excluded_reason, updated_at)
    VALUES (1, 'ex1', '旧題', 'u', 'completed', 0, 'n', 'title', '視聴会', 'rss', 'n', 'detect_rule:v1', 'n')`);
  db.prepare("UPDATE candidates SET is_members_only = 1 WHERE video_id = 'ex1'").run();
  const r = frameFromCandidate(db, "ex1", T0);
  assert.ok(r.ok);
  assert.equal(r.how, "adopted");
  const e = ev(db, "ex1")!;
  assert.equal(e.detect_source, "ai_candidate");
  assert.equal(e.excluded_at, null);
  assert.equal(e.excluded_reason, null);
  assert.equal(e.is_members_only, 1);
  assert.equal(row(db, "ex1").state, "framed");

  await readyCandidate(db, "rule1");
  db.exec(`INSERT INTO watch_events (streamer_id, video_id, title_raw, url, status, detected_at, detect_source, detect_keyword, found_via, updated_at)
    VALUES (1, 'rule1', '【同時視聴】ARCANE', 'u', 'completed', 'n', 'title', '同時視聴', 'rss', 'n')`);
  const x = frameFromCandidate(db, "rule1", T0);
  assert.ok(x.ok);
  assert.equal(x.how, "existing");
  assert.equal(ev(db, "rule1")!.detect_source, "title");
  assert.equal(row(db, "rule1").state, "detected");
});

test("外す: AI が足した枠は excluded_reason = ai_revoked（行は残す）、候補は ready に戻る。答えでもう一度作ると同じ行を戻す。語の枠は変えずに返す", async () => {
  const db = setup();
  await readyCandidate(db, "a1", { members: true });
  const r = frameFromCandidate(db, "a1", T0);
  assert.ok(r.ok);
  const out = revokeCandidateFrames(db, [r.eventId, 1], "2026-11-15T00:00:00.000Z");
  assert.deepEqual(out, { revoked: [r.eventId], others: [1] });
  const e = ev(db, "a1")!;
  assert.equal(e.excluded_at, "2026-11-15T00:00:00.000Z");
  assert.equal(e.excluded_reason, "ai_revoked");
  assert.equal(row(db, "a1").state, "ready");
  assert.equal(ev(db, "seed1")!.excluded_at, null);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM watch_events WHERE video_id = 'a1'").get() as { n: number }).n, 1);
  const back = frameFromCandidate(db, "a1", T0);
  assert.ok(back.ok);
  assert.equal(back.how, "restored");
  assert.equal(back.eventId, r.eventId);
  assert.equal(ev(db, "a1")!.excluded_at, null);
  assert.equal(row(db, "a1").state, "framed");
});

test("detect:rerun は ai_candidate の枠を語彙で外さない（語の枠は今までどおり外す）。取り消しで外した枠も戻さない", async () => {
  const db = setup();
  await readyCandidate(db, "a1");
  assert.ok(frameFromCandidate(db, "a1", T0).ok);
  await readyCandidate(db, "a2");
  const r2 = frameFromCandidate(db, "a2", T0);
  assert.ok(r2.ok);
  revokeCandidateFrames(db, [r2.eventId], T0);
  db.exec(`INSERT INTO watch_events (streamer_id, video_id, title_raw, url, status, detected_at, detect_source, detect_keyword, found_via, updated_at)
    VALUES (1, 'nohit', 'ゲーム実況 PART 2', 'u', 'completed', 'n', 'title', '同時視聴', 'rss', 'n')`);
  const s = rerunDetect(db, detectCfg);
  assert.equal(s.events_excluded, 1);
  assert.equal(ev(db, "nohit")!.excluded_reason, `detect_rule:${detectCfg.version}`);
  assert.equal(ev(db, "a1")!.excluded_at, null);
  assert.equal(ev(db, "a1")!.detect_source, "ai_candidate");
  assert.equal(ev(db, "a2")!.excluded_reason, "ai_revoked");
  assert.equal(ev(db, "seed1")!.excluded_at, null);
});

test("巡回（judgeCandidates → fetchAndUpsert）: 題名の変わった ai_candidate の枠を語彙で判定し直さない", async () => {
  const db = setup();
  await readyCandidate(db, "a1", { members: true });
  assert.ok(frameFromCandidate(db, "a1", T0).ok);
  const f = fakeYt({ a1: item("a1", { title: "ARCANE PART 2（後半）" }) });
  const ctx = { db, detectCfg, yt: f.yt } as unknown as Ctx;
  const pending = judgeCandidates(ctx, [{ videoId: "a1", channelId: "UCx", title: "ARCANE PART 2（後半）", description: null, publishedAt: null, via: "playlist" }], emptyStats());
  assert.equal(pending.size, 1);
  const up = emptyUpsertStats();
  await fetchAndUpsert(ctx, pending, up);
  assert.equal(up.rejected_by_current_rule, 0);
  assert.equal(up.events_updated, 1);
  const e = ev(db, "a1")!;
  assert.equal(e.title_raw, "ARCANE PART 2（後半）");
  assert.equal(e.detect_source, "ai_candidate");
  assert.equal(e.excluded_at, null);
  assert.equal(e.is_members_only, 1);
  // 同じ動画が判定の未処理（hit）として来ても（orphan の経路）、行がある枠は判定し直さない
  const p2 = new Map([["a1", { videoId: "a1", via: "playlist" as const, source: "title" as const, keyword: "同時視聴", membersHint: false }]]);
  const up2 = emptyUpsertStats();
  await fetchAndUpsert(ctx, p2, up2);
  assert.equal(up2.rejected_by_current_rule, 0);
  assert.equal(ev(db, "a1")!.detect_source, "ai_candidate");
});
