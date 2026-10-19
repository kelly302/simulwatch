// 作品一覧のブラウザ側の動き。
//   並べ替え: 並び順ごとの JSON（300件ずつ）を読んで行を入れ替える。ページ送りもその JSON で行う
//   検索: 検索欄を触ったときに作品名の索引を読み、作品名・読みがなで絞る（配信者数の多い順）
// 読み込みに失敗しても今の表示は消さない

import type { WorkListPage, WorkSearchRow, WorkSort, WorkTab } from "../lib/encode.ts";
import { workListJsonPath } from "../lib/encode.ts";
import { esc, workRowHtml } from "../lib/views.ts";
import { norm } from "../lib/text.ts";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const cfg = JSON.parse($("works-config").textContent ?? "{}") as { tab: WorkTab; page: number; pages: number; total: number; size: number };

const rowsEl = $("work-rows");
const pager = $("pager");
const status = $("status");
const q = $<HTMLInputElement>("q");
const qClear = $("q-clear");
const initialRows = rowsEl.innerHTML;
const initialPager = pager.innerHTML;

const S = { sort: "streamers" as WorkSort, rev: false, page: cfg.page, search: null as WorkSearchRow[] | null, searchPromise: null as Promise<void> | null };

function toast(msg: string) {
  const t = $("toast");
  t.textContent = msg;
  t.hidden = false;
  setTimeout(() => { t.hidden = true; }, 4000);
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return (await res.json()) as T;
}

// ---------------------------------------------------------------- 並べ替え

const revLabel = () => (S.sort === "latest" ? (S.rev ? "古い順" : "新しい順") : (S.rev ? "少ない順" : "多い順"));

function renderSortControls() {
  for (const b of document.querySelectorAll<HTMLButtonElement>("#sortbar [data-sort]")) b.setAttribute("aria-pressed", String(b.dataset.sort === S.sort));
  $("rev-label").textContent = revLabel();
  const rev = $("rev");
  rev.setAttribute("aria-pressed", String(S.rev));
  rev.setAttribute("aria-label", `逆順にする（今は${revLabel()}）`);
}

function pagerHtml(p: WorkListPage): string {
  const from = (p.page - 1) * cfg.size + 1;
  const to = from + p.rows.length - 1;
  const btn = (n: number, label = String(n), rel = "") =>
    n === p.page && !rel ? `<button type="button" aria-current="page" disabled>${n}</button>` : `<button type="button" data-page="${n}"${rel ? ` aria-label="${rel}"` : ""}>${label}</button>`;
  const nums = p.pages > 1
    ? `<div class="nums">${p.page > 1 ? btn(p.page - 1, "前へ", "前のページ") : ""}${Array.from({ length: p.pages }, (_, i) => btn(i + 1)).join("")}${p.page < p.pages ? btn(p.page + 1, "次へ", "次のページ") : ""}</div>`
    : "";
  return `<p>${from.toLocaleString()}〜${to.toLocaleString()}件目 / ${p.total.toLocaleString()}作品</p>${nums}`;
}

async function loadPage(page: number, scroll: boolean) {
  const isDefault = S.sort === "streamers" && !S.rev && page === cfg.page;
  renderSortControls();
  if (isDefault) {
    rowsEl.innerHTML = initialRows;
    pager.innerHTML = initialPager;
    S.page = page;
    return;
  }
  rowsEl.setAttribute("aria-busy", "true");
  try {
    const p = await getJson<WorkListPage>(workListJsonPath(cfg.tab, S.sort, S.rev, page));
    S.page = page;
    rowsEl.innerHTML = p.rows.map((r) => workRowHtml(r, S.sort)).join("");
    pager.innerHTML = pagerHtml(p);
    if (scroll) rowsEl.scrollIntoView({ block: "start" });
  } catch {
    toast("読み込みに失敗しました。時間をおいてもう一度お試しください。");
  } finally {
    rowsEl.removeAttribute("aria-busy");
  }
}

$("sortbar").addEventListener("click", (ev) => {
  const t = ev.target as HTMLElement;
  const b = t.closest<HTMLButtonElement>("[data-sort]");
  if (b && b.dataset.sort !== S.sort) {
    S.sort = b.dataset.sort as WorkSort;
    S.rev = false;
    // 既定の並びに戻すときは、このページの HTML の並びに戻す。ほかの並びは1ページ目から
    void loadPage(S.sort === "streamers" ? cfg.page : 1, false);
    return;
  }
  if (t.closest("#rev")) {
    S.rev = !S.rev;
    void loadPage(!S.rev && S.sort === "streamers" ? cfg.page : 1, false);
  }
});

pager.addEventListener("click", (ev) => {
  const b = (ev.target as HTMLElement).closest<HTMLButtonElement>("button[data-page]");
  if (b) void loadPage(Number(b.dataset.page), true);
});

// ---------------------------------------------------------------- 検索

function ensureSearch(): Promise<void> {
  if (S.search) return Promise.resolve();
  S.searchPromise ??= getJson<WorkSearchRow[]>("/data/works/search.json").then((r) => { S.search = r; }).catch((e) => {
    S.searchPromise = null;
    throw e;
  });
  return S.searchPromise;
}

const searchKeys = new Map<WorkSearchRow, string[]>();
const keysOf = (r: WorkSearchRow) => {
  let k = searchKeys.get(r);
  if (!k) searchKeys.set(r, (k = [norm(r[1]), norm(r[10])]));
  return k;
};

/** 作品名の中の検索語に印を付ける（作品名にそのまま含まれるときだけ） */
function highlight(title: string, query: string): string {
  const i = title.toLowerCase().indexOf(query.toLowerCase());
  if (!query || i < 0) return esc(title);
  return `${esc(title.slice(0, i))}<mark>${esc(title.slice(i, i + query.length))}</mark>${esc(title.slice(i + query.length))}`;
}

function setSearching(on: boolean) {
  $("tabs").hidden = on;
  $("sortbar").hidden = on;
  pager.hidden = on;
  $("search-note").hidden = !on;
  qClear.hidden = !q.value;
}

let lastQuery = "";
function runSearch() {
  const raw = q.value.trim();
  if (raw === lastQuery) return;
  lastQuery = raw;
  if (!raw) {
    setSearching(false);
    status.textContent = "";
    void loadPage(S.page, false);
    return;
  }
  setSearching(true);
  if (!S.search) {
    status.textContent = "読み込み中…";
    ensureSearch().then(() => { lastQuery = ""; runSearch(); }, () => toast("読み込みに失敗しました。時間をおいてもう一度お試しください。"));
    return;
  }
  const n = norm(raw);
  const hits = S.search.filter((r) => keysOf(r).some((k) => k.includes(n)));
  status.innerHTML = `「${esc(raw)}」を含む作品 <strong>${hits.length.toLocaleString()}件</strong>（配信者数の多い順）`;
  rowsEl.innerHTML = hits.map((r) => workRowHtml(r.slice(0, 10) as unknown as Parameters<typeof workRowHtml>[0], "streamers", highlight(r[1], raw))).join("");
}

q.addEventListener("focus", () => { ensureSearch().catch(() => {}); }, { once: true });
q.addEventListener("input", runSearch);
q.addEventListener("search", runSearch);
qClear.addEventListener("click", () => {
  q.value = "";
  runSearch();
  q.focus();
});
