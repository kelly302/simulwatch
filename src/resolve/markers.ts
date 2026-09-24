import type { ExtractConfig } from "./config.ts";
import { parseKanjiNumber } from "./kanji.ts";

// タイトル・作品名の「期」と「部」の表記（純粋関数）。語彙は config/extract.yaml の title_markers。
//
//   期（season）: アニメのDB（Annict・AniList）は期ごとに別作品。タイトルに期の表記があれば、その期を持たない作品には同定しない
//   部（part）:   作品名に部の表記が無いことが多い（ジョジョの各部は副題で区別される）。部が特定できなければ同定しない

export interface Markers {
  /** 期のタグ（s2・final・after など）→ 照合キーの末尾の候補（「区間 + 期」で作品名を作り直すときに使う） */
  season: Map<string, string[]>;
  /** 部のタグ（p3 など） */
  part: Set<string>;
}

interface CompiledMarker {
  kind: "season" | "part";
  re: RegExp;
  tag: string;
  suffixes: string[];
}
const compiled = new WeakMap<ExtractConfig, CompiledMarker[]>();

function compile(cfg: ExtractConfig): CompiledMarker[] {
  let c = compiled.get(cfg);
  if (!c) {
    c = (cfg.title_markers ?? []).map((m) => ({ kind: m.kind, re: new RegExp(m.re, "g"), tag: m.tag, suffixes: m.suffixes ?? [] }));
    compiled.set(cfg, c);
  }
  return c;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 捕獲した数（算用数字・漢数字）を $1 に入れる */
function fill(template: string, cap: string | undefined): string {
  if (!template.includes("$1")) return template;
  const n = cap === undefined ? null : parseKanjiNumber(cap);
  return template.replace(/\$1/g, n === null ? String(cap) : String(n));
}

/** 文字列の期・部の表記 */
export function markersOf(text: string, cfg: ExtractConfig): Markers {
  const t = text.normalize("NFKC").toLowerCase();
  const out: Markers = { season: new Map(), part: new Set() };
  for (const m of compile(cfg)) {
    m.re.lastIndex = 0;
    for (const x of t.matchAll(m.re)) {
      const tag = fill(m.tag, x[1]);
      if (m.kind === "part") out.part.add(tag);
      else out.season.set(tag, [...new Set([...(out.season.get(tag) ?? []), ...m.suffixes.map((s) => fill(s, x[1]))])]);
    }
  }
  return out;
}

/** 作品名（原題・英題など全部）の期・部の表記 */
export function workMarkers(titles: string[], cfg: ExtractConfig): Markers {
  const out: Markers = { season: new Map(), part: new Set() };
  for (const t of titles) {
    const m = markersOf(t, cfg);
    for (const [k, v] of m.season) out.season.set(k, v);
    for (const p of m.part) out.part.add(p);
  }
  return out;
}

/**
 * タイトルの期の表記と作品が食い違うか。食い違えば理由を返す。
 *   - タイトルが2期以降（s2・final・after など）: 作品名にその期の表記が無ければ食い違い
 *   - タイトルが1期（s1）: 作品名に2期以降の表記があれば食い違い（期の表記が無い作品は1期とみなす）
 */
export function seasonConflict(title: Markers, work: Markers): string | null {
  for (const tag of title.season.keys()) {
    if (tag === "s1") {
      const later = [...work.season.keys()].filter((k) => k !== "s1");
      if (later.length) return `タイトルは1期、作品は「${later.join(",")}」`;
    } else if (!work.season.has(tag)) {
      return `タイトルの期「${tag}」が作品に無い`;
    }
  }
  return null;
}

/** 照合キーの末尾（「season2」「thefinalseason」「afterstory」）が、どの期のタグにあたるか */
export function suffixTag(rest: string, cfg: ExtractConfig): string | null {
  for (const m of cfg.title_markers ?? []) {
    if (m.kind !== "season") continue;
    for (const s of m.suffixes ?? []) {
      const re = new RegExp(`^${s.split("$1").map(escapeRe).join("([0-9]+)")}$`);
      const x = rest.match(re);
      if (x) return fill(m.tag, x[1]);
    }
  }
  return null;
}

/** 照合キーの末尾に付けて作品名を作り直す候補（タイトルの2期以降の表記から） */
export function seasonSuffixes(title: Markers): string[] {
  return [...title.season.entries()].filter(([k]) => k !== "s1").flatMap(([, v]) => v);
}
