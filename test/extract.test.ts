import { test } from "node:test";
import assert from "node:assert/strict";
import { extract, parseKanjiNumber, extractFromDescription } from "../src/resolve/extract.ts";
import { matchKey } from "../src/resolve/normalize.ts";
import { loadExtractConfig } from "../src/resolve/config.ts";

const cfg = loadExtractConfig();
const segs = (title: string) => extract(title, cfg).segments.map((s) => s.text);
const eps = (title: string) => extract(title, cfg).episodes.map((e) => e.number);

test("タグの括弧・ノイズ語・前後の語を外して区間を切り出す", () => {
  assert.deepEqual(segs("〖メンバー限定〗Fate/Apocrypha！アニメ同時視聴する！#4〖星川サラ/にじさんじ〗"), ["Fate/Apocrypha"]);
  assert.deepEqual(segs("【メン限同時視聴】天気の子 続き"), ["天気の子"]);
  assert.deepEqual(segs("【同時視聴】インターステラー【メン限】"), ["インターステラー"]);
  assert.deepEqual(segs("【メン限】同時視聴：ゴーストバスターズ【ソフィア・ヴァレンタイン/にじさんじ】"), ["ゴーストバスターズ"]);
  assert.deepEqual(segs("【メンバー限定】本日の同時視聴はアベンジャーズ/インフィニティ・ウォー！！【ぶいすぽ/兎咲ミミ】"), ["アベンジャーズ/インフィニティ・ウォー"]);
});

test("括弧（『』「」）の中身を優先の区間にする", () => {
  const e = extract("【 同時視聴 】知識０と見る『コードギアス 反逆のルルーシュ』ネタバレ、駄目、絶対！", cfg);
  assert.equal(e.segments[0]!.text, "コードギアス 反逆のルルーシュ");
  assert.equal(e.segments[0]!.from, "quote");
  assert.deepEqual(segs("【メン限】『最強のふたり (吹替版)』 同時視聴する 2024.11.16"), ["最強のふたり"]);
});

test("作品名の一部だけを区間にしない（誤同定の防止）", () => {
  // 「鋼の錬金術師」(2003) に一致させないよう、FA ごと1つの区間にする
  assert.deepEqual(segs("【同時視聴】鋼の錬金術師FA16~20話。持ち物：バスタオル【綺沙良/にじさんじ】")[0], "鋼の錬金術師FA");
  // 単独の空白で区切らないので「ジョジョの奇妙な冒険」だけの区間はできない
  const j = extract("メンバー限定で『ジョジョの奇妙な冒険 第3部 スターダストクルセイダース』第8話～第15話", cfg);
  assert.equal(j.segments[0]!.text, "ジョジョの奇妙な冒険 第3部 スターダストクルセイダース");
  assert.ok(j.segments.every((s) => s.subs.every((x) => x.text !== "ジョジョの奇妙な冒険")));
});

test("区間の前後の語だけを外し、作品名の中の語は残す", () => {
  assert.deepEqual(segs("【同時視聴】恋する小惑星"), ["恋する小惑星"]);
  assert.deepEqual(segs("【#４】完全初見ののんのんびより同時視聴"), ["のんのんびより"]);
});

test("話数: 範囲・単話・漢数字。全話数と配信回数（#N）は話数にしない", () => {
  assert.deepEqual(eps("【同時視聴】鋼の錬金術師FA16~20話"), [16, 17, 18, 19, 20]);
  assert.deepEqual(eps("「 刃牙（バキ） 」第1話～第4話"), [1, 2, 3, 4]);
  assert.deepEqual(eps("アニメ「葬送のフリーレン」 第7~8話 同時視聴"), [7, 8]);
  assert.deepEqual(eps("「機動戦士ガンダムSEED」同時視聴！Ep17ペイバックから！"), [17]);
  assert.deepEqual(eps("第壱話 使徒、襲来"), [1]);
  assert.deepEqual(eps("ハズビン･ホテルへようこそ【全八話】"), []);
  assert.deepEqual(eps("進撃の巨人 Season3 アニメ同時視聴する！#10"), []);
  assert.equal(extract("第壱話 使徒、襲来", cfg).episodes[0]!.number_text, "第壱話");
});

test("作品ではない同時視聴を見分ける", () => {
  const naw = (t: string) => extract(t, cfg).notAWork;
  assert.ok(naw("【競馬同時視聴】激闘の天皇賞秋、同時視聴"));
  assert.ok(naw("【同時視聴】Nintendo Direct 2026.6.9 ニンダイを一緒に観よう！！！"));
  assert.ok(naw("【valorant】VCT Champions Day5 ミラー配信"));
  assert.ok(naw("【祝二周年】2019年の初配信をみんなで同時視聴！！"));
  // 作品名に含まれる語を巻き込まない
  assert.equal(naw("【同時視聴】ウマ娘 プリティーダービー 第1話"), null);
  assert.equal(naw("【同時視聴】ロケットガール"), null);
  assert.equal(naw("【同時視聴】劇場版「ヴァイオレット・エヴァーガーデン」"), null);
});

test("照合キー: 記号・空白・期の表記ゆれをそろえる", () => {
  assert.equal(matchKey("進撃の巨人 Season 3", cfg), matchKey("進撃の巨人 3期", cfg));
  assert.equal(matchKey("ぼっち・ざ・ろっく！", cfg), matchKey("ぼっち・ざ・ろっく", cfg));
  assert.equal(matchKey("Fate/Grand Order -絶対魔獣戦線バビロニア-", cfg), matchKey("Fate/Grand Order 絶対魔獣戦線バビロニア", cfg));
  assert.equal(matchKey("ロード・エルメロイⅡ世の事件簿", cfg), matchKey("ロード・エルメロイII世の事件簿", cfg));
  assert.notEqual(matchKey("鋼の錬金術師FA", cfg), matchKey("鋼の錬金術師", cfg));
});

test("漢数字", () => {
  assert.equal(parseKanjiNumber("十二"), 12);
  assert.equal(parseKanjiNumber("弐拾"), 20);
  assert.equal(parseKanjiNumber("百一"), 101);
  assert.equal(parseKanjiNumber("13"), 13);
  assert.equal(parseKanjiNumber("話"), null);
});

test("概要欄からは、その枠を指す行の括弧の中身だけを候補にする", () => {
  const d = "今日の同時視聴は「アダムス・ファミリー」です\n先週は『別の映画』を観ました";
  assert.deepEqual(extractFromDescription(d, ["今日", "本日"], cfg).map((s) => s.text), ["アダムス・ファミリー"]);
});

test("「/」で分けるのは和英併記のときだけ（Fate/Zero は分けない）", () => {
  const subsOf = (t: string) => extract(t, cfg).segments.flatMap((s) => s.subs.map((x) => x.text));
  const f = subsOf("【同時視聴】Fate/Zeroみんなで観よう！！ぺこ！");
  assert.ok(f.includes("Fate/Zero"));
  assert.ok(!f.includes("Fate") && !f.includes("Zero"));
  const k = subsOf("【メン限】「カンフーハッスル/Kung Fu Hustle」同時視聴 ほか");
  assert.ok(k.includes("カンフーハッスル") && k.includes("Kung Fu Hustle"));
});

test("括弧（『』「」）の中の全角スラッシュでは区切らない", () => {
  assert.equal(segs("【メン限】『シビル・ウォー／キャプテン・アメリカ』 同時視聴する 2023.6.10")[0], "シビル・ウォー/キャプテン・アメリカ");
  // 括弧の外の全角スラッシュは区切り
  assert.deepEqual(segs("【同時視聴】ハリー・ポッターと秘密の部屋／Harry Potter and the Chamber of Secrets"), ["ハリー・ポッターと秘密の部屋", "Harry Potter and the Chamber of Secrets"]);
});

test("配信者タグの括弧の中の『』は作品名の候補にしない", () => {
  assert.deepEqual(segs("同時視聴【にじさんじ 4th Anniversary「FANTASIA」DAY1】を観る！！！【白雪 巴/にじさんじ】").filter((x) => x === "FANTASIA"), []);
});
