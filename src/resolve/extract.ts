import type { ExtractConfig } from "./config.ts";
import { compileTerms, matchKey, spacedKey, looseKey } from "./normalize.ts";
import { parseKanjiNumber } from "./kanji.ts";
import { markersOf } from "./markers.ts";

export { parseKanjiNumber };

// 枠タイトルから作品名の候補（区間）と話数を切り出す（純粋関数）。
//
// 区間の作り方
//   - 括弧・ノイズ語（同時視聴・メン限 など）・「｜」「／」・装飾記号を区切りにして、タイトルを区間に分ける
//   - 半角の「/」では区切らない（Fate/Apocrypha など作品名に含まれる）
//   - 単独の空白でも区切らない（「ジョジョの奇妙な冒険 第3部 …」の先頭だけを切り出して誤同定しないため）
//   - 区間の前後にある「を見る」「続き」などの語は外す（trim_words）
// 照合側は「区間まるごとが作品名と一致したとき」だけ採用する。
//
// 話数とハッシュタグは、タイトルの中の位置（区間との前後関係）も残す。
// 1枠に複数の作品と話数があるとき、話数をどの作品に付けるかを位置から決めるため（「アイカツ！…オンパレード…【27話＆1話】」）

export interface EpisodeRef {
  number: number;
  /** 表示用。タイトルに書かれていた形（範囲なら各話を「第N話」にする） */
  number_text: string;
}

export interface Segment {
  /** 区間の文字列（NFKC 済み・前後の語を外したもの）。照会にはこれを使う */
  text: string;
  /** 照合キー */
  key: string;
  from: "quote" | "title" | "description" | "hashtag";
  /**
   * 区間が一致しなかったときに試す小区間。部分的なので確度は下がる。
   * kind: multi は「＆」「×」「+」で分けたもの（複数作品になりうる）、alt は「！」や和英併記などで分けたもの（同じ作品の言い換え）
   */
  subs: { text: string; key: string; kind: "multi" | "alt" }[];
  /** Wikipedia の記事名で試す別の形。区間の直後にあった「!」「?」を残したもの（「カラオケ行こ!」） */
  wp?: string;
}

/** タイトルの中の並び。区間（照合キー）・話数のまとまり（episodeGroups の添字）・丸数字の番号 */
export type LayoutItem = { t: "seg"; key: string; quote: boolean } | { t: "ep"; g: number } | { t: "cnt" };

export interface Extracted {
  /** 作品ではない同時視聴と判定した語（Direct・競馬 など）。null なら作品の可能性あり */
  notAWork: string | null;
  /** notAWork に当たったが、作品名だと明示された括弧（「映画「さがす」」）がある。括弧の中身だけを照会する */
  notAWorkQuoteOnly: boolean;
  segments: Segment[];
  /** ハッシュタグ（「#人外教室」）。ほかに候補がないときだけ使う */
  hashtags: Segment[];
  episodes: EpisodeRef[];
  /** タイトルに書かれた話数のまとまり（「9話&10話」なら2つ） */
  episodeGroups: EpisodeRef[][];
  layout: LayoutItem[];
  /** 直後に副題の括弧が続く区間の照合キー → 副題の照合キー（「ドラゴンボール超「ブロリー」」） */
  subtitled: Map<string, string[]>;
  /** 直後に丸数字の番号が付いた区間の照合キー（「パイカリ③」） */
  numbered: Set<string>;
  /** 企画名（program_names）に当たって候補から外した区間 */
  programs: string[];
  /** 区間にならなかった残り（1文字の語・止め語など） */
  dropped: string[];
  /** 区切りを入れたあとの文字列（デバッグ・頻出パターンの集計用） */
  cleaned: string;
}

const MARK = "\uE000";
// 話数のまとまり・ハッシュタグの位置の印（後ろに添字の文字を1つ付ける）
const EP_MARK = "\uE002";
const HT_MARK = "\uE004";
// 丸数字の番号の位置の印
const CNT_MARK = "\uE006";
const idxChar = (i: number) => String.fromCharCode(0xe100 + i);
const idxOf = (s: string) => s.charCodeAt(1) - 0xe100;
// 区切りとして扱う文字（NFKC の前後どちらでも）
const STRUCT_SEPARATORS = /[／｜|┊┆⋮︙✦✧ˎˊ˗▶▷◀◁\u200B]/g;
// 異体字セレクタ（「┊︎」の後ろに残る U+FE0E など）・ゼロ幅の文字
const INVISIBLE = /[\uFE0E\uFE0F\u200B-\u200D\u2060]/g;
// 絵文字は落とす（☆ などの作品名に入りうる記号は残す）
const EMOJI = /[\p{Emoji_Presentation}]/gu;
const EDGE_PUNCT = /^[\s!！?？、。,.：:;；・･~〜…‥\-‐－―*＊"'“”‘’()（）\[\]［］]+|[\s!！?？、。,.：:;；・･~〜…‥\-‐－―*＊"'“”‘’()（）\[\]［］]+$/g;
// 丸数字。「⑰話」は話数、話が付かない「レイアース⑪」は配信の回数
const CIRCLED = "[\\u2460-\\u2473\\u3251-\\u325F\\u32B1-\\u32BF]";
const CIRCLED_COUNTER = new RegExp(`${CIRCLED}(?!\\s*(?:[～~〜\\-－ー]\\s*${CIRCLED}\\s*)?話)`, "g");

const NUM = "(\\d+|[〇零一壱二弐三参四肆五伍六陸七漆八捌九玖十拾百]+)";
// 「第7話～第12話」「7~12話」「第9話～13話」「16~20話」
const EP_RANGE = new RegExp(`第?\\s*${NUM}\\s*話?\\s*(?:[~〜\\-－ー]|から)\\s*第?\\s*${NUM}\\s*話`, "g");
// 「第8話」「8話」
const EP_SINGLE = new RegExp(`第?\\s*${NUM}\\s*話`, "g");
// 「Ep17」「ep.3」
const EP_EN = /\bep\.?\s*(\d+)/gi;
// 「全八話」（全話数。観た話数ではない）
const EP_TOTAL = new RegExp(`全\\s*${NUM}\\s*話`, "g");
// 日付・配信回数（話数ではない）
const NOISE_PATTERNS: RegExp[] = [
  /\d{4}[./年]\s*\d{1,2}[./月]\s*\d{1,2}日?/g,
  /\d{4}\/\d{1,2}/g,
  /\b\d{1,2}\/\d{1,2}\b/g,
  /[#＃]\s*\d+/g,
  /第\s*\d+\s*回/g,
  /\bno\.\s*\d+/gi,
  /開設\s*\d+\s*(?:年\s*\d+\s*)?ヶ?か?月目/g,
];
// 区切りの印（私用領域の文字）の手前で止める（話数の印が直後に来ても、タグを後ろへ伸ばさない）
const HASHTAG = /[#＃][^\s#＃【】「」『』〖〗〔〕\[\]()（）\uE000-\uF8FF]+/g;
/** 1枠で観る話数としてありえる範囲の上限（取り違え防止） */
const MAX_EPISODE_SPAN = 40;

// 「〜と見る」: 一緒に観る相手を前に置く書き方（「医療従事者と見るアンナチュラル」「下僕とハリーポッターみる」）
const WITH_VERB = "(?:一緒に)?(?:見る|観る|みる|見よう|観よう|みよう)";
const COMPANION_BEFORE = new RegExp(`^(.{1,15}?)と${WITH_VERB}(.{2,})$`);
const COMPANION_AFTER = new RegExp(`^(.{1,10}?)と(.{2,}?)(?:を)?${WITH_VERB}$`);
const COMPANION_PREFIX = /^(.{1,8}?)と(.{4,})$/;
const TITLE_VERB = /(見る|観る|みる|見よう|観よう|みよう|見ます|観ます)/;
// 部・1期の表記（区間から外した形も言い換えとして試す。部の特定は照合側で確かめる）
const PART_IN_TEXT = /\s*第[0-9一二三四五六七八九十]+部\s*|\s*(?<![a-z])part\s*\d+\s*/gi;
const FIRST_SEASON_IN_TEXT = /\s*(?:第?1期|1st\s*(?:season|シーズン)|season\s*1(?!\d)|シーズン\s*1(?!\d))\s*/gi;
// 期だけの括弧（「[46話～50話(2期)]」で話数を外したあとに残る「(2期)]」）
const SEASON_ONLY_PAREN = /[(（\[［]?\s*第?[0-9一二三四五六七八九十]+\s*期\s*[)）\]］]*/g;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 語を、間に空白が入っても一致する大文字小文字を区別しない正規表現にする */
function flexibleRe(word: string): RegExp {
  const chars = [...word.normalize("NFKC").toLowerCase().replace(/\s+/g, "")];
  return new RegExp(chars.map(escapeRe).join("\\s*"), "gi");
}

interface Compiled {
  notAWork: ReturnType<typeof compileTerms>;
  tagWords: ReturnType<typeof compileTerms>;
  noise: RegExp[];
  trim: string[];
  stop: Set<string>;
  programs: string[];
  quoteOverride: RegExp | null;
  listLine: RegExp;
}
const compiledCache = new WeakMap<ExtractConfig, Compiled>();

function compile(cfg: ExtractConfig): Compiled {
  let c = compiledCache.get(cfg);
  if (!c) {
    const verbs = (cfg.description_list_verbs ?? []).map((v) => escapeRe(v.normalize("NFKC"))).join("|") || "(?!)";
    c = {
      notAWork: compileTerms(cfg.not_a_work),
      tagWords: compileTerms(cfg.tag_words),
      noise: [...cfg.noise_words].sort((a, b) => b.length - a.length).map(flexibleRe),
      trim: [...cfg.trim_words].map((w) => w.normalize("NFKC").toLowerCase()).sort((a, b) => b.length - a.length),
      stop: new Set(cfg.stop_segments.map((w) => matchKey(w, cfg))),
      programs: (cfg.program_names ?? []).map((w) => looseKey(w)),
      quoteOverride: cfg.not_a_work_quote_override ? new RegExp(cfg.not_a_work_quote_override) : null,
      // 「A、B、Cを見ます✨」。動詞の後ろは記号・空白だけ
      listLine: new RegExp(`^(.*?)(?:を)?(?:${verbs})[\\s!！。.…~〜♪☆★]*$`),
    };
    compiledCache.set(cfg, c);
  }
  return c;
}

/** 区間の前後から記号と trim_words を外す */
export function trimSegment(s: string, cfg: ExtractConfig): string {
  const { trim } = compile(cfg);
  let t = s.replace(EDGE_PUNCT, "");
  for (let guard = 0; guard < 20; guard++) {
    const before = t;
    const lower = t.toLowerCase();
    // 「一緒に観ようッ」のように、語の後ろに小さい「ッ」や長音が付いている
    const tail = lower.match(/[ッっーｰ]+$/);
    if (tail && trim.some((w) => lower.slice(0, -tail[0].length).endsWith(w))) {
      t = t.slice(0, t.length - tail[0].length);
      continue;
    }
    for (const w of trim) {
      if (lower.startsWith(w)) {
        t = t.slice(w.length);
        // 前の語を外したあとに残る「の」（「実写のワンピ」「アニメの〇〇」）
        if (t.startsWith("の") && t.length > 2) t = t.slice(1);
        break;
      }
      if (lower.endsWith(w)) {
        t = t.slice(0, t.length - w.length);
        break;
      }
    }
    t = t.replace(EDGE_PUNCT, "");
    if (t === before) break;
  }
  return t;
}

function parseEpisodes(t: string): { groups: EpisodeRef[][]; episodes: EpisodeRef[]; text: string } {
  const groups: EpisodeRef[][] = [];
  const place = (refs: EpisodeRef[]) => {
    if (refs.length === 0) return MARK;
    groups.push(refs);
    return `${MARK}${EP_MARK}${idxChar(groups.length - 1)}${MARK}`;
  };
  // 「全八話」は全話数の表記で、観た話数ではない
  let text = t.replace(EP_TOTAL, MARK).replace(EP_RANGE, (_m, a: string, b: string) => {
    const from = parseKanjiNumber(a);
    const to = parseKanjiNumber(b);
    const refs: EpisodeRef[] = [];
    if (from !== null && to !== null && to >= from && to - from <= MAX_EPISODE_SPAN) {
      for (let n = from; n <= to; n++) refs.push({ number: n, number_text: `第${n}話` });
    }
    return place(refs);
  });
  text = text.replace(EP_SINGLE, (m, a: string) => {
    const n = parseKanjiNumber(a);
    return place(n !== null && n > 0 && n < 2000 ? [{ number: n, number_text: m.replace(/\s+/g, "") }] : []);
  });
  text = text.replace(EP_EN, (_m, a: string) => place([{ number: Number(a), number_text: `第${Number(a)}話` }]));
  const all = new Map<number, EpisodeRef>();
  for (const g of groups) for (const e of g) if (!all.has(e.number)) all.set(e.number, e);
  return { groups, episodes: [...all.values()].sort((a, b) => a.number - b.number), text };
}

interface Sink {
  programs: string[];
  dropped: string[];
}

/** 区間の外から分かる手がかり。verb: タイトルに「見る・観る・みる」などがある（「下僕と〇〇（字幕版）みる」） */
interface Hints {
  verb?: boolean;
}

function makeSegment(raw: string, from: Segment["from"], cfg: ExtractConfig, sink?: Sink, hints: Hints = {}): Segment | null {
  const c = compile(cfg);
  const spaced = raw.replace(/\s+/g, " ").trim();
  const text = trimSegment(spaced, cfg);
  if (text && c.programs.some((p) => looseKey(text).includes(p))) {
    sink?.programs.push(text);
    return null;
  }
  const key = matchKey(text, cfg);
  if (key.length < 2 || c.stop.has(key) || /^\d+$/.test(key)) {
    if (text) sink?.dropped.push(text);
    return null;
  }
  const subs: { text: string; key: string; kind: "multi" | "alt" }[] = [];
  const seen = new Set([key]);
  // min: 小区間の照合キーの最短の長さ（読み仮名の括弧などは2文字を許す）。trim: 前後の語を外すか
  const add = (raw: string, kind: "multi" | "alt", opt: { min?: number; trim?: boolean } = {}) => {
    const norm = raw.replace(/\s+/g, " ").trim();
    const pt = opt.trim === false ? norm.replace(EDGE_PUNCT, "") : trimSegment(norm, cfg);
    const pk = matchKey(pt, cfg);
    if (pk.length < (opt.min ?? 3) || c.stop.has(pk) || seen.has(pk) || /^\d+$/.test(pk)) return;
    if (c.programs.some((p) => looseKey(pt).includes(p))) return;
    seen.add(pk);
    subs.push({ text: pt, key: pk, kind });
  };
  if (from === "hashtag") return { text, key, from, subs };
  // 「/」は作品名に含まれる（Fate/Zero、アベンジャーズ/インフィニティ・ウォー）ので、
  // 和英併記（片側が英字だけ、もう片側が日本語）のときだけ、分ける前の形に加えて両側も小区間にする
  // （「カンフーハッスル/Kung Fu Hustle」）。判定は「！」などで分けたあとの小区間ごとに行う
  const japanese = (x: string) => /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(x);
  const bilingual = (p: string) => {
    const halves = p.split("/").map((x) => x.trim());
    return halves.length === 2 && halves.every((x) => x.length >= 2) && halves.some((x) => /^[\x20-\x7E]+$/.test(x)) && halves.some(japanese);
  };
  // 「＆」「×」「+」は複数作品の区切り（「仮面ライダーセイバー＆キラメイジャー」）
  const multi = text.split(/[&＆×＋+]/);
  for (const m of multi) {
    const kindOf = multi.length > 1 ? "multi" : "alt";
    for (const piece of m.split(/[!！?？]+|\s{2,}|　|、/)) {
      const p = trimSegment(piece.trim(), cfg);
      add(p, kindOf);
      if (bilingual(p)) for (const half of p.split("/")) add(half, "alt");
    }
  }
  // 以下はすべて同じ作品の言い換え（区間そのものが一致しなかったときだけ試す）
  // 「〜と見る」: 一緒に観る相手の語を外す
  const before = text.match(COMPANION_BEFORE);
  if (before) add(before[2]!, "alt", { min: 2 });
  const after = spaced.replace(EDGE_PUNCT, "").match(COMPANION_AFTER);
  if (after) add(after[2]!, "alt", { min: 2 });
  // 動詞が区間の外にある「下僕と83歳のやさしいスパイ（字幕版）みる」: タイトルに動詞があれば、先頭の「〇〇と」を外した形も試す
  const prefix = hints.verb ? text.match(COMPANION_PREFIX) : null;
  if (prefix) add(prefix[2]!, "alt");
  // 読み仮名の括弧（「刃牙（バキ）」「Fallout（フォールアウト）」）と「LOKI -ロキ-」。
  // 括弧の後ろに語が続く「スプライス(SPLICE)を一緒に見よう」は、前後の語を外した形でも見る
  for (const src of [spaced.replace(EDGE_PUNCT, ""), text]) {
    const paren = src.match(/^(.+?)\s*[(（]([^()（）]+)[)）]?$/);
    if (paren && !/^第?[0-9一二三四五六七八九十]+\s*期$/.test(paren[2]!.trim())) {
      add(paren[1]!, "alt", { min: 2 });
      add(paren[2]!, "alt", { min: 2 });
    }
  }
  // 和英を空白で並べた区間: 両側を試す。英字の側が作品名の一部（「BLEACH 千年血戦篇」「進撃の巨人 OAD」「きさらぎ駅 Re:」）のことが多いので絞る
  //   日本語が先: 英字の側が照合キーで5文字以上で、期・部の表記や OAD などでない（「ベイマックス Big Hero 6」「ヴェノム VENOM」）
  //   英字が先:   日本語の側がカタカナだけ（読み・略称。「STEINS;GATE シュタゲ」「/ODDTAXI オッドタクシー」）
  const tokens = text.split(" ");
  const ascii = (x: string) => /^[\x20-\x7E]+$/.test(x) && /[A-Za-z]/.test(x);
  const qualifier = (x: string) => {
    const m = markersOf(x, cfg);
    return m.season.size > 0 || m.part.size > 0 || /^(oad|ova|sp|tv|movie|themovie|re)$/.test(matchKey(x, cfg));
  };
  for (let i = 1; i < tokens.length; i++) {
    const l = tokens.slice(0, i).join(" "), r = tokens.slice(i).join(" ");
    const jpFirst = japanese(l) && !/[A-Za-z]/.test(l) && ascii(r) && matchKey(r, cfg).length >= 5 && !qualifier(r);
    const enFirst = ascii(l) && /^[\p{Script=Katakana}ー・\s]+$/u.test(r) && matchKey(r, cfg).length >= 3;
    if (jpFirst || enFirst) {
      add(l, "alt", { min: 2 });
      add(r, "alt", { min: 2 });
    }
  }
  // 前置きの「〇〇監督作品」「劇場版」「映画」を外した形（「新海誠監督作品 君の名は。」「劇場版 名探偵コナン ベイカー街の亡霊」）
  const noDirector = text.replace(/^.{0,12}?監督(?:作品)?\s*/, "");
  if (noDirector !== text) add(noDirector, "alt");
  const noMovie = text.replace(/^(?:劇場版|映画)\s*/, "");
  if (noMovie !== text) add(noMovie, "alt");
  // 先頭の短い語を外した形（「大人なカートゥーン ハズビンホテルへようこそ」）。後ろが6文字以上で、両側とも日本語のときだけ
  // （「I.presage flower」から「flower」を切り出さない）
  if (tokens.length >= 2 && [...tokens[0]!].length <= 12 && !/\d/.test(tokens[0]!) && japanese(tokens[0]!)) {
    const rest = tokens.slice(1).join(" ");
    if (japanese(rest) && matchKey(rest, cfg).length >= 6) add(rest, "alt");
  }
  const dash = text.match(/^([\x20-\x7E]+?)\s+-\s*([^-]+?)\s*-?$/);
  if (dash && japanese(dash[2]!)) {
    add(dash[1]!, "alt", { min: 2 });
    add(dash[2]!, "alt", { min: 2 });
  }
  // 部・1期の表記を外した形（「ジョジョの奇妙な冒険 第3部 スターダストクルセイダース」→ 副題で部が分かる形）
  const noPart = text.replace(PART_IN_TEXT, " ").trim();
  if (noPart !== text) add(noPart, "alt");
  const noFirst = text.replace(FIRST_SEASON_IN_TEXT, " ").trim();
  if (noFirst !== text) add(noFirst, "alt");
  const noSeasonParen = text.replace(SEASON_ONLY_PAREN, " ").trim();
  if (noSeasonParen !== text) add(noSeasonParen, "alt");
  // 前後の語を外しすぎた（「その着せ替え人形は恋をする」→「…恋」）: 記号だけ外した形も試す
  const edgeOnly = spaced.replace(EDGE_PUNCT, "");
  if (edgeOnly !== text) add(edgeOnly, "alt", { trim: false });

  // 区間の直後に「!」「?」があれば、Wikipedia の記事名ではそれを残した形も試す（「カラオケ行こ!」）
  const n = spaced.normalize("NFKC");
  const at = n.indexOf(text);
  const next = at >= 0 ? n[at + text.length] : undefined;
  const wp = next && /[!?]/.test(next) ? `${text}${next}` : undefined;
  return { text, key, from, subs, ...(wp ? { wp } : {}) };
}

export function extract(title: string, cfg: ExtractConfig): Extracted {
  const c = compile(cfg);
  // 構造上の区切り（全角スラッシュなど）は NFKC の前に印を付ける（NFKC で「／」が「/」になり作品名の「/」と区別できなくなるため）。
  // ただし作品名を括る括弧（『』「」など）の中は区切らない（「シビル・ウォー／キャプテン・アメリカ」「HELP／復讐島」）
  const quoteRe = new RegExp(cfg.quote_brackets.map(([o, cl]) => `${escapeRe(o)}[^${escapeRe(o)}${escapeRe(cl)}]*${escapeRe(cl)}`).join("|"), "g");
  // 作品名の括弧の中の「#」はハッシュタグではなく装飾（「機動戦士ガンダム #水星の魔女」）なので、記号だけ消す
  let t = title
    .replace(INVISIBLE, "")
    .replace(CIRCLED_COUNTER, `${MARK}${CNT_MARK}${MARK}`)
    .replace(quoteRe, (m) => m.replace(/／/g, "/").replace(/[｜|┊┆⋮︙✦✧ˎˊ˗▶▷◀◁]/g, " ").replace(/[#＃]/g, " "))
    .replace(STRUCT_SEPARATORS, MARK)
    .normalize("NFKC")
    .replace(EMOJI, " ");

  // 作品ではない同時視聴の語。ハッシュタグの中も見る（大会名・イベント名はハッシュタグに書かれることが多い。「#日本ダービー」）
  const naw = c.notAWork.find((m) => m.test(spacedKey(title)));
  const notAWorkQuoteOnly = !!naw && !!c.quoteOverride?.test(title.normalize("NFKC"));

  const ep = parseEpisodes(t);
  t = ep.text;
  for (const re of NOISE_PATTERNS) t = t.replace(re, MARK);
  const tags: string[] = [];
  t = t.replace(HASHTAG, (m) => {
    tags.push(m.slice(1));
    return `${MARK}${HT_MARK}${idxChar(tags.length - 1)}${MARK}`;
  });

  // タグの括弧: 配信者名・所属を含むものは中身ごと捨て、それ以外は中身を区間にする。
  // 作品名の括弧より先に処理する（【にじさんじ 4th Anniversary「FANTASIA」】の中の「FANTASIA」を作品名の候補にしない）
  for (const [open, close] of cfg.tag_brackets) {
    const o = escapeRe(open.normalize("NFKC"));
    const cl = escapeRe(close.normalize("NFKC"));
    t = t.replace(new RegExp(`${o}([^${o}${cl}]*)${cl}`, "g"), (_m, inner: string) => {
      const k = spacedKey(inner);
      return c.tagWords.some((w) => w.test(k)) ? MARK : `${MARK}${inner}${MARK}`;
    });
  }
  // 区間の直後に続く作品名の括弧（「ドラゴンボール超「ブロリー」」）は副題。区間と副題をつなげた作品名も試し、
  // 区間だけでの一致は採用しない（シリーズ名だけでテレビシリーズに当たるのを防ぐ）。括弧が続けて並べば同じ区間の副題とみなす
  const allQuotes = new RegExp(cfg.quote_brackets.map(([o, cl]) => {
    const on = escapeRe(o.normalize("NFKC")), cn = escapeRe(cl.normalize("NFKC"));
    return `${on}([^${on}${cn}]*)${cn}`;
  }).join("|"), "g");
  const subtitlePairs: { prefix: string; inner: string }[] = [];
  {
    let lastEnd = -1;
    let lastPrefix: string | null = null;
    for (const m of t.matchAll(allQuotes)) {
      const start = m.index!;
      const inner = m.slice(1).find((x) => x !== undefined) ?? "";
      let prefix: string | null = null;
      if (lastEnd >= 0 && t.slice(lastEnd, start).trim() === "" && lastPrefix) prefix = lastPrefix;
      else {
        let p = t.slice(0, start);
        p = p.slice(p.lastIndexOf(MARK) + 1);
        for (const re of c.noise) p = p.replace(re, MARK);
        p = (p.split(MARK).pop() ?? "").trim();
        prefix = p && matchKey(trimSegment(p, cfg), cfg).length >= 2 ? p : null;
      }
      if (prefix && inner.trim()) subtitlePairs.push({ prefix, inner: inner.trim() });
      lastPrefix = prefix;
      lastEnd = start + m[0].length;
    }
  }
  // 作品名を括る括弧: 中身を優先の区間にする（本文にも区切り付きで残す）
  const quoted: string[] = [];
  for (const [open, close] of cfg.quote_brackets) {
    const o = escapeRe(open.normalize("NFKC"));
    const cl = escapeRe(close.normalize("NFKC"));
    t = t.replace(new RegExp(`${o}([^${o}${cl}]*)${cl}`, "g"), (_m, inner: string) => {
      quoted.push(inner);
      return `${MARK}${inner}${MARK}`;
    });
  }
  // ノイズ語を区切りに置き換える（区間の中に残ったものも含めて）
  for (const re of c.noise) t = t.replace(re, MARK);

  const sink: Sink = { programs: [], dropped: [] };
  const hints: Hints = { verb: TITLE_VERB.test(title.normalize("NFKC")) };
  const segments: Segment[] = [];
  const seen = new Set<string>();
  const quoteKeys = new Set<string>();
  for (const q of quoted) {
    let qt = q;
    for (const re of c.noise) qt = qt.replace(re, MARK);
    for (const part of qt.split(MARK)) {
      if (part.includes(EP_MARK) || part.includes(HT_MARK)) continue;
      const s = makeSegment(part, "quote", cfg, sink, hints);
      if (s && !seen.has(s.key)) {
        seen.add(s.key);
        quoteKeys.add(s.key);
        segments.push(s);
      }
    }
  }

  // ハッシュタグ（配信者名・所属のタグは除く）。中のノイズ語でも区切る（「#んなたんと同時視聴」）
  const hashtags: Segment[] = [];
  const tagKeys: (string | null)[] = tags.map((tag) => {
    if (c.tagWords.some((w) => w.test(spacedKey(tag)))) return null;
    let x = tag.replace(/_/g, " ");
    for (const re of c.noise) x = x.replace(re, MARK);
    let first: string | null = null;
    for (const part of x.split(MARK)) {
      const s = makeSegment(part, "hashtag", cfg);
      if (s && !hashtags.some((h) => h.key === s.key)) hashtags.push(s);
      if (s && !first) first = s.key;
    }
    return first;
  });

  // 本文の区間と、話数・ハッシュタグの並び
  const layout: LayoutItem[] = [];
  const quoteSink: Sink = { programs: [], dropped: [] };
  for (const raw of t.split(MARK)) {
    const part = raw.trim();
    if (part.startsWith(EP_MARK)) {
      layout.push({ t: "ep", g: idxOf(part) });
      continue;
    }
    if (part.startsWith(HT_MARK)) {
      const k = tagKeys[idxOf(part)];
      if (k) layout.push({ t: "seg", key: k, quote: false });
      continue;
    }
    if (part.startsWith(CNT_MARK)) {
      layout.push({ t: "cnt" });
      continue;
    }
    // 括弧の中身は本文にも残っているので、区間の重複は作らず並びだけ記録する
    const s = makeSegment(part, "title", cfg, seen.has(matchKey(trimSegment(part, cfg), cfg)) ? quoteSink : sink, hints);
    if (!s) continue;
    layout.push({ t: "seg", key: s.key, quote: quoteKeys.has(s.key) });
    if (!seen.has(s.key)) {
      seen.add(s.key);
      segments.push(s);
    }
  }

  // 副題: 区間の小区間の先頭に「区間（とその言い換え）+ 副題」を足す（副題ごとに別作品になりうるので multi）
  const subtitled = new Map<string, string[]>();
  for (const { prefix, inner } of subtitlePairs) {
    const ps = makeSegment(prefix, "title", cfg);
    const seg = ps ? segments.find((s) => s.key === ps.key && s.from !== "quote") : undefined;
    if (!seg) continue;
    const innerKey = matchKey(trimSegment(inner, cfg), cfg);
    if (innerKey.length < 1) continue;
    subtitled.set(seg.key, [...(subtitled.get(seg.key) ?? []), innerKey]);
    const bases = [seg.text, ...seg.subs.filter((x) => x.kind === "alt").map((x) => x.text)];
    const extra: Segment["subs"] = [];
    for (const b of bases) {
      const text = `${b} ${inner.trim()}`;
      const key = matchKey(text, cfg);
      if (key.length >= 3 && !extra.some((x) => x.key === key) && !seg.subs.some((x) => x.key === key)) extra.push({ text, key, kind: "multi" });
    }
    seg.subs.unshift(...extra);
  }
  // 丸数字の番号が直後に付いた区間（「パイカリ③」。映画なら何作目か分からない）
  const numbered = new Set<string>();
  layout.forEach((x, i) => {
    if (x.t === "seg" && layout[i + 1]?.t === "cnt") numbered.add(x.key);
  });

  const cleaned = t
    .replace(new RegExp(`${EP_MARK}.`, "g"), "(話数)")
    .replace(new RegExp(`${HT_MARK}.`, "g"), "(タグ)")
    .replace(new RegExp(CNT_MARK, "g"), "(番号)")
    .split(MARK).map((x) => x.trim()).filter(Boolean).join(" | ");
  return {
    notAWork: naw ? naw.raw : null,
    notAWorkQuoteOnly,
    segments,
    hashtags,
    episodes: ep.episodes,
    episodeGroups: ep.groups,
    layout,
    subtitled,
    numbered,
    programs: sink.programs,
    dropped: sink.dropped,
    cleaned,
  };
}

/**
 * 概要欄から作品名の候補を切り出す。タイトルで見つからなかったときだけ使う。
 * その枠自体を指す語（今日・本日・を見ます など）を含む行の
 *   - 括弧（『』「」）の中身
 *   - 読点で並べた作品名の列挙（「キミとアイドルプリキュア♪、仮面ライダーガヴ、ナンバーワン戦隊ゴジュウジャーを見ます✨」）
 * を候補にする。列挙の各項目は末尾の記号を残す（「♪」まで作品名）。
 * 列挙はタイトルに作品名の区間が無い枠だけで使う（opts.lists = false で使わない）。
 */
export function extractFromDescription(
  description: string,
  selfWords: string[],
  cfg: ExtractConfig,
  opts: { lists?: boolean } = {},
): Segment[] {
  const c = compile(cfg);
  const out: Segment[] = [];
  const self = compileTerms(selfWords);
  const push = (s: Segment | null) => {
    if (s && !out.some((x) => x.key === s.key)) out.push(s);
  };
  for (const line of description.split(/\r?\n/)) {
    if (!self.some((m) => m.test(spacedKey(line)))) continue;
    const n = line.replace(INVISIBLE, "").normalize("NFKC").replace(EMOJI, " ").trim();
    for (const [open, close] of cfg.quote_brackets) {
      const o = escapeRe(open.normalize("NFKC"));
      const cl = escapeRe(close.normalize("NFKC"));
      for (const m of n.matchAll(new RegExp(`${o}([^${o}${cl}]*)${cl}`, "g"))) push(makeSegment(m[1]!, "description", cfg));
    }
    // 作品名の列挙は、タイトルに作品名の区間が無い枠だけ（「新機動戦記ガンダムW、EndlessWaltzを見ます」を2作品にしない）
    const list = opts.lists === false ? null : n.match(c.listLine);
    if (!list) continue;
    const items = list[1]!.split(/[、,，]/).map((x) => x.trim()).filter(Boolean);
    if (items.length < 2) continue;
    for (const item of items) push(makeSegment(item.replace(/^[「『]|[」』]$/g, ""), "description", cfg));
  }
  return out;
}
