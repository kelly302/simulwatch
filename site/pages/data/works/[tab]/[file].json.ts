// 作品一覧の並び順ごとのページ（300件ずつ）。種類のタブ × 並び順 × 向き × ページ
import { cfg, pageCount, sortWorks, worksOfTab } from "../../../../lib/data.ts";
import { WORK_SORTS, WORK_TABS, encodeWorkRow } from "../../../../lib/encode.ts";
import type { WorkListPage, WorkSort, WorkTab } from "../../../../lib/encode.ts";

export function getStaticPaths() {
  const paths: { params: { tab: string; file: string }; props: { tab: WorkTab; sort: WorkSort; reverse: boolean; page: number } }[] = [];
  for (const tab of WORK_TABS) {
    const n = pageCount(worksOfTab(tab).length);
    for (const sort of WORK_SORTS) for (const reverse of [false, true]) for (let page = 1; page <= n; page++) {
      paths.push({ params: { tab, file: `${sort}-${reverse ? "asc" : "desc"}-${page}` }, props: { tab, sort, reverse, page } });
    }
  }
  return paths;
}

export function GET({ props }: { props: { tab: WorkTab; sort: WorkSort; reverse: boolean; page: number } }) {
  const all = sortWorks(worksOfTab(props.tab), props.sort, props.reverse);
  const size = cfg.works_page_size;
  const body: WorkListPage = {
    total: all.length,
    pages: pageCount(all.length),
    page: props.page,
    rows: all.slice((props.page - 1) * size, props.page * size).map(encodeWorkRow),
  };
  return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
}
