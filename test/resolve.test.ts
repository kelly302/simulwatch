import { test } from "node:test";
import assert from "node:assert/strict";
import { pick, looksLikeMovieEvent } from "../src/resolve/resolve.ts";
import type { Plan, Outcome } from "../src/resolve/resolve.ts";
import { extract } from "../src/resolve/extract.ts";
import { loadExtractConfig } from "../src/resolve/config.ts";
import type { WorkCandidate } from "../src/resolve/types.ts";

const cfg = loadExtractConfig();
const work = (id: number, title: string): WorkCandidate => ({
  source: "annict", sourceKey: `annict:${id}`, annictId: id, anilistId: null, wikidataId: null, malId: null,
  title, titleKana: null, titles: [title], media: "movie", seasonName: null, releaseYear: null, episodesCount: null, imageUrl: null, seriesId: null,
});
const plan = (title: string): Plan => ({ target: { id: 1, video_id: "v", title_raw: title, description_raw: null, started_at: "2025-01-01T00:00:00Z" }, ex: extract(title, cfg), desc: [] });
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

test("枠の年より後に公開された作品には同定しない", () => {
  const p = plan("【同時視聴】「天気の子」");
  const future = { ...work(1, "天気の子"), releaseYear: 2030 };
  const r = pick(p, new Map<string, Outcome>([["天気の子", match(future)]]));
  assert.equal(r.picked.length, 0);
  assert.equal(r.ambiguous.length, 1);
});

test("括弧の外の区間で別々の作品が当たったら決めない（R2 の枠が英題の1期に当たった例）", () => {
  const p = plan("【R2】コードギアス反逆のルルーシュR２同時試聴：CODE GEASS Lelouch of the Rebellion");
  const segs = p.ex.segments.map((x) => x.text);
  const outcomes = new Map<string, Outcome>(segs.map((t, i) => [t, match(work(10 + i, t))]));
  const r = pick(p, outcomes);
  assert.equal(r.picked.length, 0);
  assert.ok(r.ambiguous.length > 0);
});

const cfgQ = loadExtractConfig().season_qualifiers.map((x) => new RegExp(x));

test("期を示す区間が残っていれば、シリーズ名だけの一致は採用しない", () => {
  const p = plan("【#15】進撃の巨人同時視聴しゅば！！！The Final Season ep84から！");
  const r = pick(p, new Map<string, Outcome>([["進撃の巨人", match({ ...work(1, "進撃の巨人"), media: "tv", episodesCount: 25 })]]), cfgQ);
  assert.equal(r.picked.length, 0);
});

test("話数が作品の話数を超えていれば採用しない", () => {
  const p = plan("【同時視聴】ドラゴンクエスト ダイの大冒険 ９１～９５話");
  const w = { ...work(1, "ドラゴンクエスト ダイの大冒険"), media: "tv" as const, episodesCount: 46 };
  assert.equal(pick(p, new Map<string, Outcome>([["ドラゴンクエスト ダイの大冒険", match(w)]]), cfgQ).picked.length, 0);
});

test("映画・劇場版の枠がテレビ作品に当たったら採用しない", () => {
  const p = plan("【Member Only】映画『 ベルサイユのばら 』 同時視聴");
  const w = { ...work(1, "ベルサイユのばら"), media: "tv" as const };
  assert.equal(pick(p, new Map<string, Outcome>([["ベルサイユのばら", match(w)]]), cfgQ).picked.length, 0);
});

test("和英併記の小区間は同じ作品の言い換え。先に当たった1つだけ採用する", () => {
  const p = plan("【メンバー限定配信】「アルマゲドン / Armageddon」同時視聴！");
  const outcomes = new Map<string, Outcome>([
    ["アルマゲドン / Armageddon", { kind: "none" }],
    ["アルマゲドン", match(work(1, "アルマゲドン"))],
    ["Armageddon", match(work(2, "아마게돈"))],
  ]);
  assert.deepEqual(pick(p, outcomes, cfgQ).picked.map((x) => x.work.annictId), [1]);
});

test("映画の枠の判定は注意書きの「映画」を見ない", () => {
  assert.equal(looksLikeMovieEvent("【SHT】ジオウ&リュウソウジャー同時視聴！※映画のネタバレ禁止【にじさんじ】"), false);
  assert.equal(looksLikeMovieEvent("【Member Only】映画『 ベルサイユのばら 』 同時視聴"), true);
  assert.equal(looksLikeMovieEvent("【完全初見】劇場版「空の境界」同時視聴する！"), true);
});

test("短い区間がより長い区間を差し置いて当たったら採用しない", () => {
  const p = plan("【劇場版Zガンダム同時視聴】劇場版のZガンダムみるぞ～～！3作目！！！ラスト！");
  const outcomes = new Map<string, Outcome>([["ラスト", match(work(1, "ラスト"))]]);
  assert.equal(pick(p, outcomes).picked.length, 0);
});

test("舞台の枠はどの作品にも同定しない", () => {
  const p = plan("【同時視聴】舞台「鬼滅の刃」を20周している鬼");
  assert.equal(pick(p, new Map<string, Outcome>([["鬼滅の刃", match(work(1, "鬼滅の刃"))]])).picked.length, 0);
});

test("放送期より前の枠には同定しない（2025年夏のアニメを2025年5月の枠に付けない）", () => {
  const w = { ...work(1, "カラオケ行こ！"), media: "tv" as const, releaseYear: 2025, seasonName: "2025-summer" };
  const may = { ...plan("【メン限】『カラオケ行こ！』 同時視聴する"), target: { id: 1, video_id: "v", title_raw: "【メン限】『カラオケ行こ！』 同時視聴する", description_raw: null, started_at: "2025-05-10T12:00:00Z" } };
  assert.equal(pick(may, new Map<string, Outcome>([["カラオケ行こ", match(w)]])).picked.length, 0);
  const jul = { ...may, target: { ...may.target, started_at: "2025-07-31T12:00:00Z" } };
  assert.equal(pick(jul, new Map<string, Outcome>([["カラオケ行こ", match(w)]])).picked.length, 1);
});
