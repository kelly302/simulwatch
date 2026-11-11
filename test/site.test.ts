import { test } from "node:test";
import assert from "node:assert/strict";
import {
  episodeLabel, formLabel, formatDate, formatViews, iconAt, metaLine, multiMetaLine, periodLabel, publicKeyOf, showsNameEn, sortByViews,
} from "../src/shared/site.ts";
import { cardHtml, workCardHtml, workRowHtml } from "../site/lib/views.ts";
import type { TopDict, TopRow } from "../site/lib/encode.ts";
import { packImage, unpackImage } from "../site/lib/encode.ts";
import { norm } from "../site/lib/text.ts";
import { AFF_NONE, EMPTY, activeAxes, axisButtonsHtml, axisValue, matchesTop, resetAxis } from "../site/lib/filters.ts";

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

test("枠カード: 作品・複数作品・作品ページの無い枠。値は esc する", () => {
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
  // LIVE バッジは出さない（D-01）
  assert.doesNotMatch(one, /LIVE|配信中/);
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

test("作品の画像のカード（よく同時視聴される作品・同じシリーズの作品）", () => {
  const base = { key: "wikidata-Q1", title: "作品<A>", image: null, streamers: 21, events: 22, meta: "実写映画 · 2001年" };
  // 画像が無ければ作品名と種別形式・時期を組んだ文字のポスター（読み上げでは読まない）
  const poster = workCardHtml(base);
  assert.match(poster, /<a class="wcard" href="\/works\/wikidata-Q1\/">/);
  assert.match(poster, /<span class="wimg none" aria-hidden="true"><span class="pt">作品&lt;A&gt;<\/span><span class="pf">実写映画 · 2001年<\/span><\/span>/);
  assert.match(poster, /<strong>21人<\/strong>が観た · 22枠/);
  const img = workCardHtml({ ...base, image: "https://s4.anilist.co/x.jpg" });
  assert.match(img, /<img class="wimg" src="https:\/\/s4\.anilist\.co\/x\.jpg"/);
  assert.doesNotMatch(img, /class="pt"/);
  // いま開いている作品はリンクにしない
  const cur = workCardHtml(base, { current: true });
  assert.match(cur, /<div class="wcard" aria-current="page">/);
  assert.doesNotMatch(cur, /href=/);
  assert.match(cur, /この作品/);
});

test("トップの絞り込みの軸のボタン（指定した軸は桃色に塗って値を出す）", () => {
  const agAll = (ag: string) => (ag === "nijisanji" ? ["nijisanji:jp", "nijisanji:en", "nijisanji:kr", "nijisanji:id"] : [`${ag}:jp`]);
  const f = EMPTY();
  // 何も指定していなければ6つの軸の名前と、入っていないメン限のチェック
  const none = axisButtonsHtml(f, agAll);
  assert.equal((none.match(/class="fchip axis"/g) ?? []).length, 6);
  assert.match(none, /class="fchip check" data-toggle="mem" aria-pressed="false">/);
  assert.match(none, />配信日<\/button>/);
  // ボタンは短い名前、読み上げは正式な名前
  assert.match(none, /aria-label="作品の放送年">放送年<\/button>/);
  assert.doesNotMatch(none, /fdiv/);
  assert.equal(activeAxes(f, agAll), 0);
  f.date = "2025"; f.branch = ["nijisanji:en", "nijisanji:kr"]; f.kind = ["anime", "tokusatsu"]; f.year = "2013"; f.season = "spring"; f.mem = "ex";
  assert.equal(axisValue(f, "date", agAll), "2025年に配信");
  assert.equal(axisValue(f, "aff", agAll), "にじさんじ EN・KR");
  assert.equal(axisValue(f, "kind", agAll), "アニメ・特撮");
  assert.equal(axisValue(f, "year", agAll), "2013年春の作品");
  // メン限を除くも条件の数に入る
  assert.equal(activeAxes(f, agAll), 5);
  // 開いている軸は aria-expanded
  const on = axisButtonsHtml(f, agAll, "date");
  assert.match(on, /class="fchip axis on" data-axis="date" aria-expanded="true" aria-controls="fpanel" aria-label="配信日：2025年に配信">2025年に配信</);
  assert.match(on, /data-axis="aff" aria-expanded="false"/);
  assert.match(on, /class="fchip check on" data-toggle="mem" aria-pressed="true">/);
  // 所属をまとめて選べば事務所の名前だけ。3つ以上は「ほか」
  f.branch = ["nijisanji:jp", "nijisanji:en", "nijisanji:kr", "nijisanji:id"];
  assert.equal(axisValue(f, "aff", agAll), "にじさんじ");
  f.branch = [...f.branch, "hololive:jp", "vspo:jp"];
  assert.equal(axisValue(f, "aff", agAll), "にじさんじ ほか2");
  // 外したほうが短く書けるときは「○○を除く」（既定は全部にチェック）
  f.branch = ["nijisanji:jp", "nijisanji:en", "nijisanji:kr", "nijisanji:id", "hololive:jp"];
  assert.equal(axisValue(f, "aff", agAll), "ぶいすぽっ！を除く");
  f.branch = ["nijisanji:jp", "nijisanji:en", "nijisanji:id", "hololive:jp", "vspo:jp"];
  assert.equal(axisValue(f, "aff", agAll), "にじさんじ KR を除く");
  f.branch = ["nijisanji:jp", "nijisanji:kr", "nijisanji:id", "vspo:jp"];
  assert.equal(axisValue(f, "aff", agAll), "にじさんじ EN・ホロライブを除く");
  // 所属のチェックを全部外したときの印
  f.branch = [AFF_NONE];
  assert.equal(axisValue(f, "aff", agAll), "所属のチェックなし");
  assert.equal(activeAxes(f, agAll), 5);
  // その軸だけ指定なしに戻す
  resetAxis(f, "year");
  assert.equal(f.year, "");
  assert.equal(f.season, "");
  assert.equal(f.date, "2025");
  f.date = "30d";
  assert.equal(axisValue(f, "date", agAll), "30日以内に配信");
});

test("検索の照合: カタカナとひらがな・全角半角・記号をそろえる", () => {
  assert.equal(norm("ルカ・カネシロ"), "るかかねしろ");
  assert.ok(norm("ＳＴＥＩＮＳ；ＧＡＴＥ").includes("steinsgate"));
  assert.ok(norm("Luca Kaneshiro").includes("lucakaneshiro"));
});

test("トップの絞り込みの判定（配信日・所属・メン限・作品の種類・映画・制作国・放送年）", () => {
  const now = Date.parse("2026-10-19T00:00:00Z") / 1000;
  const d: TopDict = {
    s: { 1: ["", "A", "nijisanji", "en", ""], 2: ["", "B", "hololive", "jp", ""] },
    w: {
      10: ["", "W", "anime", "movie", 2013, "spring", "JP"],
      11: ["", "X", "live_action", "tv", 2020, "", "US,JP"],
      12: ["", "Y", "anime", "tv", 0, "", "?"],
    },
  };
  // 10日前・にじさんじ EN・アニメ映画（日本・2013年春）
  const r1: TopRow = ["v1", now - 10 * 86_400, 100, 0, 1, [10], 0, []];
  // 400日前（2025年）・ホロライブ JP・メン限・実写のテレビ作品（米日合作）
  const r2: TopRow = ["v2", now - 400 * 86_400, null, 1, 2, [[11, "第1話"]], 0, []];
  // 40日前・作品名の書かれていない枠（種類も映画かどうかも分からない）
  const r3: TopRow = ["v3", now - 40 * 86_400, 5, 0, 2, [], ["映画同時視聴", 0, "", -1], []];
  // 制作国の分からないアニメ
  const r4: TopRow = ["v4", now - 5 * 86_400, 7, 0, 1, [12], 0, []];
  // 外部DBに無い作品の名前だけ分かる枠（実写の映画）
  const r5: TopRow = ["v5", now - 5 * 86_400, 3, 0, 1, [], ["ある舞台の映像", 1, "live_action", 1], []];
  const all = [r1, r2, r3, r4, r5];
  const hit = (f: Partial<ReturnType<typeof EMPTY>>) => all.filter((r) => matchesTop(r, { ...EMPTY(), ...f }, d, now)).map((r) => r[0]).join(",");
  assert.equal(hit({}), "v1,v2,v3,v4,v5");
  assert.equal(hit({ date: "30d" }), "v1,v4,v5");
  assert.equal(hit({ date: "1y" }), "v1,v3,v4,v5");
  assert.equal(hit({ date: "2025" }), "v2");
  assert.equal(hit({ branch: ["nijisanji:en"] }), "v1,v4,v5");
  assert.equal(hit({ branch: [AFF_NONE] }), "");
  assert.equal(hit({ mem: "ex" }), "v1,v3,v4,v5");
  assert.equal(hit({ kind: ["live_action"] }), "v2,v5");
  // 映画かどうか・制作国が分からない作品は、どちらを選んでも出ない
  assert.equal(hit({ movie: "movie" }), "v1,v5");
  assert.equal(hit({ movie: "other" }), "v2,v4");
  // 合作は「日本」「海外」の両方に入る
  assert.equal(hit({ country: "jp" }), "v1,v2");
  assert.equal(hit({ country: "foreign" }), "v2");
  assert.equal(hit({ year: "2013", season: "spring" }), "v1");
  assert.equal(hit({ year: "2013", season: "summer" }), "");
});
