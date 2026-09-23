import type { DetectConfig } from "../lib/config.ts";
import type { DetectSource } from "../shared/types.ts";

// 同時視聴枠のキーワード判定（純粋関数）。
// 語彙と正規化ルールは config/detect.yaml にあり、ここには埋めない。

export interface DetectInput {
  title: string;
  description: string | null;
  /** 定型文とみなす概要欄の行（正規化済み）。templateLines() で作る */
  templateLines?: Set<string>;
}

export type DetectResult =
  | { hit: true; source: DetectSource; keyword: string }
  | { hit: false; excludedBy?: string };

/** 照合用に正規化する。原文は書き換えない（呼び出し側で別に持つ） */
export function normalize(s: string, cfg: DetectConfig["normalize"]): string {
  let t = s;
  if (cfg.nfkc) t = t.normalize("NFKC");
  if (cfg.lowercase) t = t.toLowerCase();
  if (cfg.strip_chars) {
    const strip = new Set([...cfg.strip_chars.normalize(cfg.nfkc ? "NFKC" : "NFC")]);
    t = [...t].filter((ch) => !strip.has(ch)).join("");
  }
  return t;
}

type Matcher = { raw: string; test: (s: string) => boolean };

const cache = new WeakMap<DetectConfig, Compiled>();

interface Compiled {
  titleInclude: Matcher[];
  titleExclude: Matcher[];
  descInclude: Matcher[];
  descExclude: Matcher[];
  lineRequire: Matcher[];
  lineExclude: Matcher[];
  members: Matcher[];
  hints: Matcher[];
}

function compileTerm(term: string, cfg: DetectConfig): Matcher {
  if (term.startsWith("re:")) {
    const re = new RegExp(term.slice(3));
    return { raw: term, test: (s) => re.test(s) };
  }
  const n = normalize(term, cfg.normalize);
  return { raw: term, test: (s) => n.length > 0 && s.includes(n) };
}

function compile(cfg: DetectConfig): Compiled {
  let c = cache.get(cfg);
  if (!c) {
    const m = (terms: string[] | undefined) => (terms ?? []).map((t) => compileTerm(t, cfg));
    c = {
      titleInclude: m(cfg.title.include),
      titleExclude: m(cfg.title.exclude),
      descInclude: m(cfg.description.include),
      descExclude: m(cfg.description.exclude),
      lineRequire: m(cfg.description.line_require),
      lineExclude: m(cfg.description.line_exclude),
      members: m(cfg.members_only.title_include),
      hints: m(cfg.review_hints),
    };
    cache.set(cfg, c);
  }
  return c;
}

function firstMatch(ms: Matcher[], s: string): Matcher | undefined {
  return ms.find((m) => m.test(s));
}

export function detect(input: DetectInput, cfg: DetectConfig): DetectResult {
  const c = compile(cfg);
  const title = normalize(input.title, cfg.normalize);

  const tHit = firstMatch(c.titleInclude, title);
  if (tHit) {
    const ex = firstMatch(c.titleExclude, title);
    if (!ex) return { hit: true, source: "title", keyword: tHit.raw };
    // タイトルの除外語に当たっても、概要欄に別の根拠があればそちらを見る
  }

  if (cfg.description.enabled && input.description) {
    for (const line of input.description.split(/\r?\n/)) {
      const l = normalize(line, cfg.normalize);
      if (input.templateLines?.has(l)) continue;
      const dHit = firstMatch(c.descInclude, l);
      if (!dHit) continue;
      if (firstMatch(c.descExclude, l)) continue;
      // その枠自体を指す語（今日・本日・今回 など）が同じ行に無ければヒットにしない
      if (c.lineRequire.length > 0 && !firstMatch(c.lineRequire, l)) continue;
      if (firstMatch(c.lineExclude, l)) continue;
      return { hit: true, source: "description", keyword: dHit.raw };
    }
  }

  if (tHit) return { hit: false, excludedBy: firstMatch(c.titleExclude, title)?.raw };
  return { hit: false };
}

/**
 * 同じチャンネルの複数の動画の概要欄に繰り返し出てくる行を集める（チャンネル紹介・メンバー特典などの定型文）。
 * 1本の概要欄の中での重複は1回と数える。空行は数えない。
 */
export function templateLines(descriptions: (string | null)[], cfg: DetectConfig): Set<string> {
  const min = cfg.description.template_min_repeats;
  const count = new Map<string, number>();
  for (const d of descriptions) {
    if (!d) continue;
    const seen = new Set<string>();
    for (const line of d.split(/\r?\n/)) {
      const l = normalize(line, cfg.normalize);
      if (l.length === 0 || seen.has(l)) continue;
      seen.add(l);
      count.set(l, (count.get(l) ?? 0) + 1);
    }
  }
  const out = new Set<string>();
  if (!min || min < 2) return out;
  for (const [l, n] of count) if (n >= min) out.add(l);
  return out;
}

/** タイトルからメン限枠かどうかを推定する */
export function isMembersTitle(title: string, cfg: DetectConfig): boolean {
  return !!firstMatch(compile(cfg).members, normalize(title, cfg.normalize));
}

/** 取りこぼし調査用。判定に使わないヒント語のうちタイトルに含まれるもの */
export function reviewHints(title: string, cfg: DetectConfig): string[] {
  const t = normalize(title, cfg.normalize);
  return compile(cfg).hints.filter((m) => m.test(t)).map((m) => m.raw);
}
