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
