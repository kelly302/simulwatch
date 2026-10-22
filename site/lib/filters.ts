// トップの「すべての同時視聴」の絞り込みの条件と、条件の軸のボタン（2026-10-20。ユーザーが選んだ「軸のボタン」）。
// 軸のボタンを押すと、その軸の選択肢が条件の段のすぐ下に開く。メン限は「メン限を除く」のチェック1つで、押すとすぐ切り替わる
// ビルド（最初の HTML）とブラウザ（site/scripts/top.ts）が同じ関数で作る。DOM に依存しない（文字列を返す）
import { AFFILIATION_LABEL, BRANCH_LABEL } from "../../src/shared/types.ts";
import type { Affiliation, Branch } from "../../src/shared/types.ts";
import { SEASON_LABEL } from "../../src/shared/site.ts";
import type { Season } from "../../src/shared/site.ts";
import { CHECK_ICON, esc } from "./views.ts";
import type { TopDict, TopRow } from "./encode.ts";

export interface Filters {
  /** 配信日。"30d"（30日以内）・"1y"（1年以内）・"2025"（その年に配信）。空は指定なし */
  date: string;
  /** 所属の区分（"nijisanji:en" など） */
  branch: string[];
  kind: string[];
  movie: "all" | "movie" | "other";
  country: "all" | "jp" | "foreign";
  /** 作品の放送年・放送期 */
  year: string;
  season: Season | "";
  /** メン限を除く（2026-10-20 ユーザー決定。「メン限だけ」はなくした） */
  mem: "all" | "ex";
}

/** 所属の欄に並べる事務所（この順） */
export const FILTER_AFFS: Affiliation[] = ["nijisanji", "hololive", "vspo"];

/** 所属のチェックを全部外したときの印（どの枠にも当たらない。branch が空だと条件なしになるため） */
export const AFF_NONE = "none";

export const EMPTY = (): Filters => ({ date: "", branch: [], kind: [], movie: "all", country: "all", year: "", season: "", mem: "all" });

/** 押すと選択肢が開く軸（メン限はチェック1つなので含めない） */
export type Axis = "date" | "aff" | "kind" | "movie" | "country" | "year";
export const AXES: Axis[] = ["date", "aff", "kind", "movie", "country", "year"];
/** 軸の正式な名前（開いた欄の見出し・読み上げ） */
export const AXIS_LABEL: Record<Axis, string> = {
  date: "配信日", aff: "所属", kind: "作品の種類", movie: "映画かどうか", country: "制作国", year: "作品の放送年",
};
/** 条件のボタンに書く短い名前（スマホの幅で2段に収めるため。2026-10-20） */
export const AXIS_SHORT: Record<Axis, string> = {
  date: "配信日", aff: "所属", kind: "種類", movie: "映画", country: "制作国", year: "放送年",
};
const KIND_LABEL: Record<string, string> = { anime: "アニメ", tokusatsu: "特撮", live_action: "実写" };

/** その軸を指定なしに戻す */
export function resetAxis(f: Filters, axis: Axis): void {
  if (axis === "date") f.date = "";
  else if (axis === "aff") f.branch = [];
  else if (axis === "kind") f.kind = [];
  else if (axis === "movie") f.movie = "all";
  else if (axis === "country") f.country = "all";
  else { f.year = ""; f.season = ""; }
}

/**
 * 軸の今の値の表記（指定なしなら空）。agAll は所属ごとの区分の全部（「にじさんじ」全部か「にじさんじ EN・KR」かを決める）
 */
export function axisValue(f: Filters, axis: Axis, agAll: (ag: string) => string[]): string {
  switch (axis) {
    case "date": return f.date === "30d" ? "30日以内に配信" : f.date === "1y" ? "1年以内に配信" : f.date ? `${f.date}年に配信` : "";
    case "aff": {
      if (f.branch.length === 1 && f.branch[0] === AFF_NONE) return "所属のチェックなし";
      if (!f.branch.length) return "";
      // 既定は全部にチェックなので、外したほうが少ない事務所で書けるとき（同じ数なら短いとき）は「○○を除く」
      const all = FILTER_AFFS.flatMap((ag) => agAll(ag));
      const excluded = all.filter((v) => !f.branch.includes(v));
      const shown = affNames(f.branch, agAll);
      if (!excluded.length) return joinNames(shown);
      const exNames = affNames(excluded, agAll);
      const ex = joinNames(exNames);
      const exText = `${ex}${/[A-Za-z]$/.test(ex) ? " " : ""}を除く`;
      const shownText = joinNames(shown);
      return exNames.length < shown.length || (exNames.length === shown.length && exText.length < shownText.length) ? exText : shownText;
    }
    case "kind": return f.kind.map((k) => KIND_LABEL[k] ?? k).join("・");
    case "movie": return f.movie === "movie" ? "映画" : f.movie === "other" ? "映画以外" : "";
    case "country": return f.country === "jp" ? "日本の作品" : f.country === "foreign" ? "海外の作品" : "";
    case "year": return f.year ? `${f.year}年${f.season ? SEASON_LABEL[f.season] : ""}の作品` : "";
  }
}

/** 日本時間の年（配信日の「年ごと」） */
const jstYear = (t: number) => new Date((t + 9 * 3600) * 1000).getUTCFullYear();

/**
 * 「すべての同時視聴」の絞り込みの判定（ブラウザの site/scripts/top.ts が使う。テストは test/site.test.ts）。
 * nowSec は配信日の「30日以内」「1年以内」の起点（ビルドの時刻。ランキングの期間と同じ）
 */
export function matchesTop(r: TopRow, f: Filters, d: TopDict, nowSec: number): boolean {
  if (f.date === "30d" && r[1] < nowSec - 30 * 86_400) return false;
  if (f.date === "1y" && r[1] < nowSec - 365 * 86_400) return false;
  if (f.date && f.date !== "30d" && f.date !== "1y" && jstYear(r[1]) !== Number(f.date)) return false;
  const st = d.s[r[4]];
  if (f.branch.length && !(st && f.branch.includes(`${st[2]}:${st[3]}`))) return false;
  if (f.mem === "ex" && r[3]) return false;
  if (!f.kind.length && f.movie === "all" && f.country === "all" && !f.year) return true;
  // 作品の属性。付いた作品（辞書）と、作品を付けない枠の作品名（種類・映画かどうかだけ分かる）
  const ws = r[5].map((x) => d.w[Array.isArray(x) ? x[0] : x]).filter((w) => !!w).map((w) => ({
    kind: w[2], movie: w[3] ? w[3] === "movie" : null, countries: w[6] === "?" ? null : w[6].split(",").filter(Boolean), year: w[4], season: w[5],
  }));
  const fr = r[6];
  if (fr && fr[1]) ws.push({ kind: fr[2], movie: fr[3] === -1 ? null : fr[3] === 1, countries: null, year: 0, season: "" });
  if (f.kind.length && !ws.some((w) => w.kind && f.kind.includes(w.kind))) return false;
  if (f.movie !== "all" && !ws.some((w) => w.movie != null && w.movie === (f.movie === "movie"))) return false;
  if (f.country === "jp" && !ws.some((w) => w.countries?.includes("JP"))) return false;
  if (f.country === "foreign" && !ws.some((w) => w.countries?.some((c) => c !== "JP"))) return false;
  if (f.year && !ws.some((w) => String(w.year) === f.year && (!f.season || w.season === f.season))) return false;
  return true;
}

/** 所属の区分の並びを、事務所ごとの名前に（事務所の区分が全部なら事務所の名前だけ） */
function affNames(list: string[], agAll: (ag: string) => string[]): string[] {
  const byAg = new Map<string, string[]>();
  for (const v of list) {
    const ag = v.split(":")[0]!;
    byAg.set(ag, [...(byAg.get(ag) ?? []), v]);
  }
  return [...byAg].map(([ag, sel]) => {
    const name = AFFILIATION_LABEL[ag as Affiliation] ?? ag;
    return sel.length === agAll(ag).length ? name : `${name} ${sel.map((v) => BRANCH_LABEL[v.split(":")[1] as Branch]).join("・")}`;
  });
}
/** 3つ以上は「ほか」 */
const joinNames = (names: string[]) => (names.length > 2 ? `${names[0]} ほか${names.length - 1}` : names.join("・"));

/** 指定している条件の数（軸とメン限） */
export const activeAxes = (f: Filters, agAll: (ag: string) => string[]) => AXES.filter((a) => axisValue(f, a, agAll)).length + (f.mem === "ex" ? 1 : 0);


/**
 * 条件のボタン。軸は押すと選択肢が下に開く（open はいま開いている軸）。指定している軸は塗って値を出す。
 * 最後はメン限のチェック（押すとすぐ切り替わる）
 */
export function axisButtonsHtml(f: Filters, agAll: (ag: string) => string[], open: Axis | null = null): string {
  const axes = AXES.map((a) => {
    const v = axisValue(f, a, agAll);
    const attrs = `data-axis="${a}" aria-expanded="${a === open}" aria-controls="fpanel"`;
    return v
      ? `<button type="button" class="fchip axis on" ${attrs} aria-label="${esc(AXIS_LABEL[a])}：${esc(v)}">${esc(v)}</button>`
      : `<button type="button" class="fchip axis" ${attrs}${AXIS_SHORT[a] !== AXIS_LABEL[a] ? ` aria-label="${esc(AXIS_LABEL[a])}"` : ""}>${esc(AXIS_SHORT[a])}</button>`;
  }).join("");
  const ex = f.mem === "ex";
  return `${axes}<button type="button" class="fchip check${ex ? " on" : ""}" data-toggle="mem" aria-pressed="${ex}">${CHECK_ICON}メン限を除く</button>`;
}
