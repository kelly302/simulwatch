import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyRoute, routeFlags, zeroErrorUpper95, notAWorkGroups, stratumOf, publishState, needsAi } from "../src/resolve/route.ts";
import type { RouteFacts } from "../src/resolve/route.ts";
import { compareAnswer, validateAnswer, siblingTitles } from "../src/report/audit.ts";
import type { RuleAnswer, RuleWork, AuditAnswer } from "../src/report/audit.ts";
import { loadExtractConfig } from "../src/resolve/config.ts";
import type { WorkCandidate } from "../src/resolve/types.ts";

const facts = (p: Partial<RouteFacts>): RouteFacts => ({ ai: null, works: [], unresolvedReason: null, disambiguation: false, prefixSiblings: [], ...p });

test("型: 目印が無く括弧の中身・区間の完全一致なら「名前が一意の完全一致」", () => {
  assert.equal(classifyRoute(facts({ works: [{ method: "annict:exact", from: "title" }] })), "unique_exact");
  assert.equal(classifyRoute(facts({ works: [{ method: "wikipedia:exact", from: "quote" }] })), "unique_exact");
});

test("型: 目印が重なれば決めた順の先の型に入る", () => {
  const f = facts({ works: [{ method: "wikipedia:search", from: "sub" }], disambiguation: true });
  assert.deepEqual(routeFlags(f), ["sub_desc_tag", "search", "disambiguation"]);
  assert.equal(classifyRoute(f), "sub_desc_tag");
  assert.equal(classifyRoute(facts({ works: [{ method: "annict:exact", from: "title" }, { method: "annict:exact", from: "title" }] })), "multi");
  assert.equal(classifyRoute(facts({ works: [{ method: "series:marker", from: "unknown" }] })), "series");
  assert.equal(classifyRoute(facts({ works: [{ method: "annict:exact", from: "title" }], prefixSiblings: ["進撃の巨人 Season 2"] })), "prefix_sibling");
});

test("型: 手がかりで選んだものと、期の表記で作り直したものは分ける", () => {
  assert.equal(classifyRoute(facts({ works: [{ method: "annict:exact+date", from: "title" }] })), "tiebreak");
  assert.equal(classifyRoute(facts({ works: [{ method: "wikidata:label+movie", from: "title" }] })), "tiebreak");
  assert.equal(classifyRoute(facts({ works: [{ method: "annict:exact+season", from: "title" }] })), "season_variant");
  assert.equal(classifyRoute(facts({ works: [{ method: "wikidata:label", from: "title" }] })), "label");
});

test("型: AI の確定・未同定の理由", () => {
  assert.equal(classifyRoute(facts({ ai: "not_a_work" })), "ai_not_a_work");
  assert.equal(classifyRoute(facts({ ai: "identified", works: [{ method: "ai:high", from: "unknown" }] })), "ai_identified");
  assert.equal(classifyRoute(facts({ unresolvedReason: "not_a_work" })), "not_a_work_rule");
  assert.equal(classifyRoute(facts({ unresolvedReason: "not_found" })), "unresolved");
  // 段が分からない一意の一致は型分けの漏れとして別にする
  assert.equal(classifyRoute(facts({ works: [{ method: "annict:exact", from: "unknown" }] })), "other_identified");
});

test("0件のときの95%上限", () => {
  assert.equal(Math.round(zeroErrorUpper95(50) * 1000) / 10, 5.8);
  assert.equal(Math.round(zeroErrorUpper95(100) * 1000) / 10, 3);
});

const rw = (p: Partial<RuleWork>): RuleWork => ({
  keys: ["annict:1"], mal: null, title: "A", media: "tv", year: 2020, season: null, episodes: [], method: "annict:exact", text: "A", from: "title", ...p,
});
const rule = (p: Partial<RuleAnswer>): RuleAnswer => ({
  video_id: "v", event_id: 1, type: "unique_exact", flags: [], status: "identified", reason: null, text: null, works: [rw({})],
  disambiguation: false, prefixSiblings: [], ...p,
});
const ans = (p: Partial<AuditAnswer>): AuditAnswer => ({
  video_id: "v", status: "identified", works: [{ key: "annict:1" }], confidence: "high", evidence: { looked: ["title"] }, rationale: "r", ...p,
});
const noMal = () => null;

test("突き合わせ: キー・also・MyAnimeList の ID のどれかが同じなら同じ作品", () => {
  assert.equal(compareAnswer(rule({}), ans({}), noMal).outcome, "agree");
  assert.equal(compareAnswer(rule({ works: [rw({ keys: ["annict:1", "wikidata:Q9"] })] }), ans({ works: [{ key: "wikidata:Q9" }] }), noMal).outcome, "agree");
  assert.equal(compareAnswer(rule({}), ans({ works: [{ key: "wikidata:Q5", also: ["annict:1"] }] }), noMal).outcome, "agree");
  assert.equal(compareAnswer(rule({ works: [rw({ mal: 77 })] }), ans({ works: [{ key: "anilist:3" }] }), (k) => (k === "anilist:3" ? 77 : null)).outcome, "agree");
  assert.equal(compareAnswer(rule({}), ans({ works: [{ key: "annict:2" }] }), noMal).outcome, "wrong");
});

test("突き合わせ: ルールだけの作品・話数は誤りの疑い、ルールが AI の一部なら取りこぼし（映画は話数を見ない）", () => {
  const two = rule({ works: [rw({}), rw({ keys: ["annict:2"], title: "B" })] });
  assert.equal(compareAnswer(two, ans({}), noMal).outcome, "wrong");
  assert.equal(compareAnswer(rule({}), ans({ works: [{ key: "annict:1" }, { key: "annict:2" }] }), noMal).outcome, "missing");
  assert.equal(compareAnswer(rule({}), ans({ missing: ["外部DBに無い作品"] }), noMal).outcome, "missing");
  assert.equal(compareAnswer(rule({ works: [rw({ episodes: [3, 4] })] }), ans({ works: [{ key: "annict:1", episodes: [4, 3] }] }), noMal).outcome, "agree");
  assert.equal(compareAnswer(rule({ works: [rw({ episodes: [3, 4] })] }), ans({}), noMal).outcome, "wrong_episodes");
  assert.equal(compareAnswer(rule({ works: [rw({ episodes: [13] })] }), ans({ works: [{ key: "annict:1", episodes: [13, 14] }] }), noMal).outcome, "missing_episodes");
  assert.equal(compareAnswer(rule({}), ans({ works: [{ key: "annict:1", episodes: [5] }] }), noMal).outcome, "missing_episodes");
  assert.equal(compareAnswer(rule({ works: [rw({ media: "movie", episodes: [] })] }), ans({ works: [{ key: "annict:1", episodes: [1] }] }), noMal).outcome, "agree");
});

test("突き合わせ: 同定でないものは区分で比べ、AI の保留は比べない", () => {
  assert.equal(compareAnswer(rule({ status: "not_a_work", works: [] }), ans({ status: "not_a_work", works: [] }), noMal).outcome, "agree");
  assert.equal(compareAnswer(rule({ status: "not_a_work", works: [] }), ans({ status: "not_in_db", works: [], title: "X" }), noMal).outcome, "wrong");
  assert.equal(compareAnswer(rule({ status: "unidentifiable", works: [] }), ans({}), noMal).outcome, "missing");
  assert.equal(compareAnswer(rule({}), ans({ status: "not_a_work", works: [] }), noMal).outcome, "wrong");
  assert.equal(compareAnswer(rule({}), ans({ status: "hold", works: [] }), noMal).outcome, "hold");
});

test("答えの検査: 作品ではない・外部DBに無いは照会が必須", () => {
  assert.equal(validateAnswer(ans({})), null);
  assert.match(validateAnswer(ans({ status: "not_a_work", works: [] }))!, /照会していない/);
  assert.equal(validateAnswer(ans({ status: "not_a_work", works: [], evidence: { looked: ["title", "lookup"], queries: ["X"] } })), null);
  assert.match(validateAnswer(ans({ status: "not_in_db", works: [], evidence: { looked: ["lookup"], queries: ["X"] } }))!, /title/);
  assert.match(validateAnswer(ans({ works: [{ key: "tmdb:1" }] }))!, /key/);
  assert.match(validateAnswer(ans({ status: "hold", works: [], missing: ["X"] }))!, /missing/);
});

const cand = (p: Partial<WorkCandidate>): WorkCandidate => ({
  source: "annict", sourceKey: "annict:1", annictId: 1, anilistId: null, wikidataId: null, malId: null, title: "A", titleKana: null,
  titles: ["A"], media: "tv", seasonName: null, releaseYear: 2010, episodesCount: 12, imageUrl: null, seriesId: null, ...p,
});

test("ほかの作品名: 区間で始まる別作品。枠より後の作品と、照会先が違う同名のアニメは除く", () => {
  const cfg = loadExtractConfig();
  const self = { keys: ["annict:1"], mal: 10, title: "進撃の巨人", text: "進撃の巨人" };
  const at = Date.UTC(2020, 0, 1);
  const pool = [
    cand({ sourceKey: "annict:1", title: "進撃の巨人", malId: 10 }),
    cand({ sourceKey: "annict:2", annictId: 2, title: "進撃の巨人 Season 2", releaseYear: 2017 }),
    cand({ sourceKey: "annict:3", annictId: 3, title: "進撃の巨人 The Final Season", releaseYear: 2020, seasonName: "2020-autumn" }),
    cand({ source: "wikidata", sourceKey: "wikidata:Q1", title: "進撃の巨人", isAnime: true }),
    cand({ source: "wikidata", sourceKey: "wikidata:Q2", title: "進撃の巨人", isAnime: false, media: "movie", releaseYear: 2015 }),
  ];
  const got = siblingTitles(self, pool, at, cfg);
  assert.equal(got.length, 2);
  assert.ok(got.some((x) => x.includes("Season 2")));
  assert.ok(got.some((x) => x.includes("wikidata:Q2")));
  // 実写の作品から見た同名のアニメは別作品
  const live = { keys: ["wikidata:Q2"], mal: null, title: "進撃の巨人", text: "進撃の巨人" };
  assert.ok(siblingTitles(live, pool, at, cfg).some((x) => x.includes("annict:1")));
});

test("型: 目印の無い Wikidata の実写のテレビ作品は「名前が一意」から切り出す（ほかの目印が先）", () => {
  assert.equal(classifyRoute(facts({ works: [{ method: "wikipedia:exact", from: "quote" }], liveActionTv: true })), "live_action_tv");
  assert.equal(classifyRoute(facts({ works: [{ method: "wikipedia:redirect", from: "title" }], liveActionTv: true })), "redirect");
  assert.equal(classifyRoute(facts({ works: [{ method: "wikipedia:exact", from: "quote" }], liveActionTv: false })), "unique_exact");
});

test("作品ではない語の種類は、設定のコメントの見出しで分ける", () => {
  const yaml = [
    "version: 1",
    "not_a_work:",
    "  # ゲーム・企業の発表",
    "  - nintendodirect",
    '  - "re:(^|[^a-z])direct([^a-z]|$)"   # 各社の Direct',
    "  # スポーツ",
    "  - 競馬",
    "  - 日本ダービー        # ダービー単体は入れない",
    "  # ライブ・楽曲（ゲート2で見つかったもの）",
    "  - ソロライブ",
    "next_key:",
    "  - x",
  ].join("\n");
  const terms = ["nintendodirect", "re:(^|[^a-z])direct([^a-z]|$)", "競馬", "日本ダービー", "ソロライブ"];
  const m = notAWorkGroups(yaml, terms);
  assert.equal(m.get("re:(^|[^a-z])direct([^a-z]|$)"), "ゲーム・企業の発表");
  assert.equal(m.get("日本ダービー"), "スポーツ");
  assert.equal(m.get("ソロライブ"), "ライブ・楽曲");
  assert.throws(() => notAWorkGroups(yaml, terms.slice(1)));
  assert.equal(stratumOf({ type: "not_a_work_rule", sub: "スポーツ" }), "not_a_work_rule:スポーツ");
  assert.equal(stratumOf({ type: "redirect", sub: null }), "redirect");
});

test("型: 作品ではない語に当たっても、区間が作品に当たる枠は AI に回す型にする", () => {
  assert.equal(classifyRoute(facts({ unresolvedReason: "not_a_work", notAWorkConflict: true })), "not_a_work_conflict");
  assert.equal(classifyRoute(facts({ unresolvedReason: "not_a_work", notAWorkConflict: false })), "not_a_work_rule");
});

test("サイトでの出し方: AI に回す型の枠は AI が確かめるまで出さない（保留も）。確定の判定が先", () => {
  const routes = ["redirect", "unresolved", "not_a_work_rule:スポーツ"];
  const base = { sub: null, ai: null, hasWorks: false, unresolvedReason: null };
  assert.equal(publishState({ ...base, type: "redirect", hasWorks: true }, routes), "pending_ai");
  assert.equal(publishState({ ...base, type: "redirect", hasWorks: true, ai: { status: "hold", confidence: "low" } }, routes), "pending_ai");
  assert.equal(publishState({ ...base, type: "redirect", hasWorks: true, ai: { status: "identified", confidence: "high" } }, routes), "work");
  assert.equal(publishState({ ...base, type: "unique_exact", hasWorks: true }, routes), "work");
  assert.equal(publishState({ ...base, type: "not_a_work_rule", sub: "スポーツ", unresolvedReason: "not_a_work" }, routes), "pending_ai");
  assert.equal(publishState({ ...base, type: "not_a_work_rule", sub: "eスポーツ・大会", unresolvedReason: "not_a_work" }, routes), "hidden");
  assert.equal(publishState({ ...base, type: "unresolved", ai: { status: "not_in_db", confidence: "high" } }, routes), "frame");
  assert.equal(publishState({ ...base, type: "unresolved", ai: { status: "identified", confidence: "low" } }, routes), "frame");
  assert.equal(publishState({ ...base, type: null, hasWorks: true }, routes), "pending_ai");
  assert.equal(needsAi({ type: "not_a_work_rule", sub: "スポーツ" }, routes), true);
});

test("サイトでの出し方: 予定枠・配信中の枠は、AI の判定待ちでも枠として出す（作品ではない語に当たった枠・型なしは出さない）", () => {
  const routes = ["redirect", "unresolved", "not_a_work_conflict", "not_a_work_rule:スポーツ"];
  const base = { sub: null, ai: null, hasWorks: false, unresolvedReason: null };
  // 判定待ちの予定枠・配信中の枠は枠として出す。終わったら判定するまで出さない
  assert.equal(publishState({ ...base, type: "unresolved", unresolvedReason: "not_found", eventStatus: "upcoming" }, routes), "frame");
  assert.equal(publishState({ ...base, type: "redirect", hasWorks: true, eventStatus: "live" }, routes), "frame");
  assert.equal(publishState({ ...base, type: "redirect", hasWorks: true, eventStatus: "completed" }, routes), "pending_ai");
  assert.equal(publishState({ ...base, type: "redirect", hasWorks: true, ai: { status: "hold", confidence: "low" }, eventStatus: "upcoming" }, routes), "frame");
  // 決まっている枠は予定枠でも同じ
  assert.equal(publishState({ ...base, type: "unique_exact", hasWorks: true, eventStatus: "upcoming" }, routes), "work");
  assert.equal(publishState({ ...base, type: "unresolved", ai: { status: "not_a_work", confidence: "high" }, eventStatus: "upcoming" }, routes), "hidden");
  assert.equal(publishState({ ...base, type: "not_a_work_rule", sub: "eスポーツ・大会", unresolvedReason: "not_a_work", eventStatus: "upcoming" }, routes), "hidden");
  // ルールが作品ではない語に当てた枠と、まだ名寄せしていない枠は、予定枠でも判定を待つ
  assert.equal(publishState({ ...base, type: "not_a_work_conflict", unresolvedReason: "not_a_work", eventStatus: "upcoming" }, routes), "pending_ai");
  assert.equal(publishState({ ...base, type: "not_a_work_rule", sub: "スポーツ", unresolvedReason: "not_a_work", eventStatus: "live" }, routes), "pending_ai");
  assert.equal(publishState({ ...base, type: null, eventStatus: "upcoming" }, routes), "pending_ai");
});

test("判定役に見せる手がかり: 同じ作品名の枠（日付順・この枠の位置）と前後の枠、リンク先の題名", async () => {
  const { frameContext, pageTitle, pickLinks } = await import("../src/report/neighbors.ts");
  const { loadExtractConfig } = await import("../src/resolve/config.ts");
  const cfg = loadExtractConfig();
  const f = (id: number, title: string) => ({ id, date: `2025-01-${String(id).padStart(2, "0")}`, title });
  const frames = [
    f(1, "【メン限】『リメンバー・ミー』 同時視聴する"),
    f(2, "【 メン限/同時視聴 】「 刃牙（バキ） 」第1話～第4話"),
    f(3, "【メン限】『ターザン』 同時視聴する"),
    f(4, "【 メン限/同時視聴 】「 刃牙（バキ） 」第5話～第7話"),
    f(5, "【メン限】『ベイマックス』 同時視聴する"),
    f(6, "【 メン限/同時視聴 】「 刃牙（バキ） 」第23話～第26話（ 終 ）"),
  ];
  const c = frameContext(frames, 2, frames[1]!.title, cfg);
  assert.deepEqual(c.sameName.map((x) => [x.id, !!x.self]), [[2, true], [4, false], [6, false]]);
  assert.deepEqual(c.around.map((x) => x.id), [1, 3, 5]);
  const t = frameContext(frames, 3, frames[2]!.title, cfg);
  assert.equal(t.sameName.length, 0);
  assert.deepEqual(t.around.map((x) => x.id), [1, 2, 4, 5, 6]);
  // ページの題名（og:title を先に。ゼロ幅の文字を落とす）
  assert.equal(pageTitle('<meta property="og:title" content="ドラゴンクエスト ダイの大冒険\uFEFFを観\uFEFFる | Netflix"><title>x</title>'), "ドラゴンクエスト ダイの大冒険を観る | Netflix");
  assert.equal(pageTitle("<title>Amazon.co.jp: ロスト・ワールド／ジュラシック・パーク (吹替版)を観る | Prime Video</title>"), "Amazon.co.jp: ロスト・ワールド／ジュラシック・パーク (吹替版)を観る | Prime Video");
  // 公開年とあらすじ（Amazon の releaseYear・meta description）
  const { pageInfo } = await import("../src/report/neighbors.ts");
  assert.deepEqual(pageInfo('<title>Amazon.co.jp: 君に届けを観る | Prime Video</title><meta name="description" content="黒沼爽子は、見た目が暗く">{"releaseYear":2010}'),
    { title: "Amazon.co.jp: 君に届けを観る | Prime Video", year: 2010, summary: "黒沼爽子は、見た目が暗く" });
  // 題名を取りに行くリンク（配信サービス・映画情報サイトだけ）
  assert.deepEqual(pickLinks(["https://www.amazon.co.jp/gp/video/detail/B01BODDI64/ref=x", "https://twitter.com/a", "https://www.disneyplus.com/ja-jp/movies/x/1"], cfg),
    ["https://www.amazon.co.jp/gp/video/detail/B01BODDI64/ref=x"]);
});

test("判定役に見せる手がかり: 同時視聴枠にならなかった動画（同じ作品名の動画・メン限の枠の前後のメン限の動画）", async () => {
  const { streamerFrames, streamerVideos, otherVideos } = await import("../src/report/neighbors.ts");
  const { loadExtractConfig } = await import("../src/resolve/config.ts");
  const { openDb } = await import("../src/lib/db.ts");
  const cfg = loadExtractConfig();
  const db = openDb(":memory:");
  db.exec(`INSERT INTO streamers (id, name, affiliation, channel_id, tier, first_seen_at, updated_at) VALUES (1, 'ルカ・カネシロ', 'nijisanji', 'UCx', 1, 'n', 'n')`);
  const ev = db.prepare(`INSERT INTO watch_events (streamer_id, video_id, title_raw, url, status, is_members_only, started_at, excluded_at, detected_at, detect_source, detect_keyword, found_via, updated_at)
    VALUES (1, ?, ?, 'u', 'completed', ?, ?, ?, 'n', 'title', 'k', 'rss', 'n')`);
  const seen = db.prepare(`INSERT INTO videos_seen (video_id, channel_id, title, published_at, first_seen_at, first_seen_via, last_seen_at, detect_result, detect_version, is_members_hint)
    VALUES (?, 'UCx', ?, ?, 'n', 'rss', 'n', 'miss', 'v', ?)`);
  const tail = "【NIJISANJI EN | Luca Kaneshiro】";
  const frame = (vid: string, title: string, at: string, members: number, excluded: string | null = null) => {
    ev.run(vid, title, members, at, excluded);
    seen.run(vid, title, at, members);
  };
  frame("a1", `【MEMBERSHIP STREAM】ARCANE WATCHALONG PART 1${tail}`, "2024-12-21T10:00:00Z", 1);
  frame("a4", `【MEMBERSHIP STREAM】ARCANE WATCHALONG EPISODE 7 AND 8 AND MAYBE 9?${tail}`, "2025-01-11T10:00:00Z", 1);
  frame("air", "【同時視聴】「AIR」最終回までみる", "2025-02-10T10:00:00Z", 0);
  // 判定から外した枠は「同時視聴枠でない動画」に入る
  frame("x1", `【MEMBERSHIP STREAM】ARCANE RECAP${tail}`, "2025-02-01T10:00:00Z", 1, "2025-03-01T00:00:00Z");
  seen.run("s2", `【MEMBERSHIP STREAM】STARTING SEASON 2 HELL YEEEE${tail}`, "2025-01-17T10:00:00Z", 1);
  seen.run("s3", `【MEMBERSHIP STREAM】SEASON 2 EPISODE 3 AND 4${tail}`, "2025-01-23T10:00:00Z", 1);
  seen.run("fin", `【MEMBERSHIP STREAM】FINISHING ARCANE ONCE AND FOR ALL${tail}`, "2025-03-15T10:00:00Z", 1);
  seen.run("old", `【MEMBERSHIP STREAM】chat${tail}`, "2024-10-01T10:00:00Z", 1);
  seen.run("dbz", `【DRAGON BALL Z: KAKAROT】PART 1 TURNING SUPER SAIYAN${tail}`, "2024-12-22T10:00:00Z", 0);
  seen.run("cl", "SisterCleaire un♡Live", "2025-02-11T10:00:00Z", 0);
  seen.run("air5", "AIR 第5話から 感想", "2025-02-12T10:00:00Z", 0);
  for (let i = 0; i < 12; i++) seen.run(`apex${i}`, `【APEX】ランク #${i}`, `2025-02-${String(i + 1).padStart(2, "0")}T10:00:00Z`, 0);
  frame("ap", "【APEX】ALGS 決勝を同時視聴", "2025-02-20T10:00:00Z", 0);

  const videos = streamerVideos({ db }, cfg)(1);
  const titles = (xs: { title: string }[]) => xs.map((x) => x.title.replace(tail, ""));
  // 同時視聴枠（判定から外した枠を除く）は入れない
  assert.ok(!videos.some((v) => /WATCHALONG|「AIR」|ALGS/.test(v.title)));
  assert.ok(videos.some((v) => v.title.includes("ARCANE RECAP")));
  const frames = streamerFrames({ db })(1);
  const of = (title: string, startedAt: string, membersOnly: boolean, c = cfg) => otherVideos(videos, frames, { startedAt, title, membersOnly }, c, "ルカ・カネシロ");

  // PART 1: 同じ作品名の動画は期間を限らない。メン限の動画は前後30日（s2 は27日後、s3 は33日後）。
  // 「STREAM」「PART 1」は作品名でない区間（ignore_keys）なので、ほかのメン限の動画・ゲームの「PART 1」には当てない
  const p1 = of(`【MEMBERSHIP STREAM】ARCANE WATCHALONG PART 1${tail}`, "2024-12-21T10:00:00Z", true);
  assert.deepEqual(titles(p1.sameName), ["【MEMBERSHIP STREAM】ARCANE RECAP", "【MEMBERSHIP STREAM】FINISHING ARCANE ONCE AND FOR ALL"]);
  assert.deepEqual(titles(p1.members), ["【MEMBERSHIP STREAM】STARTING SEASON 2 HELL YEEEE"]);
  // EPISODE 7〜9: 同じ作品名の動画に出したもの（ARCANE RECAP）はメン限の動画に重ねない
  const p4 = of(`【MEMBERSHIP STREAM】ARCANE WATCHALONG EPISODE 7 AND 8 AND MAYBE 9?${tail}`, "2025-01-11T10:00:00Z", true);
  assert.deepEqual(titles(p4.members), ["【MEMBERSHIP STREAM】STARTING SEASON 2 HELL YEEEE", "【MEMBERSHIP STREAM】SEASON 2 EPISODE 3 AND 4"]);
  // 件数の上限はこの枠に近いものから
  const one = { ...cfg, ai_context: { ...cfg.ai_context, other_videos: { ...cfg.ai_context?.other_videos, same_name: 1, members: 0 } } };
  const p1one = of(`【MEMBERSHIP STREAM】ARCANE WATCHALONG PART 1${tail}`, "2024-12-21T10:00:00Z", true, one);
  assert.deepEqual(titles(p1one.sameName), ["【MEMBERSHIP STREAM】ARCANE RECAP"]);
  assert.equal(p1one.members.length, 0);
  // 公開の枠はメン限の動画を見せない。英数字のキーは単語の切れ目で照合する（「AIR」を「SisterCleaire」に当てない）
  const air = of("【同時視聴】「AIR」最終回までみる", "2025-02-10T10:00:00Z", false);
  assert.deepEqual(titles(air.sameName), ["AIR 第5話から 感想"]);
  assert.equal(air.members.length, 0);
  // チャンネルの動画の3%を超える動画（10本以上）に出る区間は決まり文句として使わない
  assert.equal(of("【APEX】ALGS 決勝を同時視聴", "2025-02-20T10:00:00Z", false).sameName.length, 0);
});

test("判定役に見せる手がかり: 概要欄の YouTube のリンク（動画・再生リストの読み取り、自分のチャンネルの除外、消えた動画、件数）", async () => {
  const { parseYouTube, youtubeRefs, youtubeLinks } = await import("../src/report/neighbors.ts");
  const { formatYouTube } = await import("../src/report/blind.ts");
  const { loadDetectConfig } = await import("../src/lib/config.ts");
  const cfg = loadExtractConfig();
  const dc = loadDetectConfig();
  // 読み取り: watch?v=…&list=… は両方。youtu.be・live・shorts・playlist。末尾に続いた文字は落とす。チャンネル・メンバーシップのリンクは読まない
  assert.deepEqual(parseYouTube("https://www.youtube.com/watch?v=-cMFTGPphmQ&list=PLBE2D9BnJJUqH_pqsO8ygJVCES1uK8WMM"),
    { url: "https://www.youtube.com/watch?v=-cMFTGPphmQ&list=PLBE2D9BnJJUqH_pqsO8ygJVCES1uK8WMM", video: "-cMFTGPphmQ", playlist: "PLBE2D9BnJJUqH_pqsO8ygJVCES1uK8WMM" });
  assert.equal(parseYouTube("https://youtu.be/AxKtVcMNpzY?si=x")?.video, "AxKtVcMNpzY");
  assert.equal(parseYouTube("https://youtube.com/live/dW_UL7tEbk8?feature=share")?.video, "dW_UL7tEbk8");
  assert.equal(parseYouTube("https://m.youtube.com/shorts/9x-wtNt8BaA")?.video, "9x-wtNt8BaA");
  assert.equal(parseYouTube("https://youtu.be/AxKtVcMNpzY】")?.video, "AxKtVcMNpzY");
  assert.deepEqual(parseYouTube("https://youtube.com/playlist?list=PL6gUpTCMieF&si=y"), { url: "https://youtube.com/playlist?list=PL6gUpTCMieF&si=y", video: null, playlist: "PL6gUpTCMieF" });
  assert.equal(parseYouTube("https://www.youtube.com/channel/UC48jH1ul-6HOrcSSfoR02fQ/join"), null);
  assert.equal(parseYouTube("https://www.youtube.com/@Yuuhi_Riri"), null);
  assert.equal(parseYouTube("https://youtu.be/short"), null);
  // 出てくる順。同じ動画は1つ
  const refs = youtubeRefs([
    "公式チャンネルで視聴しています。 https://youtu.be/gone0000001",
    "MV https://youtu.be/selfMV00001",
    "前回 https://youtube.com/live/selfPrev001",
    "https://youtube.com/playlist?list=PLself",
    "https://www.youtube.com/watch?v=gone0000001&t=10",
    "コラボ相手 https://www.youtube.com/watch?v=partner0001&list=RDmix",
    "https://youtu.be/other000001",
  ]);
  assert.deepEqual(refs.map((r) => r.video ?? r.playlist), ["gone0000001", "selfMV00001", "selfPrev001", "PLself", "partner0001", "other000001"]);
  const i = (title: string, channelId: string, channel = "") => ({ title, channelId, channel, date: "2022-11-20" });
  const info = {
    videos: new Map([
      ["gone0000001", null],
      ["selfMV00001", i("【MV】月明かり / セフィナ (Official)", "UCself")],
      ["selfPrev001", i("【同時視聴】初見！二期！コードギアス反逆のルルーシュ ２０話２１話 #10", "UCself")],
      ["partner0001", i("【同時視聴】ゴースト＆レディを観劇させていただきます", "UCpartner", "東堂コハク")],
      ["other000001", i("【公式】アニメ「ポケットモンスター」第1話", "UCpoke", "ポケモン公式YouTubeチャンネル")],
    ]),
    playlists: new Map([["PLself", i("同時視聴(映画コマンドー)", "UCself")], ["RDmix", null]]),
  };
  // 自分のチャンネルは題名が同時視聴の語に当たるものだけ（MV は除く）。消えた動画は見せる。取れなかった再生リスト（RD のミックス）は添えない。上限は youtube_links（3）
  const links = youtubeLinks(refs, info, "UCself", cfg, dc);
  assert.deepEqual(links.map((l) => [l.video === undefined ? l.playlist?.title : l.video?.title ?? null, !!(l.video ?? l.playlist)?.self]), [
    [null, false], ["【同時視聴】初見！二期！コードギアス反逆のルルーシュ ２０話２１話 #10", true], ["同時視聴(映画コマンドー)", true],
  ]);
  const five = { ...cfg, ai_context: { ...cfg.ai_context, youtube_links: 5 } };
  const all = youtubeLinks(refs, info, "UCself", five, dc);
  assert.equal(all.length, 5);
  assert.equal(all[3]!.playlist, undefined);
  assert.equal(youtubeLinks(refs, info, "UCself", { ...cfg, ai_context: { ...cfg.ai_context, youtube_links: 0 } }, dc).length, 0);
  // 書き方
  assert.equal(formatYouTube(links[0]!), "https://youtu.be/gone0000001 → 動画は取れなかった（消えたか非公開）");
  assert.equal(formatYouTube(all[4]!), "https://youtu.be/other000001 → 動画「【公式】アニメ「ポケットモンスター」第1話」（ポケモン公式YouTubeチャンネル・2022-11-20）");
  assert.equal(formatYouTube({ url: "u", video: null, playlist: { title: "アニポケセレクション", channel: "ポケモン公式YouTubeチャンネル", date: "2020-10-05" } }),
    "u → 動画は取れなかった（消えたか非公開）・再生リスト「アニポケセレクション」（ポケモン公式YouTubeチャンネル・作成 2020-10-05）");
  assert.equal(formatYouTube(links[2]!), "https://youtube.com/playlist?list=PLself → 再生リスト「同時視聴(映画コマンドー)」（この配信者のチャンネル・作成 2022-11-20）");
});

test("判定役に見せる概要欄: URL で始まる行は除くが、題名を見せるリンクの行は残す（定型文は除いたまま）", async () => {
  const { descriptionReader } = await import("../src/report/blind.ts");
  const { loadDetectConfig } = await import("../src/lib/config.ts");
  const { openDb } = await import("../src/lib/db.ts");
  const db = openDb(":memory:");
  const detectCfg = loadDetectConfig();
  db.exec(`INSERT INTO streamers (id, name, affiliation, channel_id, tier, first_seen_at, updated_at) VALUES (1, '夕陽リリ', 'nijisanji', 'UCx', 1, 'n', 'n')`);
  const ev = db.prepare(`INSERT INTO watch_events (streamer_id, video_id, title_raw, url, status, is_members_only, description_raw, detected_at, detect_source, detect_keyword, found_via, updated_at)
    VALUES (1, ?, 't', 'u', 'completed', 1, ?, 'n', 'title', 'k', 'rss', 'n')`);
  const tpl = "■スポンサー登録はこちらから\nhttps://www.youtube.com/channel/UCx/join";
  const target = `公式チャンネルで視聴しています。\nhttps://www.youtube.com/watch?v=-cMFTGPphmQ&list=PLBE\nhttps://twitter.com/x\n${tpl}`;
  ev.run("v1", target);
  for (let k = 2; k <= detectCfg.description.template_min_repeats + 1; k++) ev.run(`v${k}`, `雑談\n${tpl}`);
  const desc = descriptionReader({ db, detectCfg } as never);
  assert.deepEqual(desc(1, target), ["公式チャンネルで視聴しています。"]);
  assert.deepEqual(desc(1, target, ["https://www.youtube.com/watch?v=-cMFTGPphmQ&list=PLBE"]),
    ["公式チャンネルで視聴しています。", "https://www.youtube.com/watch?v=-cMFTGPphmQ&list=PLBE"]);
  // 題名を取りに行く行には URL だけの行も入る（定型文の行は入らない）
  assert.deepEqual(desc.links(1, target), ["https://www.youtube.com/watch?v=-cMFTGPphmQ&list=PLBE", "https://twitter.com/x"]);
});

test("採点の書き出しから採点済みの枠を読む（「（未）」は採点済みにしない）", async () => {
  const { scoredVideos } = await import("../src/report/ai.ts");
  const md = "# 採点\n\n## 同定\n\n### 1. aaa　型 同定\n- タイトル: x\n- 採点: 正しい\n- メモ: \n\n### 2. bbb　型 同定\n- タイトル: y\n- 採点: （未）\n- メモ: \n\n## 保留\n\n### 1. ccc　型 保留\n- 採点: 誤り\n- メモ: z\n";
  assert.deepEqual(scoredVideos(md), ["aaa", "ccc"]);
  assert.deepEqual(scoredVideos(md, true), ["bbb"]);
});
