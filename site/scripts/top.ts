// トップのブラウザ側の動き。条件の軸のボタンを押すと、その軸の選択肢が条件の段のすぐ下に開く（2026-10-20）。
//   （ランキングの期間の切り替えは site/scripts/rank.ts）
//   「すべての同時視聴」: さらに表示（新しい順300枠の JSON）→ 絞り込み・並べ替え・300枠より先（全件の索引と辞書）
// 件数は索引を読んだあとに出す。読み込みに失敗しても今の表示は消さない

import type { TopDict, TopRecent, TopRow } from "../lib/encode.ts";
import { cardHtml, esc } from "../lib/views.ts";
import { AFF_NONE, AXIS_LABEL, EMPTY, activeAxes, axisButtonsHtml, matchesTop, resetAxis } from "../lib/filters.ts";
import type { Axis, Filters } from "../lib/filters.ts";
import { formatDate, sortByViews } from "../../src/shared/site.ts";
import type { Season } from "../../src/shared/site.ts";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const cfg = JSON.parse($("top-config").textContent ?? "{}") as { generatedAt: string; recentHtml: number; recentJson: number; total: number };
/** 配信日の「この30日」「この1年」の起点（ビルドの時刻。ランキングの期間と同じ） */
const nowSec = Math.floor(Date.parse(cfg.generatedAt) / 1000);

const S = {
  sort: "date" as "date" | "views",
  rev: false,
  shown: cfg.recentHtml,
  filters: EMPTY(),
  recent: null as TopRecent | null,
  recentPromise: null as Promise<void> | null,
  index: null as TopRow[] | null,
  dict: null as TopDict | null,
  indexPromise: null as Promise<void> | null,
};

// ---------------------------------------------------------------- 読み込み

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

function ensureRecent(): Promise<void> {
  if (S.recent) return Promise.resolve();
  S.recentPromise ??= getJson<TopRecent>("/data/top/recent.json").then((r) => { S.recent = r; }).catch((e) => {
    S.recentPromise = null;
    throw e;
  });
  return S.recentPromise;
}

function ensureIndex(): Promise<void> {
  if (S.index) return Promise.resolve();
  S.indexPromise ??= Promise.all([getJson<{ e: TopRow[] }>("/data/top/index.json"), getJson<TopDict>("/data/top/dict.json")]).then(([idx, dict]) => {
    S.index = idx.e;
    S.dict = dict;
  }).catch((e) => {
    S.indexPromise = null;
    throw e;
  });
  return S.indexPromise;
}

// ---------------------------------------------------------------- 絞り込みと並べ替え

function sortRows(rows: TopRow[]): TopRow[] {
  if (S.sort === "date") return [...rows].sort((a, b) => (S.rev ? a[1] - b[1] : b[1] - a[1]));
  // 再生数: 値のある枠を多い順（逆順で少ない順）。メン限で再生数の無い枠は、逆順でも末尾で新しい順
  return sortByViews(rows, (r) => r[2], (r) => r[1], S.rev);
}

/** その事務所の区分（「nijisanji:en」の形）。所属の欄の区分のチェックから */
function agBranches(ag: string): string[] {
  return [...document.querySelectorAll<HTMLInputElement>(`#fpanel input[name="branch"][value^="${ag}:"]`)].map((i) => i.value);
}

const activeCount = (f: Filters) => activeAxes(f, agBranches);
const needsIndex = () => S.sort !== "date" || S.rev || activeCount(S.filters) > 0 || S.shown > cfg.recentJson;

// ---------------------------------------------------------------- 描画

const grid = $("done-grid");
const more = $("more");
const status = $("status");
const empty = $("done-empty");
/** 最初の HTML（新しい順の枠と「さらに表示」）。読み込みに失敗したらここに戻す（骨組みのまま残さない） */
const initialGrid = grid.innerHTML;
const initialMore = more.innerHTML;

const skeleton = (n: number) => Array.from({ length: n }, () =>
  '<div class="card skel" aria-hidden="true"><div class="thumb"></div><div class="bar" style="width:90%"></div><div class="bar" style="width:60%"></div><div class="bar" style="width:70%;margin-top:14px"></div></div>').join("");

function renderSortControls() {
  for (const b of document.querySelectorAll<HTMLButtonElement>("[data-sort]")) {
    b.setAttribute("aria-pressed", String(b.dataset.sort === S.sort));
  }
  const lbl = S.sort === "date" ? (S.rev ? "古い順" : "新しい順") : (S.rev ? "少ない順" : "多い順");
  $("rev-label").textContent = lbl;
  const rev = $("rev");
  rev.setAttribute("aria-pressed", String(S.rev));
  rev.setAttribute("aria-label", `逆順にする（今は${lbl}）`);
  const note = $("sort-note");
  note.hidden = S.sort !== "views";
  note.textContent = "メン限の枠は再生数を取得できないため、再生数で並べたときは末尾に新しい順で並べています。";
}

function renderChips() {
  $("chips").innerHTML = axisButtonsHtml(S.filters, agBranches, openAxis);
  $("clear-all").hidden = activeCount(S.filters) === 0;
}

// 件数の行は、件数か「条件をすべて外す」を出すときだけ見せる（何も出さないのに空白を取らない）
function render() {
  draw();
  $("fstatus").hidden = !(status.textContent ?? "").trim() && $("clear-all").hidden;
}

function draw() {
  renderSortControls();
  renderChips();
  empty.innerHTML = "";
  if (needsIndex() && !S.index) {
    grid.innerHTML = skeleton(6);
    grid.setAttribute("aria-busy", "true");
    status.textContent = "読み込み中…";
    more.innerHTML = "";
    ensureIndex().then(render, () => {
      toast("読み込みに失敗しました。時間をおいてもう一度お試しください。");
      S.sort = "date"; S.rev = false; S.filters = EMPTY(); S.shown = Math.min(S.shown, cfg.recentJson);
      render();
    });
    return;
  }
  grid.removeAttribute("aria-busy");
  if (!S.index) {
    // 索引を読む前: 新しい順の300枠（読んでいなければ HTML の24枠のまま）
    if (!S.recent) {
      grid.innerHTML = initialGrid;
      more.innerHTML = initialMore;
      status.textContent = "";
      return;
    }
    const rows = S.recent.e.slice(0, S.shown);
    grid.innerHTML = rows.map((r) => cardHtml(r, S.recent!.d)).join("");
    status.textContent = "";
    const last = rows.at(-1);
    // 11: 「さらに表示」は、まだ出していない枠があるときだけ（新しい順の JSON の残りか、その先の索引）
    const hasMore = rows.length < S.recent.e.length || S.recent.e.length < cfg.total;
    more.innerHTML = hasMore
      ? `<button type="button" class="btn" id="more-btn">さらに表示</button>${last ? `<p>${esc(formatDate(new Date(last[1] * 1000).toISOString()))} までの枠を表示しています</p>` : ""}`
      : `<p>すべて表示しました（${rows.length.toLocaleString()}枠）</p>`;
    return;
  }
  const rows = sortRows(S.index.filter((r) => matchesTop(r, S.filters, S.dict!, nowSec)));
  const total = rows.length;
  status.innerHTML = activeCount(S.filters) > 0 ? `条件に当たる <strong>${total.toLocaleString()}</strong>枠` : `全 <strong>${total.toLocaleString()}</strong>枠`;
  if (total === 0) {
    grid.innerHTML = "";
    empty.innerHTML = `<div class="empty"><p><strong>条件に当たる枠がありません</strong></p><p class="note">上の桃色の条件のボタンを押すと、その条件を変えられます。</p><button type="button" class="btn" data-remove="all">条件をすべて外す</button></div>`;
    more.innerHTML = "";
    return;
  }
  const shown = Math.min(S.shown, total);
  grid.innerHTML = rows.slice(0, shown).map((r) => cardHtml(r, S.dict!)).join("");
  more.innerHTML = shown < total
    ? `<button type="button" class="btn" id="more-btn">さらに表示</button><p>${total.toLocaleString()}枠中 ${shown.toLocaleString()}枠を表示しています</p>`
    : `<p>すべて表示しました（${total.toLocaleString()}枠）</p>`;
}

// ---------------------------------------------------------------- 操作

function showMore(btn: HTMLButtonElement) {
  S.shown += cfg.recentHtml;
  if (needsIndex()) return render();
  if (S.recent) return render();
  btn.disabled = true;
  btn.textContent = "読み込み中…";
  ensureRecent().then(render, () => {
    S.shown -= cfg.recentHtml;
    btn.disabled = false;
    btn.textContent = "さらに表示";
    toast("読み込みに失敗しました。時間をおいてもう一度お試しください。");
  });
}

function removeAll() {
  S.filters = EMPTY();
  applyNow();
}

document.getElementById("done")?.addEventListener("click", (ev) => {
  const t = ev.target as HTMLElement;
  const sortBtn = t.closest<HTMLButtonElement>("[data-sort]");
  if (sortBtn && !sortBtn.disabled) {
    if (S.sort !== sortBtn.dataset.sort) {
      S.sort = sortBtn.dataset.sort as "date" | "views";
      S.rev = false;
      S.shown = cfg.recentHtml;
      render();
    }
    return;
  }
  if (t.closest("#rev")) {
    S.rev = !S.rev;
    S.shown = cfg.recentHtml;
    return render();
  }
  const axisBtn = t.closest<HTMLElement>("#chips [data-axis]");
  if (axisBtn) {
    const ax = axisBtn.dataset.axis as Axis;
    return openAxis === ax ? closePanel(true) : openPanel(ax);
  }
  if (t.closest('#chips [data-toggle="mem"]')) return toggleMem();
  if (t.closest("[data-remove]")) return removeAll();
  const moreBtn = t.closest<HTMLButtonElement>("#more-btn");
  if (moreBtn) return showMore(moreBtn);
});

// メン限を除く（チェック1つ。押すとすぐ切り替わる）
function toggleMem() {
  S.filters.mem = S.filters.mem === "ex" ? "all" : "ex";
  S.shown = cfg.recentHtml;
  render();
  document.querySelector<HTMLElement>('#chips [data-toggle="mem"]')?.focus();
}

// ---------------------------------------------------------------- 軸の選択肢（条件のボタンのすぐ下に開く。選んだらすぐ絞り込む。2026-10-21）

const panel = $("fpanel");
let openAxis: Axis | null = null;

function syncPanel() {
  const f = S.filters;
  // 所属: 条件が無ければ全部にチェック。事務所の札は、区分が1つでも入っていればチェック。一部だけなら札に区分を書く
  for (const i of panel.querySelectorAll<HTMLInputElement>('input[name="branch"]')) i.checked = !f.branch.length || f.branch.includes(i.value);
  for (const sp of panel.querySelectorAll<HTMLElement>(".agsplit")) {
    const ag = sp.dataset.aff!;
    const nm = sp.querySelector<HTMLElement>(".nm")!;
    const subs = [...panel.querySelectorAll<HTMLInputElement>(`input[name="branch"][value^="${ag}:"]`)];
    const on = subs.filter((x) => x.checked);
    const names = on.map((x) => x.parentElement!.lastChild!.textContent).join("・");
    const part = on.length > 0 && on.length < subs.length;
    nm.textContent = part ? `${nm.dataset.label} ${names}` : nm.dataset.label!;
    sp.classList.toggle("on", on.length > 0);
    // 事務所のチェック: 区分が全部なら入り、一部なら「一部」（読み上げ用）、無ければ外れる
    const t = sp.querySelector<HTMLInputElement>("input[data-agtoggle]")!;
    t.checked = on.length > 0;
    t.indeterminate = part;
    sp.querySelector(".agmenu")!.setAttribute("aria-label", `${nm.dataset.label}の区分を選ぶ（${names || "チェックなし"}）`);
  }
  for (const i of panel.querySelectorAll<HTMLInputElement>('input[name="kind"]')) i.checked = f.kind.includes(i.value);
  for (const i of panel.querySelectorAll<HTMLInputElement>('input[name="date"]')) i.checked = f.date === i.value;
  // 配信した年の選択（30日以内・1年以内のときは「年を選ぶ」に戻す）
  const dateYear = $<HTMLSelectElement>("opt-date-year");
  dateYear.value = f.date && f.date !== "30d" && f.date !== "1y" ? f.date : "";
  dateYear.classList.toggle("on", !!dateYear.value);
  for (const name of ["movie", "country"] as const) {
    for (const i of panel.querySelectorAll<HTMLInputElement>(`input[name="${name}"]`)) i.checked = f[name] === i.value;
  }
  const year = $<HTMLSelectElement>("opt-year");
  year.value = f.year;
  year.classList.toggle("on", !!f.year);
  for (const b of panel.querySelectorAll<HTMLButtonElement>("[data-season]")) {
    b.disabled = !f.year;
    b.setAttribute("aria-pressed", String(f.season === b.dataset.season));
  }
}

/** 条件を変えたら、すぐ一覧・件数・軸のボタンを描き直す */
function applyNow() {
  S.shown = cfg.recentHtml;
  render();
  syncPanel();
}

function openPanel(a: Axis) {
  openAxis = a;
  setAffPop(null);
  for (const fs of panel.querySelectorAll<HTMLElement>("fieldset[data-axis]")) fs.hidden = fs.dataset.axis !== a;
  $("fpanel-h").textContent = AXIS_LABEL[a];
  panel.hidden = false;
  renderChips();
  syncPanel();
  document.querySelector<HTMLElement>(`#chips [data-axis="${a}"]`)?.focus();
  panel.scrollIntoView({ block: "nearest" });
  // 件数を早く出せるように、索引を先に読んでおく
  ensureIndex().catch(() => {});
}

/** 所属の事務所の札の下に開くチェックの一覧（開くのは1つずつ） */
function setAffPop(aff: string | null) {
  for (const b of panel.querySelectorAll<HTMLButtonElement>("button.agmenu")) {
    const open = b.dataset.aff === aff;
    b.setAttribute("aria-expanded", String(open));
    $(`aff-pop-${b.dataset.aff}`).hidden = !open;
  }
}
const affPopOpen = () => !!panel.querySelector('button.agmenu[aria-expanded="true"]');

function closePanel(focusAxis: boolean) {
  const a = openAxis;
  setAffPop(null);
  panel.hidden = true;
  openAxis = null;
  renderChips();
  if (focusAxis && a) document.querySelector<HTMLElement>(`#chips [data-axis="${a}"]`)?.focus();
}

panel.addEventListener("change", (ev) => {
  const t = ev.target as HTMLInputElement | HTMLSelectElement;
  const f = S.filters;
  if (t instanceof HTMLInputElement && (t.name === "branch" || t.dataset.agtoggle)) {
    // 事務所の札のチェック: 入っていた（一部でも）なら区分を全部外し、外れていたなら全部入れる
    if (t.dataset.agtoggle) for (const i of panel.querySelectorAll<HTMLInputElement>(`input[name="branch"][value^="${t.dataset.agtoggle}:"]`)) i.checked = t.checked;
    // チェックの入った区分を事務所の順に。全部なら条件なし、1つも無ければ何も当たらない印
    const all = [...panel.querySelectorAll<HTMLInputElement>('input[name="branch"]')];
    const on = all.filter((i) => i.checked).map((i) => i.value);
    f.branch = on.length === all.length ? [] : on.length ? on : [AFF_NONE];
  } else if (t instanceof HTMLInputElement && t.name === "kind") {
    f.kind = t.checked ? [...f.kind, t.value] : f.kind.filter((k) => k !== t.value);
  } else if (t instanceof HTMLInputElement && (t.name === "date" || t.name === "movie" || t.name === "country")) {
    (f as unknown as Record<string, string>)[t.name] = t.value;
  } else if (t.id === "opt-date-year") {
    f.date = t.value;
  } else if (t.id === "opt-year") {
    f.year = t.value;
    if (!f.year) f.season = "";
  }
  applyNow();
});

panel.addEventListener("click", (ev) => {
  const t = ev.target as HTMLElement;
  const season = t.closest<HTMLButtonElement>("[data-season]");
  if (season && !season.disabled) {
    S.filters.season = S.filters.season === season.dataset.season ? "" : (season.dataset.season as Season);
    return applyNow();
  }
  const affBtn = t.closest<HTMLButtonElement>("button.agmenu");
  if (affBtn) return setAffPop(affBtn.getAttribute("aria-expanded") === "true" ? null : affBtn.dataset.aff!);
  // チェックの一覧の外を押したら閉じる
  if (affPopOpen() && !t.closest(".affpop")) setAffPop(null);
  if (t.closest("#fpanel-close")) return closePanel(true);
  if (t.closest("#fpanel-clear")) {
    // この軸だけを指定なしに戻す
    resetAxis(S.filters, openAxis!);
    return applyNow();
  }
});

panel.addEventListener("keydown", (ev) => {
  if (ev.key !== "Escape") return;
  // 所属のチェックの一覧が開いていれば、先にそれだけを閉じて札に戻る
  const open = panel.querySelector<HTMLButtonElement>('button.agmenu[aria-expanded="true"]');
  if (open) { setAffPop(null); open.focus(); return; }
  closePanel(true);
});
// 欄の外を押したら、所属のチェックの一覧を閉じる
document.addEventListener("click", (ev) => {
  if (affPopOpen() && !panel.contains(ev.target as Node)) setAffPop(null);
});
