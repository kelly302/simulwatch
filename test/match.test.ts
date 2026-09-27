import { test } from "node:test";
import assert from "node:assert/strict";
import { matchByTitle, decideWikipedia, decideWikipediaSearch, baseTitle } from "../src/resolve/match.ts";
import { matchKey } from "../src/resolve/normalize.ts";
import { loadExtractConfig } from "../src/resolve/config.ts";
import type { WorkCandidate } from "../src/resolve/types.ts";
import type { PageInfo, EntityInfo } from "../src/resolve/sources/wikipedia.ts";

const cfg = loadExtractConfig();
const k = (s: string) => matchKey(s, cfg);

function work(id: number, title: string, media: WorkCandidate["media"] = "tv", extra: string[] = []): WorkCandidate {
  return {
    source: "annict", sourceKey: `annict:${id}`, annictId: id, anilistId: null, wikidataId: null, malId: null,
    title, titleKana: null, titles: [title, ...extra], media, seasonName: null, releaseYear: null,
    episodesCount: null, imageUrl: null, seriesId: null,
  };
}

test("完全一致だけを採用する（部分一致で別作品にしない）", () => {
  const cands = [work(1, "鋼の錬金術師"), work(2, "鋼の錬金術師 FULLMETAL ALCHEMIST")];
  assert.equal(matchByTitle(k("鋼の錬金術師FA"), cands, "", cfg).kind, "none");
  const jojo = [work(10, "ジョジョの奇妙な冒険"), work(11, "ジョジョの奇妙な冒険 スターダストクルセイダース"), work(12, "ジョジョの奇妙な冒険 ダイヤモンドは砕けない")];
  assert.equal(matchByTitle(k("ジョジョの奇妙な冒険 第3部 スターダストクルセイダース"), jojo, "", cfg).kind, "none");
  const r = matchByTitle(k("ジョジョの奇妙な冒険 ダイヤモンドは砕けない"), jojo, "", cfg);
  assert.equal(r.kind === "match" && r.work.annictId, 12);
});

test("表記ゆれ（記号・空白・期）と英題・別名での一致", () => {
  const r = matchByTitle(k("ぼっち・ざ・ろっく"), [work(1, "ぼっち・ざ・ろっく！")], "", cfg);
  assert.equal(r.kind, "match");
  const s = matchByTitle(k("進撃の巨人 3期"), [work(2, "進撃の巨人"), work(3, "進撃の巨人 Season 3")], "", cfg);
  assert.equal(s.kind === "match" && s.work.annictId, 3);
  const en = matchByTitle(k("Fate/Apocrypha"), [work(4, "Fate/Apocrypha", "tv", ["Fate/Apocrypha"])], "", cfg);
  assert.equal(en.kind, "match");
});

test("同名の作品が複数: 劇場版の語で映画を選び、決まらなければ ambiguous", () => {
  const same = [work(1, "うる星やつら", "tv"), work(2, "うる星やつら", "tv")];
  assert.equal(matchByTitle(k("うる星やつら"), same, "", cfg).kind, "ambiguous");
  const tvMovie = [work(3, "名探偵コナン", "tv"), work(4, "名探偵コナン", "movie")];
  const m = matchByTitle(k("名探偵コナン"), tvMovie, "【同時視聴】劇場版 名探偵コナン", cfg);
  assert.equal(m.kind === "match" && m.work.annictId, 4);
  const t = matchByTitle(k("名探偵コナン"), tvMovie, "【同時視聴】名探偵コナン 第1話", cfg);
  assert.equal(t.kind === "match" && t.work.annictId, 3);
});

const page = (query: string, over: Partial<PageInfo> = {}): PageInfo => ({
  query, title: query, qid: null, missing: false, disambiguation: false, redirected: false, fragment: false, ...over,
});
const ent = (qid: string, p31: string[], label: string | null = null): EntityInfo => ({ qid, p31, labelJa: label, year: 2025, series: null });

test("Wikipedia: 作品でない記事なら「(映画)」の記事を試す（国宝 → 国宝 (映画)）", () => {
  const pages = new Map([
    ["国宝", page("国宝", { qid: "Q1" })],
    ["国宝 (映画)", page("国宝 (映画)", { qid: "Q2" })],
  ]);
  const ents = new Map([["Q1", ent("Q1", ["Q1139795"])], ["Q2", ent("Q2", ["Q11424"], "国宝")]]);
  const r = decideWikipedia("国宝", pages, ents, cfg);
  assert.equal(r.kind === "match" && r.work.wikidataId, "Q2");
  assert.equal(r.kind === "match" && r.work.media, "movie");
  assert.equal(r.kind === "match" && r.method, "suffix");
});

test("Wikipedia: 漫画の記事・曖昧さ回避・節へのリダイレクトは採用しない", () => {
  const ents = new Map([["Q3", ent("Q3", ["Q21198342"])], ["Q4", ent("Q4", ["Q20650540"])]]);
  assert.equal(decideWikipedia("進撃の巨人", new Map([["進撃の巨人", page("進撃の巨人", { qid: "Q3" })]]), ents, cfg).kind, "none");
  assert.equal(decideWikipedia("X", new Map([["X", page("X", { qid: "Q4", disambiguation: true })]]), ents, cfg).kind, "none");
  // 「ミュウツーの逆襲 EVOLUTION」→ 1998年版の記事の節へのリダイレクト
  const frag = page("ミュウツーの逆襲 EVOLUTION", { title: "劇場版ポケットモンスター ミュウツーの逆襲", qid: "Q4", redirected: true, fragment: true });
  assert.equal(decideWikipedia("ミュウツーの逆襲 EVOLUTION", new Map([[frag.query, frag]]), ents, cfg).kind, "none");
});

test("Wikipedia 全文検索: 括弧を外した記事名が完全一致する作品だけ", () => {
  const titles = ["ザ・ハント (2020年の映画)", "ザ・ハント (2012年の映画)", "ハント"];
  const pages = new Map(titles.map((t, i) => [t, page(t, { qid: `Q${10 + i}` })]));
  const ents = new Map([["Q10", ent("Q10", ["Q11424"])], ["Q11", ent("Q11", ["Q11424"])], ["Q12", ent("Q12", ["Q11424"])]]);
  // 2作品が一致 → ambiguous（年を決める根拠が無い）
  assert.equal(decideWikipediaSearch(k("ザ・ハント"), titles, pages, ents, cfg).kind, "ambiguous");
  assert.equal(decideWikipediaSearch(k("ザ・ハント"), [titles[0]!, "ハント"], pages, ents, cfg).kind, "match");
  assert.equal(baseTitle("告白 (2010年の映画)"), "告白");
});

test("Wikipedia: 同名の曖昧さ回避ページがあれば、接尾辞の付いた記事では決めない（スパイダーマン → 1978年の東映版にしない）", () => {
  const pages = new Map([
    ["スパイダーマン", page("スパイダーマン", { qid: "Q1" })],
    ["スパイダーマン (テレビドラマ)", page("スパイダーマン (テレビドラマ)", { qid: "Q2" })],
    ["スパイダーマン (曖昧さ回避)", page("スパイダーマン (曖昧さ回避)", { qid: "Q3", disambiguation: true })],
  ]);
  const ents = new Map([["Q1", ent("Q1", ["Q15632617"])], ["Q2", ent("Q2", ["Q5398426"])]]);
  assert.equal(decideWikipedia("スパイダーマン", pages, ents, cfg).kind, "ambiguous");
  // 「(映画)」の記事は、曖昧さ回避ページがあっても決めてよい（映画の中では一意の記事名）
  const pages2 = new Map([
    ["国宝", page("国宝", { qid: "Q1" })],
    ["国宝 (映画)", page("国宝 (映画)", { qid: "Q2" })],
    ["国宝 (曖昧さ回避)", page("国宝 (曖昧さ回避)", { qid: "Q9", disambiguation: true })],
  ]);
  const ents2 = new Map([["Q1", ent("Q1", ["Q1139795"])], ["Q2", ent("Q2", ["Q11424"])]]);
  assert.equal(decideWikipedia("国宝", pages2, ents2, cfg).kind, "match");
});

test("リメイク: 年付きの同名作品があれば決めない。区間に年が付いていればその年の作品を選ぶ", () => {
  const w1991 = { ...work(1, "ドラゴンクエスト ダイの大冒険"), releaseYear: 1991 };
  const w2020 = { ...work(2, "ドラゴンクエスト ダイの大冒険 (2020年版)"), releaseYear: 2020 };
  assert.equal(matchByTitle(k("ドラゴンクエスト ダイの大冒険"), [w1991, w2020], "", cfg).kind, "ambiguous");
  const r = matchByTitle(k("ドラゴンクエスト ダイの大冒険(2020"), [w1991, w2020], "", cfg);
  assert.equal(r.kind === "match" && r.work.annictId, 2);
});

test("リメイク: 年のあとに分割の表記が付く同名作品（「(2022) part1」）があれば決めない", () => {
  const cands = [work(1, "BASTARD!! -暗黒の破壊神-", "ova"), work(2, "BASTARD!! -暗黒の破壊神- (2022) part1", "web")];
  assert.equal(matchByTitle(matchKey("BASTARD!! -暗黒の破壊神-", cfg), cands, "", cfg).kind, "ambiguous");
});
