// トップのブラウザ側の動き。条件の軸のボタンを押すと、その軸の選択肢が条件の段のすぐ下に開く（2026-10-20）。
//   ランキングの期間の切り替え（3期間とも HTML に入っている）
//   「同時視聴した枠」: さらに表示（新しい順300枠の JSON）→ 絞り込み・並べ替え・300枠より先（全件の索引と辞書）
// 件数は索引を読んだあとに出す。読み込みに失敗しても今の表示は消さない

import type { TopDict, TopRecent, TopRow } from "../lib/encode.ts";
import { cardHtml, esc } from "../lib/views.ts";
import { AXIS_LABEL, EMPTY, activeAxes, axisButtonsHtml, resetAxis } from "../lib/filters.ts";
import type { Axis, Filters } from "../lib/filters.ts";
import { formatDate, sortByViews } from "../../src/shared/site.ts";
import type { Season } from "../../src/shared/site.ts";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const cfg = JSON.parse($("top-config").textContent ?? "{}") as { generatedAt: string; recentHtml: number; recentJson: number; total: number };
/** 配信日の「この30日」「この1年」の起点（ビルドの時刻。ランキングの期間と同じ） */
const nowSec = Math.floor(Date.parse(cfg.generatedAt) / 1000);
const jstYear = (t: number) => new Date((t + 9 * 3600) * 1000).getUTCFullYear();

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

// ---------------------------------------------------------------- ランキングの期間

const periodGroup = $("rank-period");
periodGroup?.addEventListener("click", (ev) => {
  const b = (ev.target as HTMLElement).closest<HTMLButtonElement>("button[data-period]");
  if (!b) return;
  for (const x of periodGroup.querySelectorAll("button")) x.setAttribute("aria-pressed", String(x === b));
  for (const p of document.querySelectorAll<HTMLElement>(".rank-pane")) p.hidden = p.dataset.period !== b.dataset.period;
});

// ランキングの続き（9位から。HTML に入っている行を開く・閉じる）
document.querySelector('[aria-labelledby="h-rank"]')?.addEventListener("click", (ev) => {
  const b = (ev.target as HTMLElement).closest<HTMLButtonElement>(".rank-more");
  if (!b) return;
  const open = b.getAttribute("aria-expanded") !== "true";
  b.setAttribute("aria-expanded", String(open));
  const list = document.getElementById(b.getAttribute("aria-controls") ?? "");
  if (list) list.hidden = !open;
  b.textContent = open ? "閉じる" : (b.dataset.label ?? "続きを見る");
  if (!open) b.scrollIntoView({ block: "nearest" });
});

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

function matches(r: TopRow, f: Filters, d: TopDict): boolean {
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

function sortRows(rows: TopRow[]): TopRow[] {
  if (S.sort === "date") return [...rows].sort((a, b) => (S.rev ? a[1] - b[1] : b[1] - a[1]));
  // 再生数: 値のある枠を多い順（逆順で少ない順）。メン限で再生数の無い枠は、逆順でも末尾で新しい順
  return sortByViews(rows, (r) => r[2], (r) => r[1], S.rev);
}

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
      status.textContent = "";
      return;
    }
    const rows = S.recent.e.slice(0, S.shown);
    grid.innerHTML = rows.map((r) => cardHtml(r, S.recent!.d)).join("");
    status.textContent = "";
    const last = rows.at(-1);
    more.innerHTML = `<button type="button" class="btn" id="more-btn">さらに表示</button>${last ? `<p>${esc(formatDate(new Date(last[1] * 1000).toISOString()))} までの枠を表示しています</p>` : ""}`;
    return;
  }
  const rows = sortRows(S.index.filter((r) => matches(r, S.filters, S.dict!)));
  const total = rows.length;
  status.innerHTML = activeCount(S.filters) > 0 ? `条件に当たる <strong>${total.toLocaleString()}</strong>枠` : `全 <strong>${total.toLocaleString()}</strong>枠`;
  if (total === 0) {
    grid.innerHTML = "";
    empty.innerHTML = `<div class="empty"><p><strong>条件に当たる枠がありません</strong></p><p class="note">上の黒い条件のボタンを押すと、その条件を変えられます。</p><button type="button" class="btn" data-remove="all">条件をすべて外す</button></div>`;
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
  S.shown = cfg.recentHtml;
  render();
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
  for (const i of panel.querySelectorAll<HTMLInputElement>('input[name="branch"]')) i.checked = f.branch.includes(i.value);
  for (const i of panel.querySelectorAll<HTMLInputElement>("input[data-ag]")) {
    const keys = agBranches(i.dataset.ag!);
    const n = keys.filter((k) => f.branch.includes(k)).length;
    i.checked = n === keys.length;
    i.indeterminate = n > 0 && n < keys.length;
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

function closePanel(focusAxis: boolean) {
  const a = openAxis;
  panel.hidden = true;
  openAxis = null;
  renderChips();
  if (focusAxis && a) document.querySelector<HTMLElement>(`#chips [data-axis="${a}"]`)?.focus();
}

panel.addEventListener("change", (ev) => {
  const t = ev.target as HTMLInputElement | HTMLSelectElement;
  const f = S.filters;
  if (t instanceof HTMLInputElement && t.dataset.ag) {
    const keys = agBranches(t.dataset.ag);
    f.branch = f.branch.filter((k) => !keys.includes(k));
    if (t.checked) f.branch.push(...keys);
  } else if (t instanceof HTMLInputElement && t.name === "branch") {
    f.branch = t.checked ? [...f.branch, t.value] : f.branch.filter((k) => k !== t.value);
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
  if (t.closest("#fpanel-close")) return closePanel(true);
  if (t.closest("#fpanel-clear")) {
    // この軸だけを指定なしに戻す
    resetAxis(S.filters, openAxis!);
    return applyNow();
  }
});

panel.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape") closePanel(true);
});
