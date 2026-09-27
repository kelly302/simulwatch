import { test } from "node:test";
import assert from "node:assert/strict";
import { decideRun, toRunEvent, counterOf, familyOf } from "../src/resolve/series.ts";
import { loadExtractConfig } from "../src/resolve/config.ts";
import { matchKey } from "../src/resolve/normalize.ts";
import type { WorkCandidate } from "../src/resolve/types.ts";

const cfg = loadExtractConfig();
const season = (id: number, title: string, eps: number, seasonName: string, media: WorkCandidate["media"] = "tv"): WorkCandidate => ({
  source: "annict", sourceKey: `annict:${id}`, annictId: id, anilistId: null, wikidataId: null, malId: null,
  title, titleKana: null, titles: [title], media, seasonName, releaseYear: Number(seasonName.slice(0, 4)), episodesCount: eps, imageUrl: null, seriesId: null,
});
const run = (b: string, seasons: WorkCandidate[], titles: string[], start = "2026-03-01") =>
  ({
    b: matchKey(b, cfg),
    seasons,
    evs: titles.map((t, i) => toRunEvent({ id: i + 1, title: t, startedAt: new Date(Date.parse(start) + i * 7 * 86_400_000).toISOString(), text: b }, cfg)),
  });
const show = (d: ReturnType<typeof decideRun>) => d.map((x) => (x ? `${x.seasons.map((i) => i + 1).join("+")}:${x.rule}` : "保留"));

const JUJUTSU = [season(1, "呪術廻戦", 24, "2020-autumn"), season(2, "呪術廻戦 懐玉・玉折／渋谷事変", 25, "2023-summer"), season(3, "呪術廻戦 死滅回游 前編", 13, "2026-winter")];

test("配信の回数: 「#2」は数え、ハッシュタグ（「#2周年」「#生スバル」）は数えない", () => {
  assert.equal(counterOf("【#2】ひぐらしのなく頃に　同時視聴会"), 2);
  assert.equal(counterOf("【Membership】# 3 葬送のフリーレン同時視聴"), 3);
  assert.equal(counterOf("【#生スバル】ひぐらしのなく頃に"), null);
  assert.equal(counterOf("#2周年 同時視聴"), null);
});

test("1話から観始めた系列は1期。回数が続けば同じ期、「最終回」までその期。「２期」「３期」は放送順（星川サラの呪術廻戦）", () => {
  const r = run("呪術廻戦", JUJUTSU, [
    "【完全初見】今日から呪術廻戦！アニメ同時視聴する！#1【星川サラ/にじさんじ】",
    "【完全初見】呪術廻戦！アニメ同時視聴する！#2【星川サラ/にじさんじ】",
    "【完全初見】呪術廻戦！アニメ同時視聴する！#3【星川サラ/にじさんじ】",
    "【完全初見】呪術廻戦！アニメ同時視聴する！#4【星川サラ/にじさんじ】",
    "【完全初見】最終回まで！呪術廻戦 アニメ同時視聴する！#5【星川サラ/にじさんじ】",
    "【完全初見】今日から呪術廻戦２期！アニメ同時視聴する！#6【星川サラ/にじさんじ】",
    "【完全初見】今日から呪術廻戦３期 アニメ同時視聴する！#11【星川サラ/にじさんじ】",
  ]);
  assert.deepEqual(show(decideRun(r, cfg)), ["1:start", "1:continue", "1:continue", "1:continue", "1:continue:final", "2:ordinal", "3:ordinal"]);
});

test("番号の無い最初の枠は、次の枠が「#2」なら1期", () => {
  const r = run("ひぐらしのなく頃に", [season(1, "ひぐらしのなく頃に", 26, "2006-spring"), season(2, "ひぐらしのなく頃に解", 24, "2007-summer")], [
    "【#生スバル】ひぐらしのなく頃に　同時視聴会",
    "【#2】ひぐらしのなく頃に　同時視聴会",
    "【#最終回】ひぐらしのなく頃に　同時視聴会",
  ]);
  assert.deepEqual(show(decideRun(r, cfg)), ["1:start:implicit", "1:continue", "1:continue:final"]);
});

test("手がかりの無い系列は保留（枠数から推定しない）", () => {
  const r = run("コードギアス反逆のルルーシュ", [season(1, "コードギアス 反逆のルルーシュ", 25, "2006-autumn"), season(2, "コードギアス 反逆のルルーシュ R2", 25, "2008-spring")], [
    "【 アニメ同時視聴/メン限 】コードギアス反逆のルルーシュ同時試聴【#みこ市長 】",
    "【 アニメ同時視聴/メン限 】コードギアス反逆のルルーシュ同時試聴【#みこ市長 】",
  ]);
  assert.deepEqual(show(decideRun(r, cfg)), ["保留", "保留"]);
});

test("通し番号で期をまたぐ枠は両方の期（0話がある作品は1つずらす）", () => {
  const r = run("Fate/stay night [Unlimited Blade Works]", [
    season(1, "Fate/stay night [Unlimited Blade Works]", 13, "2014-autumn"),
    season(2, "Fate/stay night [Unlimited Blade Works] 2ndシーズン", 13, "2015-spring"),
  ], [
    "【同時視聴】完全初見🔰Fate/stay night [Unlimited Blade Works]0話～3話",
    "【同時視聴】完全初見🔰Fate/stay night [Unlimited Blade Works]4話～8話",
    "【同時視聴】完全初見🔰Fate/stay night [Unlimited Blade Works]10話～11話",
    "【同時視聴】完全初見🔰Fate/stay night [Unlimited Blade Works]12話～15話",
  ]);
  assert.deepEqual(show(decideRun(r, cfg)), ["1:episodes:first", "1:episodes:same", "1:episodes:same", "1+2:episodes:through"]);
});

test("期の表記が系統のどの作品にも合わない枠は決めず、その後ろも続きにしない", () => {
  const seasons = [season(1, "進撃の巨人", 25, "2013-spring"), season(2, "進撃の巨人 Season 2", 12, "2017-spring")];
  const r = run("進撃の巨人", seasons, ["今日から進撃の巨人！#1", "進撃の巨人 Season 5 #2", "進撃の巨人 #3"]);
  assert.deepEqual(show(decideRun(r, cfg)), ["1:start", "保留", "保留"]);
});

test("系統: 総集編・新編集版は期に数えず、区間と原題が一致する作品を1期にする", () => {
  const ws = [
    season(3, "PSYCHO-PASS サイコパス 2", 11, "2014-autumn"),
    season(2, "PSYCHO-PASS サイコパス 新編集版", 11, "2014-summer"),
    season(1, "PSYCHO-PASS サイコパス", 22, "2012-autumn"),
    season(4, "劇場版 PSYCHO-PASS サイコパス", 1, "2015-winter", "movie"),
  ];
  assert.deepEqual(familyOf(ws, matchKey("PSYCHO-PASS サイコパス", cfg), cfg).map((w) => w.annictId), [1, 3]);
});

test("番号の無い最初の枠のすぐ次が途中の話数からなら、最初の枠も1期（start:gap）", () => {
  const r = run("STEINS;GATE", [season(1, "STEINS;GATE", 24, "2011-spring"), season(2, "STEINS;GATE 0", 23, "2018-spring")], [
    "初見！STEINS;GATE シュタゲアニメ同時視聴 ✦ 壱百満天原サロメですわ～",
    "初見！STEINS;GATE シュタゲアニメ同時視聴 ６話～ ✦ 壱百満天原サロメですわ～",
    "初見！STEINS;GATE シュタゲアニメ同時視聴 １１話～ ✦ 壱百満天原サロメですわ～",
    "初見！STEINS;GATE シュタゲアニメ同時視聴最終話まで！ ✦ 壱百満天原サロメですわ～",
  ]);
  assert.deepEqual(show(decideRun(r, cfg)), ["1:start:gap", "1:episodes:same", "1:episodes:same", "1:continue:final"]);
});

test("期の表記に合う作品が2つ以上（Season 3 の Part.1 と Part.2）なら決めない", () => {
  const r = run("進撃の巨人", [
    season(1, "進撃の巨人", 25, "2013-spring"), season(2, "進撃の巨人 Season 3 Part.1", 12, "2018-summer"), season(3, "進撃の巨人 Season 3 Part.2", 10, "2019-spring"),
  ], ["進撃の巨人 season1 #1", "進撃の巨人 season3 ep56から最後まで！"]);
  assert.deepEqual(show(decideRun(r, cfg)), ["1:marker", "保留"]);
});

test("系統の作品名に部の表記が無ければ、タイトルの「第3部」では止めない（区間がすでに第3部の副題）", () => {
  const r = run("ジョジョの奇妙な冒険 スターダストクルセイダース", [
    season(1, "ジョジョの奇妙な冒険 スターダストクルセイダース", 24, "2014-spring"), season(2, "ジョジョの奇妙な冒険 スターダストクルセイダース エジプト編", 24, "2015-winter"),
  ], ["『ジョジョの奇妙な冒険 第3部 スターダストクルセイダース』第1話～第7話", "『ジョジョの奇妙な冒険 第3部 スターダストクルセイダース』第23話～第29話"]);
  assert.deepEqual(show(decideRun(r, cfg)), ["1:episodes:first", "1+2:episodes:through"]);
});

test("丸数字は配信の回数（「ゆるキャン△②」）。「⑰話」は話数なので数えない", () => {
  assert.equal(counterOf("同時視聴 ｜ ゆるキャン△② ｜ アニメ同時視聴の会"), 2);
  assert.equal(counterOf("レイアース⑰話 同時視聴"), null);
});

test("「N期」はクールで分かれた作品をひとまとまりに数え、まとまりの中は期の中の話数で選ぶ（Dr.STONE 第3期 = NEW WORLD の2クール）", () => {
  const r = run("Dr.STONE", [
    season(1, "Dr.STONE", 24, "2019-summer"), season(2, "Dr.STONE STONE WARS", 11, "2021-winter"),
    season(3, "Dr.STONE NEW WORLD", 11, "2023-spring"), season(4, "Dr.STONE NEW WORLD 第2クール", 11, "2023-autumn"),
  ], ["Dr.STONE 第3期 1話～6話", "Dr.STONE 第3期 7話～11話", "Dr.STONE 第3期 12話～17話", "Dr.STONE 第3期"]);
  assert.deepEqual(show(decideRun(r, cfg)), ["3:ordinal", "3:ordinal", "4:ordinal", "保留"]);
});
