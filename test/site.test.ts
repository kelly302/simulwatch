import { test } from "node:test";
import assert from "node:assert/strict";
import {
  episodeLabel, formLabel, formatDate, formatViews, formatWhen, iconAt, metaLine, multiMetaLine, periodLabel, publicKeyOf, showsNameEn, sortByViews,
} from "../src/shared/site.ts";
import { cardHtml, workRowHtml } from "../site/lib/views.ts";
import type { TopDict, TopRow } from "../site/lib/encode.ts";
import { packImage, unpackImage } from "../site/lib/encode.ts";
import { norm } from "../site/lib/text.ts";

test("種別形式・時期の表記（モックアップ「作品の属性の出し方」）", () => {
  assert.equal(metaLine({ kind: "anime", media: "tv", year: 2013, season: "spring" }), "TVアニメ · 2013年春");
  assert.equal(metaLine({ kind: "anime", media: "movie", year: 2019, season: null }), "アニメ映画 · 2019年");
  assert.equal(metaLine({ kind: "anime", media: "ova", year: 2011, season: "winter" }), "OVA · 2011年");
  assert.equal(metaLine({ kind: "anime", media: "web", year: 2026, season: "winter" }), "Webアニメ · 2026年冬");
  assert.equal(metaLine({ kind: "tokusatsu", media: "tv", year: 2000, season: null }), "特撮 · 2000年");
  assert.equal(metaLine({ kind: "tokusatsu", media: "movie", year: 2022, season: null }), "特撮映画 · 2022年");
  assert.equal(metaLine({ kind: "live_action", media: "tv", year: 2021, season: null }), "ドラマ · 2021年");
  assert.equal(metaLine({ kind: "live_action", media: "movie", year: 1985, season: null }), "実写映画 · 1985年");
  assert.equal(metaLine({ kind: null, media: "movie", year: 2016, season: null }), "映画 · 2016年");
  // 枠カードで話数があれば、時期の代わりに話数
  assert.equal(metaLine({ kind: "anime", media: "tv", year: 2015, season: "spring" }, "第27話〜第33話"), "TVアニメ · 第27話〜第33話");
  // 分からない値は書かない
  assert.equal(metaLine({ kind: null, media: null, year: null, season: null }), "");
  assert.equal(formLabel("live_action", null), "実写");
  // 放送期は TV・Web のアニメだけ（Wikidata の年だけの作品・映画は年）
  assert.equal(periodLabel({ kind: "live_action", media: "tv", year: 2021, season: "spring" }), "2021年");
  assert.equal(multiMetaLine([{ kind: "anime", media: "tv" }, { kind: "tokusatsu", media: "tv" }, { kind: "tokusatsu", media: "tv" }]), "TVアニメ・特撮 · 3作品");
  assert.equal(multiMetaLine([{ kind: "tokusatsu", media: "tv" }], 1), "特撮 · 2作品");
});

test("再生数の表記。NULL は「—」で 0 と区別する", () => {
  assert.equal(formatViews(0), "0回");
  assert.equal(formatViews(1234), "1,234回");
  assert.equal(formatViews(34_000), "3.4万回");
  assert.equal(formatViews(151_000), "15.1万回");
  assert.equal(formatViews(1_040_000), "104万回");
  assert.equal(formatViews(null), "—");
});

test("日付は日本時間", () => {
  assert.equal(formatDate("2026-10-02T15:30:00Z"), "2026/10/03");
  assert.equal(formatWhen("2026-10-03T12:00:00Z"), "10/03(土) 21:00");
});

test("話数の表記: 続いた番号は「〜」、飛んだ番号は「・」。番号の表記はそのまま", () => {
  const ep = (n: number, t = `第${n}話`) => ({ number: n, text: t });
  assert.equal(episodeLabel([ep(3), ep(1), ep(2), ep(4)]), "第1話〜第4話");
  assert.equal(episodeLabel([ep(1), ep(2), ep(3), ep(5)]), "第1話〜第3話・第5話");
  assert.equal(episodeLabel([ep(7)]), "第7話");
  assert.equal(episodeLabel([ep(1, "第1羽"), ep(2, "第2羽")]), "第1羽〜第2羽");
  assert.equal(episodeLabel([]), null);
});

test("再生数で並べる: NULL の行は逆順に関係なく末尾で、最終視聴日の新しい順", () => {
  const rows = [
    { id: "a", v: 100, t: "2026-01-01" },
    { id: "b", v: null, t: "2026-03-01" },
    { id: "c", v: 300, t: "2026-02-01" },
    { id: "d", v: null, t: "2026-04-01" },
    { id: "e", v: 0, t: "2026-05-01" },
  ];
  const ids = (rev: boolean) => sortByViews(rows, (r) => r.v, (r) => r.t, rev).map((r) => r.id).join("");
  assert.equal(ids(false), "caedb");
  assert.equal(ids(true), "eacdb");
  // 日付が UNIX 秒（数）でも同じ
  assert.equal(sortByViews([{ v: null, t: 9 }, { v: null, t: 10 }], (r) => r.v, (r) => r.t).map((r) => r.t).join(","), "10,9");
});

test("公開キーは annict > anilist > wikidata", () => {
  assert.equal(publicKeyOf({ annictId: 12, anilistId: 34, wikidataId: "Q5" }), "annict-12");
  assert.equal(publicKeyOf({ annictId: null, anilistId: 34, wikidataId: "Q5" }), "anilist-34");
  assert.equal(publicKeyOf({ annictId: null, anilistId: null, wikidataId: "Q5" }), "wikidata-Q5");
  assert.equal(publicKeyOf({ annictId: null, anilistId: null, wikidataId: null }), null);
});

test("英語の名前は日本以外の区分で、名前と違うときだけ併記する", () => {
  assert.equal(showsNameEn({ branch: "en", name: "ルカ・カネシロ", nameEn: "Luca Kaneshiro" }), true);
  assert.equal(showsNameEn({ branch: "jp", name: "葛葉", nameEn: "Kuzuha" }), false);
  assert.equal(showsNameEn({ branch: "en", name: "FUWAMOCO", nameEn: "FUWAMOCO" }), false);
  assert.equal(iconAt("https://yt3.ggpht.com/abc=s240-c-k-c0x00ffffff-no-rj", 88), "https://yt3.ggpht.com/abc=s88-c-k-c0x00ffffff-no-rj");
});

test("枠カード: 作品・複数作品・作品ページの無い枠・予定枠。値は esc する", () => {
  const dict: TopDict = {
    s: { 1: ["/streamers/UCx/", "配信<者>", "nijisanji", "en", ""] },
    w: {
      10: ["/works/annict-1/", "進撃の巨人", "anime", "tv", 2013, "spring", "JP"],
      11: ["", "仮面ライダー", "tokusatsu", "tv", 2024, "", "JP"],
    },
  };
  const row = (over: Partial<Record<number, unknown>>): TopRow => Object.assign(["vid00000001", 1_700_000_000, 1234, 0, 1, [[10, "第1話〜第4話"]], 0, []], over) as TopRow;
  const one = cardHtml(row({}), dict);
  assert.match(one, /<a href="\/works\/annict-1\/">進撃の巨人<\/a>/);
  assert.match(one, /TVアニメ · 第1話〜第4話/);
  assert.match(one, /配信&lt;者&gt;/);
  assert.match(one, /class="br"[^>]*>EN</);
  assert.match(one, /1,234回/);
  // メン限は再生数の代わりにバッジ
  assert.match(cardHtml(row({ 2: null, 3: 1 }), dict), /badge mem/);
  // 作品ページの無い作品はリンクにしない。外部DBに無い作品の名前も並べる
  const multi = cardHtml(row({ 5: [10, 11], 7: ["外部DBに無い作品"] }), dict);
  assert.match(multi, /<span>仮面ライダー<\/span>/);
  assert.match(multi, /<span>外部DBに無い作品<\/span>/);
  assert.match(multi, /TVアニメ・特撮 · 3作品/);
  // 作品ページの無い枠
  assert.match(cardHtml(row({ 5: [], 6: ["ミュージカル『X』", 1, "live_action", 0] }), dict), /作品ページなし/);
  assert.match(cardHtml(row({ 5: [], 6: ["【メン限】映画同時視聴！", 0, "", -1] }), dict), /枠のタイトル/);
  // 予定枠・配信中
  assert.match(cardHtml(row({ 2: null, 8: "upcoming" }), dict), /class="when"/);
  assert.match(cardHtml(row({ 2: null, 8: "live" }), dict), /LIVE/);
});

test("作品一覧の行と画像の URL の短縮", () => {
  const url = "https://s4.anilist.co/file/anilistcdn/media/anime/cover/medium/bx1-abc.jpg";
  assert.equal(unpackImage(packImage(url)), url);
  assert.equal(unpackImage(packImage(null)), null);
  const html = workRowHtml(["annict-1", "作品", "anime", "movie", 2019, "", packImage(url), 9, null, 1_700_000_000], "views");
  assert.match(html, /href="\/works\/annict-1\/"/);
  assert.match(html, /—/);
  assert.match(html, /9人/);
});

test("検索の照合: カタカナとひらがな・全角半角・記号をそろえる", () => {
  assert.equal(norm("ルカ・カネシロ"), "るかかねしろ");
  assert.ok(norm("ＳＴＥＩＮＳ；ＧＡＴＥ").includes("steinsgate"));
  assert.ok(norm("Luca Kaneshiro").includes("lucakaneshiro"));
});
