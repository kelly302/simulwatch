import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/lib/db.ts";
import type { DB } from "../src/lib/db.ts";
import { loadCrawlConfig, loadDetectConfig } from "../src/lib/config.ts";
import type { Ctx } from "../src/lib/context.ts";
import type { VideoItem, ChannelItem } from "../src/youtube/api.ts";
import { QuotaExhausted } from "../src/lib/quota.ts";
import { refreshSeen, seenTarget, actCutoff } from "../src/retention/seen.ts";
import { clearCandidates, purgeGoneEvents } from "../src/retention/purge.ts";
import { retentionStatus } from "../src/retention/status.ts";
import { listDataFiles, deleteEntries } from "../src/retention/files.ts";
import { descriptionHitLines, detect, templateLines } from "../src/detect/detect.ts";
import { judgeCandidates, emptyStats } from "../src/crawl/ingest.ts";
import { refreshEvents } from "../src/crawl/refresh.ts";
import { refreshChannelMeta } from "../src/roster/sync.ts";
import { rerunDetect } from "../src/report/reports.ts";
import { streamerFrames, streamerVideos } from "../src/report/neighbors.ts";
import { saveCandidates, fetchCandidates, candidateQueueRows } from "../src/candidates/store.ts";
import type { Candidate } from "../src/candidates/select.ts";
import { activeEventSql, farFutureCutoff } from "../src/lib/events.ts";
import { loadExtractConfig } from "../src/resolve/config.ts";

// 30日の決まり（YouTube の API の規約 III.E.4。決定 D-12。src/retention/）

const detectCfg = loadDetectConfig();
const crawlCfg = loadCrawlConfig();
const NOW = new Date("2026-11-13T12:00:00.000Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();

function setup(): DB {
  const db = openDb(":memory:");
  db.exec(`INSERT INTO streamers (id, name, affiliation, channel_id, tier, first_seen_at, updated_at) VALUES (1, 's', 'nijisanji', 'UCx', 1, 'n', 'n');`);
  return db;
}

function seen(db: DB, id: string, o: { title?: string; refreshed?: string; channel?: string; result?: string } = {}): void {
  db.prepare(`INSERT INTO videos_seen (video_id, channel_id, title, published_at, first_seen_at, first_seen_via, last_seen_at, detect_result, detect_version, is_members_hint, refreshed_at)
    VALUES (?, ?, ?, '2026-09-01T12:00:00Z', 'n', 'playlist', ?, ?, ?, 0, ?)`)
    .run(id, o.channel ?? "UCx", o.title ?? `雑談 ${id}`, o.refreshed ?? daysAgo(40), o.result ?? "miss", detectCfg.version, o.refreshed ?? daysAgo(40));
}

function event(db: DB, id: string, o: { gone?: string; title?: string } = {}): number {
  const r = db.prepare(`INSERT INTO watch_events (streamer_id, video_id, title_raw, description_raw, thumbnail_url, url, started_at, status, view_count, view_count_fetched_at,
      detected_at, detect_source, detect_keyword, found_via, archive_gone_at, updated_at)
    VALUES (1, ?, ?, '今日はARCANEを同時視聴', 'https://i.ytimg.com/x.jpg', 'u', '2026-09-01T12:00:00Z', 'completed', 1234, 'n', 'n', 'title', '同時視聴', 'playlist', ?, 'n')`)
    .run(id, o.title ?? `【同時視聴】ARCANE ${id}`, o.gone ?? null);
  return Number(r.lastInsertRowid);
}

function item(id: string, o: { title?: string; description?: string; privacy?: "public" | "private" | "unlisted"; channel?: string; views?: string } = {}): VideoItem {
  return {
    id,
    snippet: { publishedAt: "2026-09-01T11:00:00Z", channelId: o.channel ?? "UCx", title: o.title ?? `雑談 ${id}`, description: o.description ?? "",
      liveBroadcastContent: "none", thumbnails: { medium: { url: `https://i.ytimg.com/vi/${id}/mqdefault.jpg` } } },
    liveStreamingDetails: { actualStartTime: "2026-09-01T12:00:00Z", actualEndTime: "2026-09-01T14:00:00Z" },
    statistics: { viewCount: o.views ?? "100" },
    status: { privacyStatus: o.privacy ?? "public" },
  };
}

function fakeYt(byId: Record<string, VideoItem>, o: { failAfter?: number; error?: Error } = {}) {
  const calls: string[][] = [];
  return {
    calls,
    yt: {
      videos: async (ids: string[]) => {
        if (o.failAfter !== undefined && calls.length >= o.failAfter) throw o.error ?? new QuotaExhausted("daily stop");
        calls.push(ids);
        return ids.flatMap((id) => (byId[id] ? [byId[id]!] : []));
      },
    },
  };
}

const vs = (db: DB, id: string) => db.prepare("SELECT * FROM videos_seen WHERE video_id = ?").get(id) as Record<string, string | number | null>;
const we = (db: DB, id: string) => db.prepare("SELECT * FROM watch_events WHERE video_id = ?").get(id) as Record<string, string | number | null>;

test("マイグレーション 13: 30日の決まりの列ができる", () => {
  const db = setup();
  const cols = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
  assert.ok(cols("videos_seen").includes("refreshed_at") && cols("videos_seen").includes("gone_at"));
  assert.ok(cols("watch_events").includes("purged_at"));
  assert.ok(cols("candidates").includes("cleared_at"));
  assert.ok(cols("streamers").includes("channel_meta_at"));
});

test("取り直す本数: 題名を持つ行 ÷ act_after_days と、境目を過ぎた行の多いほう。上限（ユニット×50）とクォータの残りで切る", () => {
  const db = setup();
  for (let i = 0; i < 100; i++) seen(db, `n${i}`, { refreshed: daysAgo(1) });
  const cfg = { ...crawlCfg, retention: { ...crawlCfg.retention, act_after_days: 25 } };
  assert.deepEqual(seenTarget(db, cfg, NOW, 100), { live: 100, due: 0, target: 4 }); // ceil(100 / 25)
  for (let i = 0; i < 30; i++) seen(db, `o${i}`, { refreshed: daysAgo(26) });
  assert.deepEqual(seenTarget(db, cfg, NOW, 100), { live: 130, due: 30, target: 30 });
  assert.equal(seenTarget(db, cfg, NOW, 0).target, 0);
  // 題名を消した行は数えない
  db.exec("UPDATE videos_seen SET gone_at = 'x', title = '' WHERE video_id LIKE 'o%'");
  assert.deepEqual(seenTarget(db, cfg, NOW, 100), { live: 100, due: 0, target: 4 });
});

test("videos_seen の取り直し: 古いものから。同じ題名は確かめた時刻だけ、題名が変わったら判定し直す、枠の動画は題名だけ、返らない・公開でない動画は題名と公開日を消す", async () => {
  const db = setup();
  seen(db, "same", { refreshed: daysAgo(40) });
  seen(db, "renamed", { refreshed: daysAgo(39) });
  seen(db, "renamed_miss", { refreshed: daysAgo(38) });
  seen(db, "ev", { refreshed: daysAgo(37), title: "【同時視聴】ARCANE ev", result: "hit" });
  event(db, "ev");
  seen(db, "deleted", { refreshed: daysAgo(36) });
  seen(db, "private", { refreshed: daysAgo(35) });
  seen(db, "fresh", { refreshed: daysAgo(1) });
  const f = fakeYt({
    same: item("same"),
    renamed: item("renamed", { title: "【同時視聴】ARCANE 第2話" }),
    renamed_miss: item("renamed_miss", { title: "雑談 改題" }),
    ev: item("ev", { title: "【同時視聴】ARCANE ev（改題）" }),
    private: item("private", { privacy: "private" }),
    fresh: item("fresh"),
  });
  const s = await refreshSeen({ db, yt: f.yt, detectCfg, crawlCfg }, { now: NOW, maxUnits: 10 });
  // 境目（25日）を過ぎた6本（題名を持つ7行 ÷ 25 = 1 より多い）。新しい1本は取らない
  assert.equal(s.due_rows, 6);
  assert.equal(s.target_rows, 6);
  assert.deepEqual(f.calls, [["same", "renamed", "renamed_miss", "ev", "deleted", "private"]]);
  assert.equal(s.refreshed, 4); // 公開でない動画は返ってきても確かめたに数えない（題名を消す）
  assert.equal(s.gone, 2);
  assert.equal(s.title_changed, 3);
  assert.deepEqual(s.redetected, { hit: 1, miss: 1, rejected: 0 });
  assert.equal(s.error, null);

  assert.equal(vs(db, "same").title, "雑談 same");
  assert.ok(String(vs(db, "same").refreshed_at) > daysAgo(1));
  assert.equal(vs(db, "renamed").title, "【同時視聴】ARCANE 第2話");
  assert.equal(vs(db, "renamed").detect_result, "hit");
  assert.equal(vs(db, "renamed").detect_note, "title:同時視聴");
  assert.equal(vs(db, "renamed_miss").detect_result, "miss");
  assert.equal(vs(db, "ev").title, "【同時視聴】ARCANE ev（改題）"); // 枠の動画は題名だけ（判定し直さない）
  assert.equal(vs(db, "ev").detect_result, "hit");
  for (const id of ["deleted", "private"]) {
    assert.equal(vs(db, id).title, "");
    assert.equal(vs(db, id).published_at, null);
    assert.ok(vs(db, id).gone_at);
    assert.equal(vs(db, id).detect_result, "miss"); // 判定の結果は残す
  }
  // 消した行はもう取らない
  const g = fakeYt({});
  await refreshSeen({ db, yt: g.yt, detectCfg, crawlCfg }, { now: NOW, maxUnits: 10 });
  assert.ok(!g.calls.flat().includes("deleted"));
});

test("videos_seen の取り直し: 並びは確かめた日の古い順、同じ日の中は動画の ID の順（同じ時刻に続けて見た1つのチャンネルの動画が固まらない）", async () => {
  const db = setup();
  const base = Date.parse("2026-09-23T12:00:00.000Z");
  // 同じ日に、チャンネル A の動画を先に・B の動画をあとに見た（時刻の順なら A が全部先に来る）
  ["za", "ya", "xa"].forEach((id, i) => seen(db, id, { channel: "UCa", refreshed: new Date(base + i * 1000).toISOString() }));
  ["ab", "bb", "cb"].forEach((id, i) => seen(db, id, { channel: "UCb", refreshed: new Date(base + 10_000 + i * 1000).toISOString() }));
  seen(db, "older_day", { refreshed: "2026-09-22T23:59:59.000Z" });
  const f = fakeYt({});
  await refreshSeen({ db, yt: f.yt, detectCfg, crawlCfg }, { now: NOW, maxUnits: 10 });
  assert.deepEqual(f.calls[0], ["older_day", "ab", "bb", "cb", "xa", "ya", "za"]);
});

test("videos_seen の取り直し: 1バッチ（10本以上）の半分超が返ってこなければ題名を消さず、確かめた時刻も進めない", async () => {
  const db = setup();
  const ids = Array.from({ length: 20 }, (_, i) => `g${String(i).padStart(2, "0")}`);
  for (const id of ids) seen(db, id, { refreshed: daysAgo(40) });
  const f = fakeYt(Object.fromEntries(ids.slice(0, 5).map((id) => [id, item(id)])));
  const s = await refreshSeen({ db, yt: f.yt, detectCfg, crawlCfg }, { now: NOW, maxUnits: 10 });
  assert.equal(s.gone, 0);
  assert.equal(s.gone_skipped_by_guard, 15);
  assert.equal(vs(db, "g10").title, "雑談 g10");
  assert.equal(vs(db, "g10").refreshed_at, daysAgo(40));
  assert.ok(String(vs(db, "g00").refreshed_at) > daysAgo(1));
});

test("videos_seen の取り直し: 概要欄の定型文（同じチャンネルの3本以上に出る当たる行）では当たらない。1本だけの行なら当たる", async () => {
  const db = setup();
  const tmpl = "今日も同時視聴の枠はメンバー限定です";
  for (const id of ["a", "b", "c", "d"]) seen(db, id, { refreshed: daysAgo(40) });
  const f = fakeYt({
    a: item("a", { title: "改題 a", description: `${tmpl}\nほか` }),
    b: item("b", { title: "改題 b", description: tmpl }),
    c: item("c", { title: "c 改題", description: `${tmpl}\n今日はARCANEを同時視聴します` }),
    d: item("d", { title: "雑談 d" }),
  });
  const s = await refreshSeen({ db, yt: f.yt, detectCfg, crawlCfg }, { now: NOW, maxUnits: 10 });
  assert.deepEqual(s.redetected, { hit: 1, miss: 2, rejected: 0 });
  assert.equal(vs(db, "a").detect_result, "miss");
  assert.equal(vs(db, "b").detect_result, "miss");
  assert.equal(vs(db, "c").detect_result, "hit");
  assert.equal(vs(db, "c").detect_note, "description:同時視聴");
});

test("当たる行だけで作った定型文と、全部の行で作った定型文で detect の結果は同じ", () => {
  const ds = [
    "チャンネル登録よろしく\n今日も同時視聴の枠はメンバー限定です\n#同時視聴",
    "今日も同時視聴の枠はメンバー限定です\n今日はARCANEを同時視聴します",
    "今日も同時視聴の枠はメンバー限定です\n本日は映画の同時視聴",
    "今日はARCANEを同時視聴します",
    "同時視聴はご遠慮ください 今日",
  ];
  const all = templateLines(ds, detectCfg);
  const count = new Map<string, number>();
  for (const d of ds) for (const l of descriptionHitLines(d, detectCfg)) count.set(l, (count.get(l) ?? 0) + 1);
  const hitOnly = new Set([...count].filter(([, n]) => n >= detectCfg.description.template_min_repeats).map(([l]) => l));
  for (const d of ds) {
    assert.deepEqual(detect({ title: "x", description: d, templateLines: hitOnly }, detectCfg), detect({ title: "x", description: d, templateLines: all }, detectCfg), d);
  }
});

test("videos_seen の取り直し: クォータが尽きたら止め、取れたぶん（判定し直しも）は書く。別の例外は error に入れる。キーが無ければ何もしない", async () => {
  const db = setup();
  const ids = Array.from({ length: 60 }, (_, i) => `q${String(i).padStart(2, "0")}`);
  for (const id of ids) seen(db, id, { refreshed: daysAgo(40) });
  const byId = Object.fromEntries(ids.map((id) => [id, item(id, { title: `【同時視聴】改題 ${id}` })]));
  const s = await refreshSeen({ db, yt: fakeYt(byId, { failAfter: 1 }).yt, detectCfg, crawlCfg }, { now: NOW, maxUnits: 10 });
  assert.equal(s.quota_stopped, true);
  assert.equal(s.refreshed, 50);
  assert.equal(s.redetected.hit, 50);
  assert.equal(vs(db, "q00").detect_result, "hit");
  assert.equal(vs(db, "q55").detect_result, "miss");
  assert.equal(vs(db, "q55").refreshed_at, daysAgo(40));

  const s2 = await refreshSeen({ db, yt: fakeYt(byId, { failAfter: 0, error: new Error("HTTP 500") }).yt, detectCfg, crawlCfg }, { now: NOW, maxUnits: 10 });
  assert.match(String(s2.error), /HTTP 500/);
  const s3 = await refreshSeen({ db, yt: null, detectCfg, crawlCfg }, { now: NOW });
  assert.equal(s3.requested, 0);
  // クォータの残り（ユニット）で本数を切る
  const s4 = await refreshSeen({ db, yt: fakeYt(byId).yt, quota: { remaining: () => 0 }, detectCfg, crawlCfg }, { now: NOW, maxUnits: 10 });
  assert.equal(s4.target_rows, 0);
});

test("巡回: 同じ題名を見たら確かめた時刻を進める。枠の動画は題名も今のものに。題名を消した動画をまた見たら判定し直して入れ直す", () => {
  const db = setup();
  seen(db, "known", { refreshed: daysAgo(40) });
  seen(db, "ev", { refreshed: daysAgo(40), title: "【同時視聴】ARCANE ev", result: "hit" });
  event(db, "ev");
  seen(db, "back", { refreshed: daysAgo(40) });
  db.exec("UPDATE videos_seen SET title = '', published_at = NULL, gone_at = 'x' WHERE video_id = 'back'");
  const ctx = { db, detectCfg } as unknown as Ctx;
  const c = (videoId: string, title: string) => ({ videoId, channelId: "UCx", title, description: null, publishedAt: "2026-09-01T11:00:00Z", via: "playlist" as const });
  judgeCandidates(ctx, [c("known", "雑談 known"), c("ev", "【同時視聴】ARCANE ev 改題"), c("back", "雑談 back")], emptyStats());
  assert.ok(String(vs(db, "known").refreshed_at) > daysAgo(1));
  assert.equal(vs(db, "ev").title, "【同時視聴】ARCANE ev 改題");
  assert.ok(String(vs(db, "ev").refreshed_at) > daysAgo(1));
  assert.equal(vs(db, "back").title, "雑談 back");
  assert.equal(vs(db, "back").gone_at, null);
  assert.equal(vs(db, "back").published_at, "2026-09-01T11:00:00Z");
  assert.ok(String(vs(db, "back").refreshed_at) > daysAgo(1));
});

test("refresh: 返ってきた枠の動画は videos_seen の題名と確かめた時刻も新しくする。中身を消した枠が見られるようになったら入れ直す", async () => {
  const db = setup();
  seen(db, "live", { title: "【同時視聴】ARCANE live", result: "hit" });
  event(db, "live");
  seen(db, "back", { title: "【同時視聴】ARCANE back", result: "hit" });
  event(db, "back", { gone: daysAgo(30) });
  purgeGoneEvents(db, daysAgo(25));
  assert.equal(we(db, "back").title_raw, "");
  const f = fakeYt({ live: item("live", { title: "【同時視聴】ARCANE live（改題）" }), back: item("back", { title: "【同時視聴】ARCANE back", description: "概要", views: "77" }) });
  const ctx = { db, yt: f.yt, detectCfg, crawlCfg } as unknown as Ctx;
  const s = await refreshEvents(ctx, "all");
  assert.equal(s.revived, 1);
  assert.equal(vs(db, "live").title, "【同時視聴】ARCANE live（改題）");
  assert.ok(String(vs(db, "live").refreshed_at) > daysAgo(1));
  const b = we(db, "back");
  assert.equal(b.title_raw, "【同時視聴】ARCANE back");
  assert.equal(b.description_raw, "概要");
  assert.equal(b.view_count, 77);
  assert.equal(b.thumbnail_url, "https://i.ytimg.com/vi/back/mqdefault.jpg");
  assert.equal(b.archive_gone_at, null);
  assert.equal(b.purged_at, null);
  // --video は指定の枠だけ
  const g = fakeYt({ live: item("live") });
  await refreshEvents({ db, yt: g.yt, detectCfg, crawlCfg } as unknown as Ctx, "all", ["live"]);
  assert.deepEqual(g.calls, [["live"]]);
});

test("watch_events: アーカイブが消えて act_after_days を過ぎた枠の題名・概要欄・サムネ・再生数を消す。行・判定・作品の結び付きは残す。detect:rerun・前後の枠で使わない", () => {
  const db = setup();
  const old = event(db, "old", { gone: daysAgo(26) });
  const recent = event(db, "recent", { gone: daysAgo(10) });
  const shown = event(db, "shown");
  db.exec(`INSERT INTO works (id, title, source, created_at, updated_at) VALUES (1, 'ARCANE', 'anilist', 'n', 'n');
    INSERT INTO event_works (watch_event_id, work_id, confidence, match_method, extracted_text, rule_version, created_at) VALUES (${old}, 1, 0.9, 'anilist:exact', 'ARCANE', 'r', 'n');
    INSERT INTO ai_decisions (watch_event_id, status, confidence, evidence, rationale, model, batch, decided_at) VALUES (${old}, 'identified', 'high', '{}', 'r', 'm', 'b', 'n');`);
  const s = purgeGoneEvents(db, daysAgo(25), NOW.toISOString());
  assert.deepEqual(s, { gone: 2, purged: 1, already: 0 });
  const o = we(db, "old");
  assert.equal(o.title_raw, "");
  assert.equal(o.description_raw, null);
  assert.equal(o.thumbnail_url, null);
  assert.equal(o.view_count, null);
  assert.equal(o.view_count_fetched_at, null);
  assert.equal(o.purged_at, NOW.toISOString());
  assert.equal(o.started_at, "2026-09-01T12:00:00Z"); // 時刻と状態は残す（D-12 の範囲）
  assert.equal(we(db, "recent").title_raw, "【同時視聴】ARCANE recent");
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM event_works WHERE watch_event_id = ?").get(old) as { n: number }).n, 1);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM ai_decisions WHERE watch_event_id = ?").get(old) as { n: number }).n, 1);
  assert.deepEqual(purgeGoneEvents(db, daysAgo(25), NOW.toISOString()), { gone: 2, purged: 0, already: 1 });

  // 一覧に出る枠の条件（名寄せ・site:data・ai:queue）は消えた枠を入れない
  const active = (db.prepare(`SELECT id FROM watch_events e WHERE ${activeEventSql("e")}`).all(farFutureCutoff(30)) as { id: number }[]).map((r) => r.id);
  assert.deepEqual(active, [shown]);
  // detect:rerun は中身を消した枠を空の題名で外さない（見られるようになって refresh が入れ直したとき、外れたままにならないように）
  rerunDetect(db, detectCfg);
  assert.equal(we(db, "old").excluded_at, null);
  // 判定役に見せる前後の枠に、中身を消した枠を出さない
  assert.deepEqual(streamerFrames({ db })(1).map((f) => f.id), [recent, shown]);
  void recent;
});

test("videos_seen の題名を消した動画は、判定役に見せる動画・detect:rerun・候補の選び方に使わない", () => {
  const db = setup();
  seen(db, "a", { title: "ARCANE 第2話" });
  seen(db, "b", { title: "ARCANE 第3話" });
  db.exec("UPDATE videos_seen SET detect_version = 'old'");
  db.exec("UPDATE videos_seen SET title = '', published_at = NULL, gone_at = 'x' WHERE video_id = 'b'");
  assert.deepEqual(streamerVideos({ db }, loadExtractConfig())(1).map((v) => v.id), ["a"]);
  const r = rerunDetect(db, detectCfg);
  assert.equal(r.checked, 1);
});

const cand = (videoId: string): Candidate => ({
  videoId, streamerId: 1, streamer: "s", title: "ARCANE PART 2", date: "2026-09-01", members: false,
  reasons: ["continuation_word"], hits: [{ reason: "continuation_word", seed: 1, key: "arcane" }],
});
const cr = (db: DB, id: string) => db.prepare("SELECT * FROM candidates WHERE video_id = ?").get(id) as Record<string, string | number | null>;

test("candidates: 判定に回す候補（ready・hold）は古ければ取り直す（状態はそのまま）。終わった候補は詳細を消す。取れない候補はすぐ消す", async () => {
  const db = setup();
  const states = ["ready", "hold", "not_watchalong", "framed", "detected", "unavailable", "fresh_nw"];
  for (const id of states) seen(db, id);
  saveCandidates(db, states.map(cand), daysAgo(40));
  await fetchCandidates({ db, yt: fakeYt(Object.fromEntries(states.map((id) => [id, item(id, { title: `ARCANE ${id}` })]))).yt, detectCfg });
  // 詳細を40日前に取ったことにして、状態を分ける
  db.exec(`UPDATE candidates SET fetched_at = '${daysAgo(40)}', state_at = '${daysAgo(40)}'`);
  db.exec("UPDATE candidates SET fetched_at = datetime('now') WHERE video_id = 'fresh_nw'");
  for (const st of states) db.prepare("UPDATE candidates SET state = ? WHERE video_id = ?").run(st === "fresh_nw" ? "not_watchalong" : st, st);

  const c = clearCandidates(db, daysAgo(25), NOW.toISOString());
  assert.deepEqual(c.cleared, { detected: 1, framed: 1, not_watchalong: 1, unavailable: 1 });
  for (const id of ["not_watchalong", "framed", "detected", "unavailable"]) {
    const r = cr(db, id);
    assert.equal(r.title_raw, null, id);
    assert.equal(r.description_raw, null);
    assert.equal(r.thumbnail_url, null);
    assert.equal(r.view_count, null);
    assert.equal(r.cleared_at, NOW.toISOString());
    assert.equal(r.status, "completed"); // 状態・時刻は残す
  }
  assert.equal(cr(db, "fresh_nw").title_raw, "ARCANE fresh_nw");
  assert.equal(cr(db, "ready").title_raw, "ARCANE ready");
  assert.equal(cr(db, "hold").title_raw, "ARCANE hold");
  assert.deepEqual(clearCandidates(db, daysAgo(25), NOW.toISOString()).cleared, {});

  // 取り直し: ready・hold の古いものと、取り消しで ready に戻って詳細の無い候補
  db.exec("UPDATE candidates SET state = 'ready' WHERE video_id = 'not_watchalong'");
  const f = fakeYt({ ready: item("ready", { title: "ARCANE ready 改題" }), hold: item("hold"), not_watchalong: item("not_watchalong", { title: "ARCANE back" }) });
  const s = await fetchCandidates({ db, yt: f.yt, detectCfg }, { refetchBefore: daysAgo(25) });
  assert.deepEqual(f.calls, [["ready", "hold", "not_watchalong"]]);
  assert.equal(s.refetched, 3);
  assert.equal(s.ready, 2);
  assert.equal(s.hold, 1);
  assert.equal(cr(db, "ready").title_raw, "ARCANE ready 改題");
  assert.equal(cr(db, "ready").state_at, daysAgo(40)); // 状態が変わらなければ state_at はそのまま
  assert.equal(cr(db, "hold").state, "hold");
  assert.equal(cr(db, "not_watchalong").title_raw, "ARCANE back");
  // refetchBefore を渡さなければ（前の動き）ready・hold を引かない
  const g = fakeYt({});
  await fetchCandidates({ db, yt: g.yt, detectCfg });
  assert.deepEqual(g.calls, []);

  // 取れなくなった候補は詳細を消す（判定に回さない）
  db.exec(`UPDATE candidates SET fetched_at = '${daysAgo(40)}' WHERE video_id = 'hold'`);
  await fetchCandidates({ db, yt: fakeYt({}).yt, detectCfg }, { refetchBefore: daysAgo(25) });
  assert.equal(cr(db, "hold").state, "unavailable");
  assert.equal(cr(db, "hold").title_raw, null);
  assert.ok(cr(db, "hold").cleared_at);
  assert.ok(!candidateQueueRows(db, { includeHold: true }).some((r) => r.ev.video_id === "hold"));
});

test("候補の種の枠に、中身を消した枠を見せない", async () => {
  const db = setup();
  const seed = event(db, "seed", { gone: daysAgo(30) });
  seen(db, "c1");
  saveCandidates(db, [{ ...cand("c1"), hits: [{ reason: "continuation_word", seed, key: "arcane" }] }], daysAgo(1));
  await fetchCandidates({ db, yt: fakeYt({ c1: item("c1") }).yt, detectCfg });
  assert.equal(candidateQueueRows(db)[0]!.candidate.seeds.length, 1);
  purgeGoneEvents(db, daysAgo(25));
  assert.equal(candidateQueueRows(db)[0]!.candidate.seeds.length, 0);
});

test("roster: 巡回を止めた配信者も channels.list で取り直す。返ってこないチャンネルは、最後に返ってから act_after_days を過ぎていればアイコンとチャンネル名を消す", async () => {
  const db = setup();
  db.exec(`UPDATE streamers SET icon_url = 'old', channel_title = 'old' WHERE id = 1;
    INSERT INTO streamers (id, name, affiliation, channel_id, tier, is_active, icon_url, channel_title, channel_meta_at, first_seen_at, updated_at) VALUES
      (2, '卒業', 'hololive', 'UCgrad', 1, 0, 'old', 'old', NULL, 'n', 'n'),
      (3, '消えた', 'hololive', 'UCgone', 1, 0, 'old', 'old', NULL, 'n', 'n'),
      (4, '一時的', 'hololive', 'UCtemp', 1, 1, 'old', 'old', '${daysAgo(3)}', 'n', 'n');`);
  const calls: string[][] = [];
  const ch = (id: string): ChannelItem => ({ id, snippet: { title: `${id} Ch.`, thumbnails: { default: { url: `https://yt3/${id}` } } } });
  const yt = { channels: async (ids: string[]) => { calls.push(ids); return ids.filter((i) => i === "UCx" || i === "UCgrad").map(ch); } };
  const ctx = { db, yt, crawlCfg } as unknown as Ctx;
  const r = await refreshChannelMeta(ctx, NOW);
  assert.deepEqual(calls[0]!.slice().sort(), ["UCgone", "UCgrad", "UCtemp", "UCx"]);
  assert.equal(r.updated, 2);
  assert.equal(r.inactive_updated, 1);
  assert.deepEqual(r.missing.sort(), ["UCgone", "UCtemp"]);
  assert.deepEqual(r.cleared, ["UCgone"]);
  const st = (id: number) => db.prepare("SELECT icon_url, channel_title, channel_meta_at FROM streamers WHERE id = ?").get(id) as Record<string, string | null>;
  assert.equal(st(2).icon_url, "https://yt3/UCgrad");
  assert.ok(st(2).channel_meta_at);
  assert.equal(st(3).icon_url, null);
  assert.equal(st(3).channel_title, null);
  assert.equal(st(4).icon_url, "old"); // 3日前には返っていた（一時的な欠け）
  assert.deepEqual((await refreshChannelMeta(ctx, NOW)).cleared, []); // 消したものをもう一度数えない
});

test("roster: channels.list の1バッチ（10件以上）の半分超が返らなければ消さない", async () => {
  const db = setup();
  for (let i = 0; i < 12; i++) {
    db.prepare("INSERT INTO streamers (name, affiliation, channel_id, tier, is_active, icon_url, first_seen_at, updated_at) VALUES ('x', 'vspo', ?, 1, 0, 'old', 'n', 'n')").run(`UCz${i}`);
  }
  const yt = { channels: async () => [] as ChannelItem[] };
  const r = await refreshChannelMeta({ db, yt, crawlCfg } as unknown as Ctx, NOW);
  assert.equal(r.cleared.length, 0);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM streamers WHERE icon_url = 'old'").get() as { n: number }).n, 12);
});

test("retention:status: 古いものの件数", () => {
  const db = setup();
  seen(db, "a", { refreshed: daysAgo(40) });
  seen(db, "b", { refreshed: daysAgo(27) });
  seen(db, "c", { refreshed: daysAgo(1) });
  event(db, "e1", { gone: daysAgo(26) });
  event(db, "e2");
  db.prepare("UPDATE watch_events SET last_checked_at = ? WHERE video_id = 'e2'").run(daysAgo(26));
  const s = retentionStatus(db, crawlCfg, NOW);
  assert.equal(s.videos_seen.due, 2);
  assert.equal(s.videos_seen.over, 1);
  assert.equal(s.watch_events.purge_due, 1);
  assert.equal(s.watch_events.stale_checked, 1);
  assert.equal(s.streamers.meta_unknown, 1);
  assert.equal(actCutoff(crawlCfg, NOW), daysAgo(crawlCfg.retention.act_after_days));
});

test("retention:files: 区分ごとに並べ、中のファイルが全部古い項目だけを --delete で消す（一部だけ古い・本体の DB・対象外は消さない）", () => {
  const dir = mkdtempSync(join(tmpdir(), "retention-files-"));
  try {
    const old = (NOW.getTime() - 40 * 86_400_000) / 1000;
    const recent = (NOW.getTime() - 2 * 86_400_000) / 1000;
    const put = (p: string, t: number) => {
      mkdirSync(join(dir, p, ".."), { recursive: true });
      writeFileSync(join(dir, p), "x");
      utimesSync(join(dir, p), t, t);
    };
    put("raw/2026-09-23/a.jsonl.gz", old);
    put("raw/2026-11-12/b.jsonl.gz", recent);
    put("db.before-x.sqlite", old);
    put("db.before-x.sqlite-wal", old);
    put("db.sqlite", old);
    put("db.sqlite-shm", old);
    put("ai/run-1/queue/01.json", old);
    put("ai/run-1/thumbs/v.jpg", old);
    put("ai/run-2/queue/01.json", old);
    put("ai/run-2/answers/01.json", recent);
    put("ai/quota.json", old);
    put("analysis/x.txt", old);
    put("review/y.md", recent);
    put("crawl.log", old);
    put("site/site-data.json", old);
    put("site/og-cache/a.png", old);
    put("unresolved.json", old);
    const cutoff = NOW.getTime() - 30 * 86_400_000;
    const es = listDataFiles(dir, cutoff);
    const by = (p: string) => es.find((e) => e.path === p);
    assert.equal(by("raw/2026-09-23")!.status, "over");
    assert.equal(by("raw/2026-11-12")!.status, "fresh");
    assert.equal(by("db.before-x.sqlite")!.category, "db");
    assert.equal(by("db.before-x.sqlite")!.targets.length, 2); // -wal も同じ組
    assert.equal(by("db.sqlite")!.category, "other");
    assert.equal(by("db.sqlite-shm")!.category, "other");
    assert.equal(by("ai/run-1")!.status, "over");
    assert.equal(by("ai/run-1")!.files, 2);
    assert.equal(by("ai/run-2")!.status, "partial");
    assert.equal(by("ai/quota.json"), undefined);
    assert.equal(by("analysis/x.txt")!.status, "over");
    assert.equal(by("crawl.log")!.category, "log");
    assert.equal(by("site/site-data.json")!.category, "site");
    assert.equal(by("site/og-cache")!.category, "other");
    assert.equal(by("unresolved.json")!.category, "export");

    const r = deleteEntries(es.filter((e) => e.category !== "analysis"));
    assert.deepEqual(r.deleted.map((e) => e.path).sort(), ["ai/run-1", "crawl.log", "db.before-x.sqlite", "raw/2026-09-23", "site/site-data.json", "unresolved.json"]);
    assert.ok(!existsSync(join(dir, "db.before-x.sqlite-wal")));
    for (const p of ["db.sqlite", "db.sqlite-shm", "ai/run-2/queue/01.json", "ai/quota.json", "analysis/x.txt", "site/og-cache/a.png", "raw/2026-11-12/b.jsonl.gz"]) {
      assert.ok(existsSync(join(dir, p)), p);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
