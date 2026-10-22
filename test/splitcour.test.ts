import { test } from "node:test";
import assert from "node:assert/strict";
import { loadExtractConfig } from "../src/resolve/config.ts";
import { continues, heads, isLaterTitle, mergedTitle, titlePairs } from "../src/resolve/splitcour.ts";
import { openDb } from "../src/lib/db.ts";
import { assignPublicKeys } from "../src/publish/keys.ts";
import type { WorkCandidate } from "../src/resolve/types.ts";

const sc = loadExtractConfig().split_cour!;
const w = (id: number, title: string, seasonName: string, media: WorkCandidate["media"] = "tv"): WorkCandidate => ({
  source: "annict", sourceKey: `annict:${id}`, annictId: id, anilistId: null, wikidataId: null, malId: null,
  title, titleKana: null, titles: [title], media, seasonName, releaseYear: Number(seasonName.slice(0, 4)), episodesCount: null, imageUrl: null, seriesId: null,
});
const pairs = (ws: WorkCandidate[]) => titlePairs(ws, sc).map(([a, b]) => `${a.annictId}>${b.annictId}`);

test("分割クールの作品名: 前の作品名＋後半の表記", () => {
  assert.ok(isLaterTitle("Fate/Zero 1stシーズン", "Fate/Zero 2ndシーズン", sc));
  assert.ok(isLaterTitle("機動戦士ガンダム 水星の魔女 Season1", "機動戦士ガンダム 水星の魔女 Season2", sc));
  assert.ok(isLaterTitle("Fate/stay night [Unlimited Blade Works]", "Fate/stay night [Unlimited Blade Works] 2ndシーズン", sc));
  assert.ok(isLaterTitle("ウマ娘 シンデレラグレイ", "ウマ娘 シンデレラグレイ 第2クール", sc));
  assert.ok(isLaterTitle("地獄先生ぬ〜べ〜 (2025)", "地獄先生ぬ〜べ〜 第2クール", sc));
  assert.ok(isLaterTitle("うしおととら", "うしおととら (第2シーズン)", sc));
  assert.ok(isLaterTitle("進撃の巨人 Season 3 Part.1", "進撃の巨人 Season 3 Part.2", sc));
  assert.ok(isLaterTitle("進撃の巨人 The Final Season 完結編（前編）", "進撃の巨人 The Final Season 完結編（後編）", sc));
  assert.ok(isLaterTitle("Re:ゼロから始める異世界生活 2nd season", "Re:ゼロから始める異世界生活 2nd season 第2部", sc));
  assert.ok(isLaterTitle("絆のアリル", "絆のアリル セカンドシーズン", sc));
  // 本当の2期・別の作品
  assert.ok(!isLaterTitle("ゴールデンカムイ", "ゴールデンカムイ 第2期", sc));
  assert.ok(!isLaterTitle("わたしが恋人になれるわけないじゃん、ムリムリ!（※ムリじゃなかった!?）", "わたしが恋人になれるわけないじゃん、ムリムリ!（※ムリじゃなかった!?）続編", sc));
  assert.ok(!isLaterTitle("BLEACH 千年血戦篇", "BLEACH 千年血戦篇ｰ訣別譚ｰ", sc));
  assert.ok(!isLaterTitle("Re:ゼロから始める異世界生活 新編集版", "Re:ゼロから始める異世界生活 2nd season", sc));
});

test("分割クールの組: 放送の間は3期まで。本当の2期（1年後の 2nd Season）はまとめない", () => {
  assert.deepEqual(pairs([w(1855, "Fate/Zero 1stシーズン", "2011-autumn"), w(1856, "Fate/Zero 2ndシーズン", "2012-spring")]), ["1855>1856"]);
  assert.deepEqual(pairs([w(1, "MFゴースト", "2023-autumn"), w(2, "MFゴースト 2nd Season", "2024-autumn")]), []);
  assert.deepEqual(pairs([w(1, "その着せ替え人形は恋をする", "2022-winter"), w(2, "その着せ替え人形は恋をする Season 2", "2025-summer")]), []);
  // 劇場版・放送期の無い作品は見ない
  assert.deepEqual(pairs([w(1, "X", "2020-spring"), w(2, "X 第2クール", "2020-autumn", "movie")]), []);
  assert.deepEqual(pairs([w(1, "X", "2020"), w(2, "X 第2クール", "2020-autumn")]), []);
  // シーズンを重ねる番組（後半の表記の作品が2つ以上）はまとめない
  assert.deepEqual(pairs([w(1, "スポンジ・ボブ(シーズン1)", "2000-winter"), w(2, "スポンジ・ボブ(シーズン2)", "2000-autumn"), w(3, "スポンジ・ボブ(シーズン3)", "2001-autumn")]), []);
});

test("分割クールの話の番号: 後半の最初の話が前半の最後の話の次（漢数字・#13 も読む）", () => {
  const ep = (...t: string[]) => t.map((x) => ({ number: null, numberText: x, title: null }));
  assert.ok(continues(ep("第一話", "第十三話"), ep("第十四話", "第二十五話")));
  assert.ok(continues(ep("Special Edition", "第1話", "第11話"), ep("第12話")));
  assert.ok(continues([{ number: 12, numberText: "#12", title: null }], ep("#13")));
  assert.ok(!continues(ep("#1", "#25"), ep("#01", "#25"))); // ガンダム00 2ND SEASON は1話から
  assert.ok(!continues(ep("第1話"), []));
  // 表記と number が食い違う（シンデレラガールズ 2nd SEASON の「第26話」は number が 0）ときは表記で読む
  assert.ok(continues(ep("第1話", "第13話"), [{ number: 14, numberText: "第14話", title: null }, { number: 0, numberText: "第26話", title: null }]));
});

test("分割クールのまとめ先は続けてたどる。作品名は前半の表記を外す", () => {
  assert.deepEqual([...heads([[1, 2], [2, 3], [5, 6]])].sort(), [[2, 1], [3, 1], [6, 5]]);
  assert.equal(mergedTitle("Fate/Zero 1stシーズン", sc), "Fate/Zero");
  assert.equal(mergedTitle("機動戦士ガンダム 水星の魔女 Season1", sc), "機動戦士ガンダム 水星の魔女");
  assert.equal(mergedTitle("進撃の巨人 Season 3 Part.1", sc), "進撃の巨人 Season 3");
  assert.equal(mergedTitle("進撃の巨人 The Final Season 完結編（前編）", sc), "進撃の巨人 The Final Season 完結編");
  assert.equal(mergedTitle("ウマ娘 シンデレラグレイ", sc), "ウマ娘 シンデレラグレイ");
});

test("公開キー: 分割クールでまとめた後半の作品のキーは、まとめ先へ 301", () => {
  const db = openDb(":memory:");
  assignPublicKeys(db, [{ id: 1, annictId: 1855, anilistId: 10087, wikidataId: null }, { id: 2, annictId: 1856, anilistId: 11741, wikidataId: null }], "t1");
  const r = assignPublicKeys(db, [{ id: 3, annictId: 1855, anilistId: 10087, wikidataId: null, splitAnnictIds: [1856] }], "t2");
  assert.equal(r.keys.get(3), "annict-1855");
  assert.deepEqual(r.redirects, [{ from: "/works/annict-1856/", to: "/works/annict-1855/" }]);
});
