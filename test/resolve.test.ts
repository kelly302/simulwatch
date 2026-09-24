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
  const p = plan("【同時視聴】「今日は雨」｜天気の子");
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

test("括弧の外の区間で別々の作品が当たったら決めない", () => {
  const p = plan("【同時視聴】天気の子 王覇山軍");
  const outcomes = new Map<string, Outcome>([["天気の子 王覇山軍", { kind: "none" }]]);
  const q = plan("【同時視聴】天気の子｜君の名は。");
  const r = pick(q, new Map<string, Outcome>([["天気の子", match(work(1, "天気の子"))], ["君の名は", match(work(2, "君の名は。"))]]));
  assert.equal(r.picked.length, 0);
  assert.ok(r.ambiguous.length > 0);
  assert.equal(pick(p, outcomes).picked.length, 0);
});

test("タイトルに期の表記があれば、その期でない作品には同定しない（R2 の枠が英題の1期に当たった例）", () => {
  const p = plan("【R2】コードギアス反逆のルルーシュR２同時試聴：CODE GEASS Lelouch of the Rebellion");
  const r2 = { ...work(10, "コードギアス 反逆のルルーシュ R2"), media: "tv" as const };
  const s1 = { ...work(11, "コードギアス 反逆のルルーシュ"), media: "tv" as const, titles: ["コードギアス 反逆のルルーシュ", "CODE GEASS Lelouch of the Rebellion"] };
  const outcomes = new Map<string, Outcome>([
    ["コードギアス反逆のルルーシュR2", match(r2)],
    ["CODE GEASS Lelouch of the Rebellion", { ...match(s1), weak: true } as Outcome],
  ]);
  assert.deepEqual(pick(p, outcomes).picked.map((x) => x.work.annictId), [10]);
  // 「ウマ娘プリティーダービーSeason2」の枠が、英題で1期に当たっても採用しない
  const u = plan("【#4】ウマ娘プリティーダービーSeason2 同時視聴しゅばああああああ！：Umamusume: Pretty Derby【ホロライブ/大空スバル】");
  const s1u = { ...work(20, "ウマ娘 プリティーダービー"), media: "tv" as const, titles: ["ウマ娘 プリティーダービー", "Umamusume: Pretty Derby"] };
  assert.equal(pick(u, new Map<string, Outcome>([["Umamusume: Pretty Derby", { ...match(s1u), weak: true } as Outcome]])).picked.length, 0);
});

test("タイトルの期の表記と区間から、期の作品を選ぶ（「【ウマ娘プリティーダービー】season２」）", () => {
  const p = plan("【ウマ娘プリティーダービー】season２完全初見アニメ同時視聴💙#５");
  const s1 = { ...work(1, "ウマ娘 プリティーダービー"), media: "tv" as const };
  const s2 = { ...work(2, "ウマ娘 プリティーダービー Season 2"), media: "tv" as const };
  const o: Outcome = { ...match(s1), variants: new Map([["s2", [s2]]]) };
  assert.deepEqual(pick(p, new Map<string, Outcome>([["ウマ娘プリティーダービー", o]])).picked.map((x) => x.work.annictId), [2]);
});

test("英題だけの一致は、同じ枠の原題の一致で裏付けられなければ採用しない（Fate/Zero の英題が1期の作品にある）", () => {
  const z1 = { ...work(1, "Fate/Zero 1stシーズン"), media: "tv" as const, titles: ["Fate/Zero 1stシーズン", "Fate/Zero"] };
  const p = plan("【#2】Fate/Zero 同時視聴しゅばああ！！！：Fate/Zero watching party");
  assert.equal(pick(p, new Map<string, Outcome>([["Fate/Zero", { ...match(z1), weak: true } as Outcome]])).picked.length, 0);
  // 日本語の区間が原題で同じ作品に当たっていれば、英題の区間も同じ作品とみなす
  const re = { ...work(3, "Re:ゼロから始める異世界生活"), media: "tv" as const, titles: ["Re:ゼロから始める異世界生活", "Re:ZERO -Starting Life in Another World-"] };
  const q = plan("【＃生スバル】Re:ゼロから始める異世界生活 同時視聴：Re:ZERO -Starting Life in Another World-");
  const segs = q.ex.segments.map((x) => x.text);
  const outcomes = new Map<string, Outcome>([[segs[0]!, match(re)], [segs[1]!, { ...match(re), weak: true } as Outcome]]);
  assert.deepEqual(pick(q, outcomes).picked.map((x) => x.work.annictId), [3]);
});

test("部の表記: 副題で部が分かる作品はよい。シリーズ名だけの作品には付けない（ジョジョ3部を1部に付けない）", () => {
  const p1 = { ...work(1, "ジョジョの奇妙な冒険"), media: "tv" as const };
  const p3 = { ...work(3, "ジョジョの奇妙な冒険 スターダストクルセイダース"), media: "tv" as const };
  const cands = [p1, p3];
  const a = plan("『ジョジョの奇妙な冒険 第3部 スターダストクルセイダース』第8話～第15話");
  const r = pick(a, new Map<string, Outcome>([
    ["ジョジョの奇妙な冒険 第3部 スターダストクルセイダース", { kind: "none" }],
    ["ジョジョの奇妙な冒険 スターダストクルセイダース", { ...match(p3), cands }],
  ]));
  assert.deepEqual(r.picked.map((x) => x.work.annictId), [3]);
  const b = plan("『ジョジョの奇妙な冒険 第3部』");
  const r2 = pick(b, new Map<string, Outcome>([
    ["ジョジョの奇妙な冒険 第3部", { kind: "none" }],
    ["ジョジョの奇妙な冒険", { ...match(p1), cands }],
  ]));
  assert.equal(r2.picked.length, 0);
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

test("区間の年と公開年が違えば採用しない。番号の付いた区間は映画に付けない。ハッシュタグは推測の一致を使わない", () => {
  const g = plan("【メン限】『GODZILLA(2014) 吹替版』 同時視聴する");
  const g98 = { ...work(1, "GODZILLA"), releaseYear: 1998, source: "wikidata" as const };
  const gSeg = g.ex.segments[0]!;
  assert.equal(pick(g, new Map<string, Outcome>([[gSeg.subs.find((x) => x.text === "GODZILLA")!.text, match(g98)]])).picked.length, 0);
  const pc = plan("【パイカリ③】映画って本当に良くて・・・【同時視聴】");
  assert.equal(pick(pc, new Map<string, Outcome>([["パイカリ", match(work(2, "パイレーツ・オブ・カリビアン/呪われた海賊たち"))]])).picked.length, 0);
  const gt = plan("【Coca-Cola STAGE:0 公認ウォッチパーティー】#グランツーリスモ を一緒に見よう～～！！！");
  const gtWork = { ...work(3, "グランツーリスモ"), source: "wikidata" as const };
  const o: Outcome = { kind: "match", work: gtWork, method: "suffix", source: "wikipedia" };
  assert.equal(pick(gt, new Map<string, Outcome>([["グランツーリスモ", o]])).picked.length, 0);
});

test("副題の括弧が続く区間は、副題を含む作品にだけ同定する（ドラゴンボール超「ブロリー」をテレビシリーズにしない）", () => {
  const p = plan("【 同時視聴 】知識０と見るドラゴンボール超「ブロリー」観ていくぞ");
  const tv = { ...work(1, "ドラゴンボール超"), media: "tv" as const };
  const movie = work(2, "ドラゴンボール超 ブロリー");
  const r = pick(p, new Map<string, Outcome>([
    ["ブロリー", { kind: "none" }],
    ["知識0と見るドラゴンボール超", { kind: "none" }],
    ["ドラゴンボール超 ブロリー", match(movie)],
    ["ドラゴンボール超", match(tv)],
  ]));
  assert.deepEqual(r.picked.map((x) => x.work.annictId), [2]);
  const only = pick(p, new Map<string, Outcome>([["ドラゴンボール超", match(tv)]]));
  assert.equal(only.picked.length, 0);
});

test("照会先が違っても MyAnimeList の ID が同じなら同じ作品。英題の区間は日本語の短い区間を裏付ける", () => {
  const p = plan("【R2】コードギアス反逆のルルーシュR２同時試聴：CODE GEASS Lelouch of the Rebellion");
  const a = { ...work(10, "コードギアス 反逆のルルーシュ R2"), media: "tv" as const, malId: 2904 };
  const b = { ...a, source: "anilist" as const, sourceKey: "anilist:2904", annictId: null, anilistId: 2904 };
  const r = pick(p, new Map<string, Outcome>([["コードギアス反逆のルルーシュR2", match(a)], ["CODE GEASS Lelouch of the Rebellion", { ...match(b), source: "anilist" }]]));
  assert.equal(r.picked.length, 1);
  const n = plan("【#3】日常 同時視聴 / NICHIJOU watching party【ホロライブ/大空スバル】");
  const nichijou = { ...work(20, "日常"), media: "tv" as const, titles: ["日常", "Nichijou"] };
  const segs = n.ex.segments.map((x) => x.text);
  const r2 = pick(n, new Map<string, Outcome>(segs.map((t) => [t, t === "日常" ? match(nichijou) : ({ ...match(nichijou), weak: true } as Outcome)])));
  assert.deepEqual(r2.picked.map((x) => x.work.annictId), [20]);
});

test("同名の別作品で保留になったとき、タイトルの「アニメ」「実写」・区間の年で選ぶ", () => {
  const anime = { ...work(1, "ゆるキャン△"), media: "tv" as const, releaseYear: 2018 };
  const live = { ...work(2, "ゆるキャン△"), source: "wikidata" as const, sourceKey: "wikidata:Q1", annictId: null, media: "tv" as const, releaseYear: 2020 };
  const amb: Outcome = { kind: "ambiguous", works: [anime, live], method: "同名の別作品（公開年が違う）", source: "annict" };
  const a = plan("同時視聴 | ゆるキャン△② | アニメ同時視聴の会");
  assert.deepEqual(pick(a, new Map<string, Outcome>([["ゆるキャン△", amb]])).picked.map((x) => x.work.sourceKey), ["annict:1"]);
  const l = plan("【 メン限同時視聴 】ゆるキャン△（実写のほう）");
  assert.deepEqual(pick(l, new Map<string, Outcome>([["ゆるキャン△", amb]])).picked.map((x) => x.work.sourceKey), ["wikidata:Q1"]);
});

test("同名の作品で保留になっても、同じ枠の英題の区間がどちらかに当たっていれば選ぶ（日常 / NICHIJOU）", () => {
  const p = plan("【#3】日常 同時視聴 / NICHIJOU watching party【ホロライブ/大空スバル】");
  const anime = { ...work(1, "日常"), media: "tv" as const, titles: ["日常", "Nichijou"], releaseYear: 2011 };
  const film = { ...work(2, "日常 (映画)"), source: "wikidata" as const, sourceKey: "wikidata:Q1", annictId: null, releaseYear: 2006 };
  const segs = p.ex.segments.map((x) => x.text);
  const r = pick(p, new Map<string, Outcome>([
    [segs[0]!, { kind: "ambiguous", works: [anime, film], method: "同名の別作品（公開年が違う）", source: "annict" }],
    [segs[1]!, { ...match(anime), weak: true } as Outcome],
  ]));
  assert.deepEqual(r.picked.map((x) => x.work.sourceKey), ["annict:1"]);
});
