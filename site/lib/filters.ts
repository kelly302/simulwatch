// トップの「同時視聴した枠」の絞り込みの条件と、条件の軸のボタン（2026-10-20。ユーザーが選んだ「軸のボタン」）。
// 軸のボタンを押すと、その軸の選択肢が条件の段のすぐ下に開く。メン限は「メン限を除く」のチェック1つで、押すとすぐ切り替わる
// ビルド（最初の HTML）とブラウザ（site/scripts/top.ts）が同じ関数で作る。DOM に依存しない（文字列を返す）
import { AFFILIATION_LABEL, BRANCH_LABEL } from "../../src/shared/types.ts";
import type { Affiliation, Branch } from "../../src/shared/types.ts";
import { SEASON_LABEL } from "../../src/shared/site.ts";
import type { Season } from "../../src/shared/site.ts";
import { CHECK_ICON, esc } from "./views.ts";

export interface Filters {
  /** 配信日。"30d"（この30日）・"1y"（この1年）・"2025"（その年に配信）。空は指定なし */
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

export const EMPTY = (): Filters => ({ date: "", branch: [], kind: [], movie: "all", country: "all", year: "", season: "", mem: "all" });

/** 押すと選択肢が開く軸（メン限はチェック1つなので含めない） */
export type Axis = "date" | "aff" | "kind" | "movie" | "country" | "year";
export const AXES: Axis[] = ["date", "aff", "kind", "movie", "country", "year"];
export const AXIS_LABEL: Record<Axis, string> = {
  date: "配信日", aff: "所属", kind: "作品の種類", movie: "映画かどうか", country: "制作国", year: "作品の放送年",
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
    case "date": return f.date === "30d" ? "この30日" : f.date === "1y" ? "この1年" : f.date ? `${f.date}年に配信` : "";
    case "aff": {
      const byAg = new Map<string, string[]>();
      for (const v of f.branch) {
        const ag = v.split(":")[0]!;
        byAg.set(ag, [...(byAg.get(ag) ?? []), v]);
      }
      const names = [...byAg].map(([ag, sel]) => {
        const name = AFFILIATION_LABEL[ag as Affiliation] ?? ag;
        return sel.length === agAll(ag).length ? name : `${name} ${sel.map((v) => BRANCH_LABEL[v.split(":")[1] as Branch]).join("・")}`;
      });
      return names.length > 2 ? `${names[0]} ほか${names.length - 1}` : names.join("・");
    }
    case "kind": return f.kind.map((k) => KIND_LABEL[k] ?? k).join("・");
    case "movie": return f.movie === "movie" ? "映画" : f.movie === "other" ? "映画以外" : "";
    case "country": return f.country === "jp" ? "日本の作品" : f.country === "foreign" ? "海外の作品" : "";
    case "year": return f.year ? `${f.year}年${f.season ? SEASON_LABEL[f.season] : ""}の作品` : "";
  }
}

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
      : `<button type="button" class="fchip axis" ${attrs}>${esc(AXIS_LABEL[a])}</button>`;
  }).join("");
  const ex = f.mem === "ex";
  return `${axes}<span class="fdiv" aria-hidden="true"></span><button type="button" class="fchip check${ex ? " on" : ""}" data-toggle="mem" aria-pressed="${ex}">${CHECK_ICON}メン限を除く</button>`;
}
