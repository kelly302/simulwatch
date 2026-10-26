// ランキング（トップの順位表とランキングのページで共通。2026-10-21）。縦の順位表で、順位は行の左に大きく
import { cfg, ranking, streamerById, viewsUpdated, workById } from "./data.ts";
import { dictFor, encodeRow } from "./encode.ts";
import { cardHtml } from "./views.ts";
import { formatDate } from "../../src/shared/site.ts";

/** ランキングのページに載せる枠数（config/site.yaml の top.ranking_page） */
export const RANKING_PAGE = cfg.top.ranking_page;

/** 期間ごとの枠（limit 位まで）。最初に出す期間は7日、7日に枠が無いときだけ30日、それも無ければ全期間（2026-10-20 ユーザー決定） */
export function rankingPeriods(limit: number) {
  const periods = cfg.top.ranking_periods.map((days) => {
    const evs = ranking(days, limit);
    return { days, label: days ? `${days}日` : "全期間", evs, dict: dictFor(evs, streamerById, workById) };
  });
  return { periods, first: Math.max(0, periods.findIndex((p) => p.evs.length > 0)) };
}
export type RankingPeriod = ReturnType<typeof rankingPeriods>["periods"][number];

/** 期間の説明（「この30日に配信された公開枠を、再生数の多い順に。再生数は 10/19 時点。」） */
export function rankingNote(days: number): string {
  const at = viewsUpdated ? formatDate(viewsUpdated).slice(5) : "";
  return `${days ? `この${days}日に配信された` : "これまでに配信された"}公開枠を、再生数の多い順に。${at ? `再生数は ${at} 時点。` : ""}`;
}

/** 順位表の行（どの幅でも1列で、上から順に。列をまたがせない。2026-10-21 ユーザーの指摘） */
export function rankRowsHtml(p: RankingPeriod, count: number, lazy: (j: number) => boolean): string {
  return p.evs.slice(0, count).map((e, j) => `<li><span class="rn">${j + 1}<span class="sr">位</span></span>${cardHtml(encodeRow(e), p.dict, { lazy: lazy(j) })}</li>`).join("");
}
