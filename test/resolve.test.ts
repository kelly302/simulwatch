import { test } from "node:test";
import assert from "node:assert/strict";
import { pick } from "../src/resolve/resolve.ts";
import type { Plan, Outcome } from "../src/resolve/resolve.ts";
import { extract } from "../src/resolve/extract.ts";
import { loadExtractConfig } from "../src/resolve/config.ts";
import type { WorkCandidate } from "../src/resolve/types.ts";

const cfg = loadExtractConfig();
const work = (id: number, title: string): WorkCandidate => ({
  source: "annict", sourceKey: `annict:${id}`, annictId: id, anilistId: null, wikidataId: null, malId: null,
  title, titleKana: null, titles: [title], media: "movie", seasonName: null, releaseYear: null, episodesCount: null, imageUrl: null, seriesId: null,
});
const plan = (title: string): Plan => ({ target: { id: 1, video_id: "v", title_raw: title, description_raw: null }, ex: extract(title, cfg), desc: [] });
const match = (w: WorkCandidate): Outcome => ({ kind: "match", work: w, method: "exact", source: "annict" });

test("括弧の中身で作品が決まれば、括弧の外の区間（配信者の決まり文句など）は採用しない", () => {
  const p = plan("【同時視聴】王覇山軍「天気の子」");
  // 別の枠のために「王覇山軍」が照会され、何かの作品に当たってしまった場合でも
  const outcomes = new Map<string, Outcome>([["天気の子", match(work(1, "天気の子"))], ["王覇山軍", match(work(2, "王覇山軍"))]]);
  const r = pick(p, outcomes);
  assert.deepEqual(r.picked.map((x) => x.work.annictId), [1]);
});

test("括弧の中身で決まらなければ、括弧の外の区間を使う", () => {
  const p = plan("【同時視聴】天気の子「今日は雨」");
  const outcomes = new Map<string, Outcome>([["今日は雨", { kind: "none" }], ["天気の子", match(work(1, "天気の子"))]]);
  assert.deepEqual(pick(p, outcomes).picked.map((x) => x.work.annictId), [1]);
});

test("区間で決まれば小区間は使わない（部分的な一致で別作品を足さない）", () => {
  const p = plan("【同時視聴】仮面ライダーセイバー＆キラメイジャー");
  const outcomes = new Map<string, Outcome>([
    ["仮面ライダーセイバー&キラメイジャー", { kind: "none" }],
    ["仮面ライダーセイバー", match(work(3, "仮面ライダーセイバー"))],
    ["キラメイジャー", match(work(4, "魔進戦隊キラメイジャー"))],
  ]);
  const r = pick(p, outcomes);
  assert.deepEqual(r.picked.map((x) => x.work.annictId).sort(), [3, 4]);
  assert.ok(r.picked.every((x) => x.from === "sub"));
});
