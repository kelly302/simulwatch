import type { ExtractConfig } from "./config.ts";
import { compileTerms, matchKey, spacedKey } from "./normalize.ts";

// 枠タイトルから作品名の候補（区間）と話数を切り出す（純粋関数）。
//
// 区間の作り方
//   - 括弧・ノイズ語（同時視聴・メン限 など）・「｜」「／」・装飾記号を区切りにして、タイトルを区間に分ける
//   - 半角の「/」では区切らない（Fate/Apocrypha など作品名に含まれる）
//   - 単独の空白でも区切らない（「ジョジョの奇妙な冒険 第3部 …」の先頭だけを切り出して誤同定しないため）
//   - 区間の前後にある「を見る」「続き」などの語は外す（trim_words）
// 照合側は「区間まるごとが作品名と一致したとき」だけ採用する。

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
  from: "quote" | "title" | "description";
  /**
   * 区間が一致しなかったときに試す小区間。部分的なので確度は下がる。
   * kind: multi は「＆」「×」「+」で分けたもの（複数作品になりうる）、alt は「！」や和英併記で分けたもの（同じ作品の言い換え）
   */
  subs: { text: string; key: string; kind: "multi" | "alt" }[];
}

export interface Extracted {
  /** 作品ではない同時視聴と判定した語（Direct・競馬 など）。null なら作品の可能性あり */
  notAWork: string | null;
  segments: Segment[];
  episodes: EpisodeRef[];
  /** 区切りを入れたあとの文字列（デバッグ・頻出パターンの集計用） */
  cleaned: string;
}

const MARK = "";
// 区切りとして扱う文字（NFKC の前後どちらでも）
const STRUCT_SEPARATORS = /[／｜|┊┆⋮︙✦✧ˎˊ˗▶▷◀◁​]/g;
// 絵文字は落とす（☆ などの作品名に入りうる記号は残す）
const EMOJI = /[\p{Emoji_Presentation}️‍]/gu;
const EDGE_PUNCT = /^[\s!！?？、。,.：:;；・･~〜…‥\-‐－―*＊"'“”‘’()（）\[\]［］]+|[\s!！?？、。,.：:;；・･~〜…‥\-‐－―*＊"'“”‘’()（）\[\]［］]+$/g;

const KANJI_DIGIT: Record<string, number> = {
  〇: 0, 零: 0, 一: 1, 壱: 1, 二: 2, 弐: 2, 三: 3, 参: 3, 四: 4, 肆: 4, 五: 5, 伍: 5,
  六: 6, 陸: 6, 七: 7, 漆: 7, 八: 8, 捌: 8, 九: 9, 玖: 9,
};

/** 漢数字（十・百まで）を数値にする。読めなければ null */
export function parseKanjiNumber(s: string): number | null {
  if (/^\d+$/.test(s)) return Number(s);
  let total = 0;
  let cur = 0;
  for (const ch of s) {
    if (ch in KANJI_DIGIT) cur = KANJI_DIGIT[ch]!;
    else if (ch === "十" || ch === "拾") {
      total += (cur || 1) * 10;
      cur = 0;
    } else if (ch === "百") {
      total += (cur || 1) * 100;
      cur = 0;
    } else return null;
  }
  return total + cur;
}

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
const HASHTAG = /#[^\s#【】「」『』〖〗\[\]()（）]+/g;
/** 1枠で観る話数としてありえる範囲の上限（取り違え防止） */
const MAX_EPISODE_SPAN = 40;

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
}
const compiledCache = new WeakMap<ExtractConfig, Compiled>();

function compile(cfg: ExtractConfig): Compiled {
  let c = compiledCache.get(cfg);
  if (!c) {
    c = {
      notAWork: compileTerms(cfg.not_a_work),
      tagWords: compileTerms(cfg.tag_words),
      noise: [...cfg.noise_words].sort((a, b) => b.length - a.length).map(flexibleRe),
      trim: [...cfg.trim_words].map((w) => w.normalize("NFKC").toLowerCase()).sort((a, b) => b.length - a.length),
      stop: new Set(cfg.stop_segments.map((w) => matchKey(w, cfg))),
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
    for (const w of trim) {
      if (lower.startsWith(w)) {
        t = t.slice(w.length);
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

function parseEpisodes(t: string): { episodes: EpisodeRef[]; text: string } {
  const eps = new Map<number, EpisodeRef>();
  // 「全八話」は全話数の表記で、観た話数ではない
  let text = t.replace(EP_TOTAL, MARK).replace(EP_RANGE, (m, a: string, b: string) => {
    const from = parseKanjiNumber(a);
    const to = parseKanjiNumber(b);
    if (from !== null && to !== null && to >= from && to - from <= MAX_EPISODE_SPAN) {
      for (let n = from; n <= to; n++) eps.set(n, { number: n, number_text: `第${n}話` });
    }
    return MARK;
  });
  text = text.replace(EP_SINGLE, (m, a: string) => {
    const n = parseKanjiNumber(a);
    if (n !== null && n > 0 && n < 2000) eps.set(n, { number: n, number_text: m.replace(/\s+/g, "") });
    return MARK;
  });
  text = text.replace(EP_EN, (m, a: string) => {
    const n = Number(a);
    eps.set(n, { number: n, number_text: `第${n}話` });
    return MARK;
  });
  return { episodes: [...eps.values()].sort((a, b) => a.number - b.number), text };
}

function makeSegment(raw: string, from: Segment["from"], cfg: ExtractConfig): Segment | null {
  const { stop } = compile(cfg);
  const text = trimSegment(raw.replace(/\s+/g, " ").trim(), cfg);
  const key = matchKey(text, cfg);
  if (key.length < 2 || stop.has(key) || /^\d+$/.test(key)) return null;
  // 「！」「？」、複数作品の区切り（＆ & ×）、全角空白・連続空白で分けた小区間
  const subs: { text: string; key: string; kind: "multi" | "alt" }[] = [];
  const seen = new Set([key]);
  const add = (raw: string, kind: "multi" | "alt") => {
    const pt = trimSegment(raw.trim(), cfg);
    const pk = matchKey(pt, cfg);
    if (pk.length < 3 || stop.has(pk) || seen.has(pk) || /^\d+$/.test(pk)) return;
    seen.add(pk);
    subs.push({ text: pt, key: pk, kind });
  };
  // 「/」は作品名に含まれる（Fate/Zero、アベンジャーズ/インフィニティ・ウォー）ので、
  // 和英併記（片側が英字だけ、もう片側が日本語）のときだけ、分ける前の形に加えて両側も小区間にする
  // （「カンフーハッスル/Kung Fu Hustle」）。判定は「！」などで分けたあとの小区間ごとに行う
  const bilingual = (p: string) => {
    const halves = p.split("/").map((x) => x.trim());
    return (
      halves.length === 2 &&
      halves.every((x) => x.length >= 2) &&
      halves.some((x) => /^[\x20-\x7E]+$/.test(x)) &&
      halves.some((x) => /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(x))
    );
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
  return { text, key, from, subs };
}

export function extract(title: string, cfg: ExtractConfig): Extracted {
  const c = compile(cfg);
  // 構造上の区切り（全角スラッシュなど）は NFKC の前に印を付ける（NFKC で「／」が「/」になり作品名の「/」と区別できなくなるため）。
  // ただし作品名を括る括弧（『』「」など）の中は区切らない（「シビル・ウォー／キャプテン・アメリカ」「HELP／復讐島」）
  const quoteRe = new RegExp(cfg.quote_brackets.map(([o, cl]) => `${escapeRe(o)}[^${escapeRe(o)}${escapeRe(cl)}]*${escapeRe(cl)}`).join("|"), "g");
  let t = title
    .replace(quoteRe, (m) => m.replace(/／/g, "/").replace(/[｜|┊┆⋮︙✦✧ˎˊ˗▶▷◀◁​]/g, " "))
    .replace(STRUCT_SEPARATORS, MARK)
    .normalize("NFKC")
    .replace(EMOJI, " ");

  const naw = c.notAWork.find((m) => m.test(spacedKey(title)));

  const ep = parseEpisodes(t);
  t = ep.text;
  for (const re of NOISE_PATTERNS) t = t.replace(re, MARK);
  t = t.replace(HASHTAG, MARK);

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

  const segments: Segment[] = [];
  const seen = new Set<string>();
  const push = (raw: string, from: Segment["from"]) => {
    for (const part of raw.split(MARK)) {
      const s = makeSegment(part, from, cfg);
      if (s && !seen.has(s.key)) {
        seen.add(s.key);
        segments.push(s);
      }
    }
  };
  for (const q of quoted) {
    let qt = q;
    for (const re of c.noise) qt = qt.replace(re, MARK);
    push(qt, "quote");
  }
  push(t, "title");

  return { notAWork: naw ? naw.raw : null, segments, episodes: ep.episodes, cleaned: t.split(MARK).map((x) => x.trim()).filter(Boolean).join(" | ") };
}

/**
 * 概要欄から作品名の候補を切り出す。タイトルで見つからなかったときだけ使う。
 * その枠自体を指す語（今日・本日 など）を含む行の、括弧（『』「」）の中身だけを候補にする。
 */
export function extractFromDescription(description: string, selfWords: string[], cfg: ExtractConfig): Segment[] {
  const out: Segment[] = [];
  const self = compileTerms(selfWords);
  for (const line of description.split(/\r?\n/)) {
    if (!self.some((m) => m.test(spacedKey(line)))) continue;
    const n = line.normalize("NFKC");
    for (const [open, close] of cfg.quote_brackets) {
      const o = escapeRe(open.normalize("NFKC"));
      const cl = escapeRe(close.normalize("NFKC"));
      for (const m of n.matchAll(new RegExp(`${o}([^${o}${cl}]*)${cl}`, "g"))) {
        const s = makeSegment(m[1]!, "description", cfg);
        if (s && !out.some((x) => x.key === s.key)) out.push(s);
      }
    }
  }
  return out;
}
