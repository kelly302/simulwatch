import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/lib/db.ts";
import type { DB } from "../src/lib/db.ts";
import { assignPublicKeys } from "../src/publish/keys.ts";
import { buildSiteData, frameOf, seasonOf } from "../src/publish/snapshot.ts";

const AI_ROUTES = ["series", "unresolved", "unidentifiable_rule", "not_a_work_conflict"];
const NOW = new Date("2026-10-19T12:00:00Z");

function freshDb(): DB {
  const db = openDb(":memory:");
  db.exec(`INSERT INTO streamers (id, name, name_en, affiliation, branch, channel_id, tier, first_seen_at, updated_at)
    VALUES (1, 'A', NULL, 'nijisanji', 'jp', 'UCa', 1, 'n', 'n'), (2, 'ルカ', 'Luca', 'nijisanji', 'en', 'UCb', 1, 'n', 'n'), (3, 'C', NULL, 'vspo', 'jp', 'UCc', 1, 'n', 'n')`);
  return db;
}

let nextEvent = 1;
/** 枠を1つ作る（型・AI の判定・未同定の理由・作品は引数で） */
function ev(db: DB, o: {
  streamer: number; at: string; status?: string; members?: boolean; views?: number | null; route?: string | null;
  ai?: { status: string; confidence: string; extra?: unknown } | null; reason?: string | null; works?: [number, number?][];
  scheduled?: string | null; archiveGone?: boolean;
}): number {
  const id = nextEvent++;
  db.prepare(`INSERT INTO watch_events (id, streamer_id, video_id, title_raw, url, started_at, scheduled_start_at, status, is_members_only, view_count,
      detected_at, detect_source, detect_keyword, found_via, archive_gone_at, updated_at)
    VALUES (?, ?, ?, ?, 'u', ?, ?, ?, ?, ?, 'n', 'title', 'k', 'rss', ?, 'n')`)
    .run(id, o.streamer, `v${String(id).padStart(10, "0")}`, `【同時視聴】枠${id}`, o.at, o.scheduled ?? null, o.status ?? "completed", o.members ? 1 : 0,
      o.views === undefined ? 1000 : o.views, o.archiveGone ? "n" : null);
  db.prepare("INSERT INTO event_resolution (watch_event_id, status, rule_version, processed_at, route) VALUES (?, 'x', 'r', 'n', ?)").run(id, o.route === undefined ? "unique_exact" : o.route);
  if (o.ai) db.prepare(`INSERT INTO ai_decisions (watch_event_id, status, confidence, evidence, rationale, model, batch, decided_at, extra)
    VALUES (?, ?, ?, '{}', 'r', 'm', 'b', 'n', ?)`).run(id, o.ai.status, o.ai.confidence, o.ai.extra ? JSON.stringify(o.ai.extra) : null);
  if (o.reason) db.prepare("INSERT INTO unresolved (watch_event_id, reason, rule_version, created_at, updated_at, extracted_text) VALUES (?, ?, 'r', 'n', 'n', ?)")
    .run(id, o.reason, o.reason === "not_in_db" ? (o.ai?.extra as { title?: string } | undefined)?.title ?? null : null);
  for (const [w, ep] of o.works ?? []) {
    let epId: number | null = null;
    if (ep != null) {
      db.prepare("INSERT OR IGNORE INTO episodes (work_id, number, number_text) VALUES (?, ?, ?)").run(w, ep, `第${ep}話`);
      epId = (db.prepare("SELECT id FROM episodes WHERE work_id = ? AND number = ?").get(w, ep) as { id: number }).id;
    }
    db.prepare(`INSERT INTO event_works (watch_event_id, work_id, episode_id, confidence, match_method, extracted_text, rule_version, created_at)
      VALUES (?, ?, ?, 0.9, 'annict:exact', 't', 'r', 'n')`).run(id, w, epId);
  }
  return id;
}

function work(db: DB, id: number, o: { annict?: number; anilist?: number; wikidata?: string; title?: string; kind?: string; media?: string; season?: string; year?: number; series?: string } = {}) {
  db.prepare(`INSERT INTO works (id, annict_id, anilist_id, wikidata_id, title, media, season_name, release_year, series_id, series_title, kind, source, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'annict', 'n', 'n')`)
    .run(id, o.annict ?? null, o.anilist ?? null, o.wikidata ?? null, o.title ?? `作品${id}`, o.media ?? "tv", o.season ?? null, o.year ?? null,
      o.series ?? null, o.series ? "シリーズ" : null, o.kind ?? "anime");
}

const build = (db: DB, now = NOW) => buildSiteData(db, { now, aiRoutes: AI_ROUTES, maxDaysAhead: 30, upcomingStaleHours: 6 });

test("出す枠は publishState の work・frame だけ。予定枠は予定時刻から6時間で出さない（決定 A）", () => {
  const db = freshDb();
  work(db, 1, { annict: 1 });
  const shown = ev(db, { streamer: 1, at: "2026-10-01T10:00:00Z", works: [[1]] });
  ev(db, { streamer: 1, at: "2026-10-02T10:00:00Z", route: "not_a_work_rule", reason: "not_a_work" }); // 作品ではない
  ev(db, { streamer: 1, at: "2026-10-03T10:00:00Z", route: "unresolved", reason: "not_found" }); // AI の判定待ち
  ev(db, { streamer: 1, at: "2026-10-04T10:00:00Z", archiveGone: true, works: [[1]] }); // アーカイブなし
  const fresh = ev(db, { streamer: 1, at: "2026-10-19T08:00:00Z", scheduled: "2026-10-19T08:00:00Z", status: "upcoming", views: null, works: [[1]] }); // 4時間前
  ev(db, { streamer: 1, at: "2026-10-19T05:00:00Z", scheduled: "2026-10-19T05:00:00Z", status: "upcoming", views: null, works: [[1]] }); // 7時間前
  const pendingUp = ev(db, { streamer: 1, at: "2026-10-20T10:00:00Z", scheduled: "2026-10-20T10:00:00Z", status: "upcoming", views: null, route: "unresolved", reason: "not_found" });
  const d = build(db);
  assert.deepEqual(d.events.map((e) => e.id).sort(), [shown, fresh, pendingUp].sort());
  // 判定待ちの予定枠は作品を付けずに枠として出す（枠のタイトル）
  assert.deepEqual(d.events.find((e) => e.id === pendingUp)!.frame, { named: false, title: `【同時視聴】枠${pendingUp}`, kind: null, movie: null });
});

test("集計: 終わった枠だけ。再生数はメン限を除き、取れた枠が無ければ NULL（0 と区別する）", () => {
  const db = freshDb();
  work(db, 1, { annict: 1 });
  work(db, 2, { wikidata: "Q2", kind: "live_action", media: "movie" });
  ev(db, { streamer: 1, at: "2026-01-01T10:00:00Z", views: 500, works: [[1, 1], [1, 2]] });
  ev(db, { streamer: 2, at: "2026-02-01T10:00:00Z", views: 900, works: [[1, 3]] });
  ev(db, { streamer: 2, at: "2026-03-01T10:00:00Z", members: true, views: 77, works: [[1, 4]] });
  ev(db, { streamer: 1, at: "2026-04-01T10:00:00Z", members: true, views: null, works: [[2]] });
  ev(db, { streamer: 3, at: "2026-10-20T10:00:00Z", scheduled: "2026-10-20T10:00:00Z", status: "upcoming", views: null, works: [[2]] });
  const d = build(db);
  const w1 = d.works.find((w) => w.id === 1)!;
  assert.deepEqual([w1.streamersCount, w1.eventsCount, w1.membersCount, w1.viewsMax, w1.viewsTotal], [2, 3, 1, 900, 1400]);
  assert.equal(w1.key, "annict-1");
  const w2 = d.works.find((w) => w.id === 2)!;
  assert.deepEqual([w2.streamersCount, w2.viewsMax, w2.viewsTotal, w2.key], [1, null, null, "wikidata-Q2"]);
  // メン限の枠の再生数は出さない
  assert.equal(d.events.find((e) => e.membersOnly && e.works[0]!.id === 1)!.views, null);
  // 話数の表記
  assert.equal(d.events.find((e) => e.views === 500)!.works[0]!.episodes, "第1話〜第2話");
  // 配信者の集計。予定枠しか無い配信者はページを作らない
  const s = new Map(d.streamers.map((x) => [x.id, x]));
  assert.deepEqual([s.get(1)!.eventsCount, s.get(1)!.worksCount, s.get(1)!.hasPage], [2, 2, true]);
  assert.equal(s.get(3)!.hasPage, false);
});

test("作品を付けない枠の見せ方: 外部DBに無い作品・作品名だけの特定できない枠・確度 low", () => {
  const base = { title_raw: "【同時視聴】X", extracted_text: null } as const;
  assert.deepEqual(frameOf({ ...base, ai_status: "not_in_db", ai_conf: "high", reason: "not_in_db" }, { title: "ミュージカル", kind: "live_action", movie: false }),
    { named: true, title: "ミュージカル", kind: "live_action", movie: false });
  assert.deepEqual(frameOf({ ...base, ai_status: "unidentifiable", ai_conf: "medium", reason: "unidentifiable" }, { title: "スクリーム" }),
    { named: true, title: "スクリーム", kind: null, movie: null });
  assert.equal(frameOf({ ...base, ai_status: "unidentifiable", ai_conf: "medium", reason: "unidentifiable" }, null).named, false);
  assert.deepEqual(frameOf({ ...base, ai_status: "identified", ai_conf: "low", reason: null }, null), { named: false, title: "【同時視聴】X", kind: null, movie: null });
  assert.equal(seasonOf("2022-autumn"), "autumn");
  assert.equal(seasonOf("2022"), null);
});

const sorted = (m: Map<number, string>) => [...m].sort((a, b) => a[0] - b[0]);

test("公開キー: 一度出したキーは変えない。行がまとまったら古いキーから 301、作品が無くなったら転送しない", () => {
  const db = freshDb();
  // 1回目: Wikidata だけの作品と、Annict の作品
  let r = assignPublicKeys(db, [{ id: 1, annictId: null, anilistId: null, wikidataId: "Q1" }, { id: 2, annictId: 7, anilistId: 70, wikidataId: null }], "t1");
  assert.deepEqual(sorted(r.keys), [[1, "wikidata-Q1"], [2, "annict-7"]]);
  // 2回目: 行が作り直され（id が変わる）、Wikidata の作品に Annict の ID が付いた。URL は変えない
  r = assignPublicKeys(db, [{ id: 10, annictId: 9, anilistId: null, wikidataId: "Q1" }, { id: 11, annictId: 7, anilistId: 70, wikidataId: null }], "t2");
  assert.deepEqual(sorted(r.keys), [[10, "wikidata-Q1"], [11, "annict-7"]]);
  assert.deepEqual(r.redirects, []);
  // 3回目: 2つの行が1つにまとまった（Annict 7 に Wikidata Q1 が付いた）。優先のキーを残し、もう一方は 301
  r = assignPublicKeys(db, [{ id: 20, annictId: 7, anilistId: 70, wikidataId: "Q1" }], "t3");
  assert.deepEqual(sorted(r.keys), [[20, "annict-7"]]);
  assert.deepEqual(r.redirects, [{ from: "/works/wikidata-Q1/", to: "/works/annict-7/" }]);
  // 4回目: 作品が無くなった。転送しない（404）
  r = assignPublicKeys(db, [{ id: 30, annictId: 99, anilistId: null, wikidataId: null }], "t4");
  assert.deepEqual(r.redirects, []);
  assert.equal(r.keys.get(30), "annict-99");
});

test("lastmod: ページの中身（再生数を除く）が変わった日。再生数だけ変わっても日付は変えない", () => {
  const db = freshDb();
  work(db, 1, { annict: 1 });
  const e = ev(db, { streamer: 1, at: "2026-01-01T10:00:00Z", views: 100, works: [[1]] });
  const first = build(db, new Date("2026-10-01T00:00:00Z"));
  assert.equal(first.works[0]!.lastmod, "2026-10-01T00:00:00.000Z");
  db.prepare("UPDATE watch_events SET view_count = 999 WHERE id = ?").run(e);
  const second = build(db, new Date("2026-10-02T00:00:00Z"));
  assert.equal(second.works[0]!.lastmod, "2026-10-01T00:00:00.000Z");
  ev(db, { streamer: 2, at: "2026-09-01T10:00:00Z", works: [[1]] });
  const third = build(db, new Date("2026-10-03T00:00:00Z"));
  assert.equal(third.works[0]!.lastmod, "2026-10-03T00:00:00.000Z");
  // 枠が増えていない配信者のページは変わらない
  assert.equal(third.streamers.find((s) => s.id === 1)!.lastmod, "2026-10-01T00:00:00.000Z");
});
