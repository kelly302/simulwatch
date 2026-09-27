import type { ExtractConfig } from "./config.ts";

// 照合用の正規化（純粋関数）。作品名どうしを比べるときは必ずこれを通す。
// 原文は書き換えない。

const stripCache = new WeakMap<ExtractConfig, Set<string>>();
const seasonCache = new WeakMap<ExtractConfig, RegExp[]>();

function stripSet(cfg: ExtractConfig): Set<string> {
  let s = stripCache.get(cfg);
  if (!s) {
    s = new Set([...cfg.match_normalize.strip_chars.normalize("NFKC")]);
    // NFKC 前の全角記号も念のため入れる
    for (const ch of cfg.match_normalize.strip_chars) s.add(ch);
    stripCache.set(cfg, s);
  }
  return s;
}

function seasonRes(cfg: ExtractConfig): RegExp[] {
  let r = seasonCache.get(cfg);
  if (!r) {
    r = cfg.match_normalize.season_patterns.map((p) => new RegExp(p, "g"));
    seasonCache.set(cfg, r);
  }
  return r;
}

/**
 * 照合キー。NFKC → 小文字 → 空白を詰めて期・シーズンの表記をそろえる → 記号を落とす。
 * 例: 「進撃の巨人 Season 3」「進撃の巨人 3期」→ "進撃の巨人season3"
 */
export function matchKey(s: string, cfg: ExtractConfig): string {
  // BOM・ゼロ幅の文字は落とす（Wikidata のラベルに BOM が混じる。「\uFEFF亜人」）
  // \u7D75\u6587\u5B57\u3082\u843D\u3068\u3059\uFF08\u300C\u3086\u308B\u304D\u3083\u3093\u0394\uD83C\uDFD5\u300D\uFF09
  let t = s.normalize("NFKC").toLowerCase().replace(/[\s\uFEFF\u200B-\u200D\u2060\uFE0E\uFE0F]+|\p{Extended_Pictographic}/gu, "");
  const fold = cfg.match_normalize.fold_chars;
  if (fold) t = [...t].map((ch) => fold[ch] ?? ch).join("");
  // ひらがなをカタカナに寄せる（「ゆるきゃん」と「ゆるキャン」）
  if (cfg.match_normalize.fold_kana) t = t.replace(/[\u3041-\u3096]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 0x60));
  for (const re of seasonRes(cfg)) t = t.replace(re, "season$1");
  const strip = stripSet(cfg);
  return [...t].filter((ch) => !strip.has(ch)).join("");
}

/** 部分一致の照合用（not_a_work・タグ語）。NFKC → 小文字 → 空白除去 */
export function looseKey(s: string): string {
  return s.normalize("NFKC").toLowerCase().replace(/\s+/g, "");
}

/** 語の照合用。NFKC → 小文字（空白は残す）。正規表現の単語境界を効かせるため空白を詰めない */
export function spacedKey(s: string): string {
  return s.normalize("NFKC").toLowerCase();
}

type Matcher = { raw: string; test: (spaced: string) => boolean };

/**
 * 語のリストを照合器にする。test には spacedKey() の値を渡す。
 * 普通の語は空白を詰めて部分一致（「同時 視聴」も拾う）、"re:" で始まる語は空白を残した文字列に正規表現を当てる。
 */
export function compileTerms(terms: string[]): Matcher[] {
  return terms.map((term) => {
    if (term.startsWith("re:")) {
      const re = new RegExp(term.slice(3));
      return { raw: term, test: (s: string) => re.test(s) };
    }
    const k = looseKey(term);
    return { raw: term, test: (s: string) => k.length > 0 && s.replace(/\s+/g, "").includes(k) };
  });
}
