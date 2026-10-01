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

test("AI の判定: 入れ直しても同じ結果になり、取り消すまで残る（確定）", async () => {
  const { applyAiDecisions } = await import("../src/resolve/ai.ts");
  const db = freshDb();
  const work = cand({ source: "wikidata", sourceKey: "wikidata:Q1", wikidataId: "Q1", title: "来る", media: "movie", releaseYear: 2018 });
  db.prepare(`INSERT INTO ai_decisions (watch_event_id, status, works, confidence, evidence, rationale, model, batch, decided_at)
    VALUES (1, 'identified', ?, 'high', '{"looked":["title"]}', 'r', 'm', 'b', 'n'), (2, 'not_a_work', NULL, 'medium', '{"looked":["title"]}', 'r', 'm', 'b', 'n')`)
    .run(JSON.stringify([{ key: "wikidata:Q1", work }]));
  applyAiDecisions(db, "v1");
  applyAiDecisions(db, "v1");
  const rows = db.prepare("SELECT watch_event_id, match_method FROM event_works").all().map((r) => ({ ...r }));
  assert.deepEqual(rows, [{ watch_event_id: 1, match_method: "ai:high" }]);
  assert.equal((db.prepare("SELECT reason FROM unresolved WHERE watch_event_id = 2 AND resolved_at IS NULL").get() as { reason: string }).reason, "not_a_work");
  // 取り消せば反映しない
  db.exec("UPDATE ai_decisions SET revoked_at = 'n' WHERE watch_event_id = 1");
  assert.deepEqual(applyAiDecisions(db, "v1", [1]), { identified: 0, not_a_work: 0, unidentifiable: 0, not_in_db: 0 });
});

test("AI の判定: 作品だが外部DBに無い（not_in_db）は未同定の理由 not_in_db にして作品名を残す", async () => {
  const { applyAiDecisions } = await import("../src/resolve/ai.ts");
  const db = freshDb();
  db.prepare(`INSERT INTO ai_decisions (watch_event_id, status, works, confidence, evidence, rationale, model, batch, decided_at, extra)
    VALUES (1, 'not_in_db', NULL, 'high', '{"looked":["title","lookup"]}', 'r', 'm', 'b', 'n', '{"title":"歩女"}')`).run();
  assert.deepEqual(applyAiDecisions(db, "v1"), { identified: 0, not_a_work: 0, unidentifiable: 0, not_in_db: 1 });
  const u = db.prepare("SELECT reason, extracted_text FROM unresolved WHERE watch_event_id = 1 AND resolved_at IS NULL").get() as { reason: string; extracted_text: string };
  assert.deepEqual({ ...u }, { reason: "not_in_db", extracted_text: "歩女" });
});

test("Wikidata で引いたアニメは、MyAnimeList・AniList の ID でアニメのDBの行にまとめる（ID が複数の項目はまとめない）", async () => {
  const { linkAnimeIds } = await import("../src/resolve/link.ts");
  const { loadExtractConfig } = await import("../src/resolve/config.ts");
  const db = freshDb();
  const annictRow = upsertWork(db, cand({ source: "annict", annictId: 9, anilistId: 2001, malId: 2001, title: "天元突破グレンラガン" }));
  const wdRow = upsertWork(db, cand({ source: "wikidata", wikidataId: "Q4277", title: "天元突破グレンラガン" }));
  const comboRow = upsertWork(db, cand({ source: "wikidata", wikidataId: "Q999", title: "期をまとめた項目" }));
  const lonely = upsertWork(db, cand({ source: "wikidata", wikidataId: "Q85", title: "機動戦士Ζガンダム" }));
  replaceEventWorks(db, 1, [{ workId: wdRow, episodeId: null, confidence: 1, method: "wikipedia:redirect", extractedText: "グレンラガン" }], "v1");
  replaceEventWorks(db, 2, [{ workId: annictRow, episodeId: null, confidence: 1, method: "annict:exact", extractedText: "天元突破グレンラガン" }], "v1");
  const ext = (v: string) => ({ mainsnak: { datavalue: { value: v } } });
  const claims: Record<string, Record<string, unknown[]>> = {
    Q4277: { P4086: [ext("2001")], P8729: [ext("2001")] },
    Q999: { P4086: [ext("1"), ext("2")] },
    Q85: { P4086: [ext("85")], P8729: [ext("85")] },
  };
  const http = {
    postForm: async (_u: string, form: Record<string, string>) => ({ status: 200, body: JSON.stringify({ entities: Object.fromEntries(form.ids!.split("|").map((id) => [id, { id, claims: claims[id] ?? {} }])) }) }),
    postJson: async () => ({ status: 200, body: JSON.stringify({ data: { Page: { media: [] } } }) }),
  };
  const saved = process.env.ANNICT_TOKEN;
  delete process.env.ANNICT_TOKEN;
  try {
    const r = await linkAnimeIds({ db, http } as never, loadExtractConfig());
    assert.equal(r.merged, 1);
    assert.equal(r.idsOnly, 1);
    assert.equal(r.multi, 1);
  } finally {
    if (saved !== undefined) process.env.ANNICT_TOKEN = saved;
  }
  // グレンラガンは Annict の行1つにまとまり、Wikidata の ID が付く
  assert.equal(db.prepare("SELECT COUNT(*) n FROM works WHERE id = ?").get(wdRow)!.n, 0);
  assert.equal(db.prepare("SELECT wikidata_id FROM works WHERE id = ?").get(annictRow)!.wikidata_id, "Q4277");
  assert.equal(db.prepare("SELECT COUNT(DISTINCT work_id) n FROM event_works").get()!.n, 1);
  // Annict の行の無い作品は ID だけ付く。期をまとめた項目はそのまま
  assert.equal(db.prepare("SELECT mal_id FROM works WHERE id = ?").get(lonely)!.mal_id, 85);
  assert.equal(db.prepare("SELECT mal_id FROM works WHERE id = ?").get(comboRow)!.mal_id, null);
});

test("ID の無い Wikidata のアニメは、作品名・映画かシリーズか・公開年（±1年）が合うアニメのDBの行が1つだけならまとめる", async () => {
  const { linkAnimeIds } = await import("../src/resolve/link.ts");
  const { loadExtractConfig } = await import("../src/resolve/config.ts");
  const db = freshDb();
  const annictRow = upsertWork(db, cand({ source: "annict", annictId: 5, title: "ナイトメアー・ビフォア・クリスマス", media: "movie", releaseYear: 1994 }));
  const wdRow = upsertWork(db, cand({ source: "wikidata", wikidataId: "Q322328", title: "ナイトメアー・ビフォア・クリスマス", media: "movie", releaseYear: 1993 }));
  // 実写のリメイク（アニメーションの項目でない）と、公開年が離れたものはまとめない
  const remake = upsertWork(db, cand({ source: "wikidata", wikidataId: "Q2", title: "アラジン", media: "movie", releaseYear: 2019 }));
  upsertWork(db, cand({ source: "annict", annictId: 6, title: "アラジン", media: "movie", releaseYear: 1993 }));
  const far = upsertWork(db, cand({ source: "wikidata", wikidataId: "Q3", title: "ナイトメアー・ビフォア・クリスマス", media: "tv", releaseYear: 1993 }));
  const item = (p31: string) => ({ P31: [{ mainsnak: { datavalue: { value: { id: p31 } } } }] });
  const claims: Record<string, unknown> = { Q322328: item("Q202866"), Q2: item("Q11424"), Q3: item("Q202866") };
  const http = {
    postForm: async (_u: string, form: Record<string, string>) => ({ status: 200, body: JSON.stringify({ entities: Object.fromEntries(form.ids!.split("|").map((id) => [id, { id, claims: claims[id] ?? {} }])) }) }),
    postJson: async () => ({ status: 200, body: JSON.stringify({ data: { Page: { media: [] } } }) }),
  };
  const r = await linkAnimeIds({ db, http } as never, loadExtractConfig());
  assert.equal(r.byTitle, 1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM works WHERE id = ?").get(wdRow)!.n, 0);
  assert.equal(db.prepare("SELECT wikidata_id FROM works WHERE id = ?").get(annictRow)!.wikidata_id, "Q322328");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM works WHERE id IN (?, ?)").get(remake, far)!.n, 2);
});
