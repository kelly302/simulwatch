// トップの「同時視聴した枠」の絞り込みの条件と、条件の軸のボタン（2026-10-20。ユーザーが選んだ「軸のボタン」）。
// ビルド（最初の HTML）とブラウザ（site/scripts/top.ts）が同じ関数で作る。DOM に依存しない（文字列を返す）
import { AFFILIATION_LABEL, BRANCH_LABEL } from "../../src/shared/types.ts";
import type { Affiliation, Branch } from "../../src/shared/types.ts";
import { SEASON_LABEL } from "../../src/shared/site.ts";
import type { Season } from "../../src/shared/site.ts";
import { esc } from "./views.ts";

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
  mem: "all" | "ex" | "only";
}

export const EMPTY = (): Filters => ({ date: "", branch: [], kind: [], movie: "all", country: "all", year: "", season: "", mem: "all" });

export type Axis = "date" | "aff" | "kind" | "movie" | "country" | "year" | "mem";
export const AXES: Axis[] = ["date", "aff", "kind", "movie", "country", "year", "mem"];
export const AXIS_LABEL: Record<Axis, string> = {
  date: "配信日", aff: "所属", kind: "作品の種類", movie: "映画かどうか", country: "制作国", year: "作品の放送年", mem: "メン限",
};
const KIND_LABEL: Record<string, string> = { anime: "アニメ", tokusatsu: "特撮", live_action: "実写" };

/** その軸を指定なしに戻す */
export function resetAxis(f: Filters, axis: Axis): void {
  if (axis === "date") f.date = "";
  else if (axis === "aff") f.branch = [];
  else if (axis === "kind") f.kind = [];
  else if (axis === "movie") f.movie = "all";
  else if (axis === "country") f.country = "all";
  else if (axis === "year") { f.year = ""; f.season = ""; }
  else f.mem = "all";
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
    case "mem": return f.mem === "ex" ? "メン限を除く" : f.mem === "only" ? "メン限だけ" : "";
  }
}

/** 指定している軸の数 */
export const activeAxes = (f: Filters, agAll: (ag: string) => string[]) => AXES.filter((a) => axisValue(f, a, agAll)).length;

/** 条件の軸のボタン。指定している軸は黒く塗って値を出す。押すとその軸だけのシートを開く */
export function axisButtonsHtml(f: Filters, agAll: (ag: string) => string[]): string {
  return AXES.map((a) => {
    const v = axisValue(f, a, agAll);
    return v
      ? `<button type="button" class="fchip axis on" data-axis="${a}" aria-haspopup="dialog" aria-label="${esc(AXIS_LABEL[a])}：${esc(v)}（条件を変える）">${esc(v)}</button>`
      : `<button type="button" class="fchip axis" data-axis="${a}" aria-haspopup="dialog">${esc(AXIS_LABEL[a])}</button>`;
  }).join("");
}
