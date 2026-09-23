import { test } from "node:test";
import assert from "node:assert/strict";
import { detect, normalize, isMembersTitle, reviewHints } from "../src/detect/detect.ts";
import { loadDetectConfig } from "../src/lib/config.ts";

const cfg = loadDetectConfig();
const d = (title: string, description: string | null = null) => detect({ title, description }, cfg);

test("タイトルの部分一致で派生語も拾う", () => {
  assert.deepEqual(d("【同時視聴】劇場版〇〇を一緒に観よう！"), { hit: true, source: "title", keyword: "同時視聴" });
  assert.equal(d("#同時視聴会 映画〇〇").hit, true);
  assert.equal(d("ミラー配信 劇場版〇〇").hit, true);
  // 誤字の「同時試聴」も実データで常用されている
  assert.equal(d("【メン限同時試聴】「ヴァチカンのエクソシスト」みるゾウ").hit, true);
});

test("表記ゆれ（全角・空白・ハイフン・大文字）を吸収する", () => {
  assert.equal(d("【同時 視聴】劇場版").hit, true);
  assert.equal(d("【Ｗａｔｃｈ－Ａｌｏｎｇ】Movie").hit, true);
  assert.equal(d("Watch Along: Movie").hit, true);
  assert.equal(d("ウォッチパーティー！").hit, true);
});

test("同時視聴者数の記念枠は除外する", () => {
  const r = d("【祝】同時視聴者数1万人ありがとう！");
  assert.equal(r.hit, false);
  assert.equal(r.hit === false && r.excludedBy, "同時視聴者");
});

test("ゲーム実況など無関係なタイトルは当たらない", () => {
  assert.equal(d("【APEX】ランクいくど！").hit, false);
  assert.equal(d("【ミラーズエッジ】初見プレイ").hit, false);
});

test("概要欄は行単位で見て、注意書きの行を無視する", () => {
  assert.equal(d("映画を観る", "※ミラー配信・同時視聴はご遠慮ください").hit, false);
  assert.equal(d("映画を観る", "切り抜き・ミラー配信はガイドラインをご確認ください").hit, false);
  assert.equal(d("映画を観る", "同時視聴NGです").hit, false);
  assert.equal(d("映画を観る", "ミラー配信OK").hit, false);
  assert.deepEqual(d("映画を観る", "今日は劇場版〇〇を同時視聴します！\nよろしく"), { hit: true, source: "description", keyword: "同時視聴" });
  // 英単語の中の ng / ok は否定語として扱わない
  assert.equal(d("movie", "今日は watchalong streaming").hit, true);
});

test("概要欄は、その枠自体を指す語（今日・本日・今回 など）がある行だけヒットにする", () => {
  assert.equal(d("雑談", "10/19 お仕事あるので同時視聴おやすみ！").hit, false);
  assert.equal(d("雑談", "🌟完全初見！コードギアス同時視聴再生リスト").hit, false);
  assert.equal(d("雑談", "約５か月前にFateと出会い、皆と同時視聴してドハマりした").hit, false);
  assert.equal(d("映画", "今日の同時視聴は「アダムス・ファミリー」").hit, true);
  assert.equal(d("映画", "本日は過激なブラックジョークアニメ『サウスパーク』を同時視聴しよう！！").hit, true);
});

test("正規化は照合用。原文は変わらない", () => {
  const title = "【同時視聴】Ｔｅｓｔ";
  normalize(title, cfg.normalize);
  assert.equal(title, "【同時視聴】Ｔｅｓｔ");
  assert.equal(normalize("Ａ Ｂ", cfg.normalize), "ab");
});

test("メン限の推定とヒント語", () => {
  assert.equal(isMembersTitle("【メン限】同時視聴", cfg), true);
  assert.equal(isMembersTitle("【メンバー限定】", cfg), true);
  assert.equal(isMembersTitle("【同時視聴】", cfg), false);
  assert.deepEqual(reviewHints("みんなで映画を観よう", cfg), ["観よう"]);
});

test("概要欄の定型文（同じチャンネルで繰り返し出る行）は無視する", async () => {
  const { templateLines } = await import("../src/detect/detect.ts");
  // 「今日」を含むので line_require は通ってしまう。定型文の除外で落ちることを確かめる
  const boiler = "メンバー特典：今日から入れるメン限で同時視聴やってます";
  const descs = [`ゲームします\n${boiler}`, `雑談\n${boiler}`, `歌枠\n${boiler}`, "今日は劇場版〇〇を同時視聴します！"];
  const tl = templateLines(descs, cfg);
  assert.equal(detect({ title: "【APEX】", description: descs[0]!, templateLines: tl }, cfg).hit, false);
  assert.equal(detect({ title: "映画", description: descs[3]!, templateLines: tl }, cfg).hit, true);
  // 1本の中で同じ行が繰り返されても1回と数える
  assert.equal(templateLines([`${boiler}\n${boiler}\n${boiler}`], cfg).size, 0);
});
