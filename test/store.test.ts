import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/lib/db.ts";
import { upsertWork, replaceEventWorks, markUnresolved, markResolved, getOrCreateEpisode } from "../src/resolve/store.ts";
import type { WorkCandidate } from "../src/resolve/types.ts";

function cand(over: Partial<WorkCandidate>): WorkCandidate {
  return {
    source: "annict", sourceKey: "x", annictId: null, anilistId: null, wikidataId: null, malId: null,
    title: "t", titleKana: null, titles: ["t"], media: "tv", seasonName: null, releaseYear: null,
    episodesCount: null, imageUrl: null, seriesId: null, ...over,
  };
}

function freshDb() {
  const db = openDb(":memory:");
  db.exec(`INSERT INTO streamers (id, name, affiliation, channel_id, tier, first_seen_at, updated_at) VALUES (1, 's', 'nijisanji', 'UCx', 1, 'n', 'n');
    INSERT INTO watch_events (id, streamer_id, video_id, title_raw, url, status, detected_at, detect_source, detect_keyword, found_via, updated_at)
    VALUES (1, 1, 'v1', 't', 'u', 'completed', 'n', 'title', 'k', 'rss', 'n'), (2, 1, 'v2', 't', 'u', 'completed', 'n', 'title', 'k', 'rss', 'n');`);
  return db;
}

test("Annict と AniList の同じ作品は MyAnimeList の ID で1行にまとめる", () => {
  const db = freshDb();
  const a = upsertWork(db, cand({ source: "anilist", anilistId: 50, malId: 7, title: "Bocchi", imageUrl: "img" }));
  const b = upsertWork(db, cand({ source: "annict", annictId: 9, malId: 7, title: "ぼっち・ざ・ろっく！" }));
  assert.equal(a, b);
  const w = db.prepare("SELECT annict_id, anilist_id, title, image_url, source FROM works").all();
  assert.equal(w.length, 1);
  // 主軸（Annict）の作品名を優先し、AniList の画像は残す
  assert.deepEqual({ ...w[0] }, { annict_id: 9, anilist_id: 50, title: "ぼっち・ざ・ろっく！", image_url: "img", source: "annict" });
});

test("別々に作られた同じ作品の行は、ID が重なった時点でまとめる（一意制約で落ちない）", () => {
  const db = freshDb();
  const annictRow = upsertWork(db, cand({ source: "annict", annictId: 9, title: "A" }));
  const anilistRow = upsertWork(db, cand({ source: "anilist", anilistId: 50, title: "A" }));
  replaceEventWorks(db, 2, [{ workId: anilistRow, episodeId: null, confidence: 0.9, method: "anilist:exact", extractedText: "A" }], "r");
  // Annict 側の候補が AniList の ID も持って現れた
  const merged = upsertWork(db, cand({ source: "annict", annictId: 9, anilistId: 50, title: "A" }));
  assert.equal(merged, annictRow);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM works").get() as { n: number }).n, 1);
  // 付け替えた枠の紐付けが残っている
  assert.equal((db.prepare("SELECT work_id FROM event_works WHERE watch_event_id = 2").get() as { work_id: number }).work_id, annictRow);
});

test("未同定 → 同定で resolved_at を立て、行は残す。EventWork は入れ替える", () => {
  const db = freshDb();
  markUnresolved(db, 1, "not_found", "X", { segments: ["X"] }, "r1");
  const w = upsertWork(db, cand({ source: "wikidata", wikidataId: "Q1", media: "movie" }));
  replaceEventWorks(db, 1, [{ workId: w, episodeId: null, confidence: 0.9, method: "wikipedia:exact", extractedText: "X" }], "r2");
  markResolved(db, 1, "r2");
  const u = db.prepare("SELECT reason, resolved_at FROM unresolved WHERE watch_event_id = 1").get() as { reason: string; resolved_at: string | null };
  assert.equal(u.reason, "not_found");
  assert.ok(u.resolved_at);
  // 再び未同定になったら EventWork を消し、resolved_at を戻す
  markUnresolved(db, 1, "ambiguous", "X", {}, "r3");
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM event_works WHERE watch_event_id = 1").get() as { n: number }).n, 0);
  assert.equal((db.prepare("SELECT resolved_at FROM unresolved WHERE watch_event_id = 1").get() as { resolved_at: string | null }).resolved_at, null);
});

test("話は作品と番号で1行（同じ話を二重に作らない）", () => {
  const db = freshDb();
  const w = upsertWork(db, cand({ annictId: 1 }));
  const e1 = getOrCreateEpisode(db, w, 3, "第3話", null);
  const e2 = getOrCreateEpisode(db, w, 3, "#3", "タイトル");
  assert.equal(e1, e2);
  replaceEventWorks(db, 1, [
    { workId: w, episodeId: e1, confidence: 1, method: "annict:exact", extractedText: "t" },
    { workId: w, episodeId: e1, confidence: 1, method: "annict:exact", extractedText: "t" },
  ], "r");
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM event_works").get() as { n: number }).n, 1);
});

test("MyAnimeList の ID が同じでも、Annict の別作品はまとめない（総集編 Re: と Re:Re:）", () => {
  const db = freshDb();
  const re = upsertWork(db, cand({ source: "annict", annictId: 100, malId: 55357, title: "劇場総集編ぼっち・ざ・ろっく！ Re:", media: "movie" }));
  const rere = upsertWork(db, cand({ source: "annict", annictId: 101, malId: 55357, title: "劇場総集編ぼっち・ざ・ろっく！ Re:Re:", media: "movie" }));
  assert.notEqual(re, rere);
  // AniList 側の同じ MAL の作品は、どちらの作品か MAL では決められないので、別の行にする（誤って付けない）
  const al = upsertWork(db, cand({ source: "anilist", anilistId: 165253, malId: 55357, title: "ぼっち・ざ・ろっく！Re:" }));
  assert.ok(al !== re && al !== rere);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM works").get() as { n: number }).n, 3);
});
