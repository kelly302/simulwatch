// トップのブラウザ側の動き。
//   ランキングの期間の切り替え（3期間とも HTML に入っている）
//   「同時視聴した枠」: さらに表示（新しい順300枠の JSON）→ 絞り込み・並べ替え・300枠より先（全件の索引と辞書）
// 件数は索引を読んだあとに出す。読み込みに失敗しても今の表示は消さない

import type { TopDict, TopRecent, TopRow } from "../lib/encode.ts";
import { cardHtml, esc } from "../lib/views.ts";
import { SEASON_LABEL, formatDate, sortByViews } from "../../src/shared/site.ts";
import type { Season } from "../../src/shared/site.ts";
import { AFFILIATION_LABEL, BRANCH_LABEL } from "../../src/shared/types.ts";
import type { Affiliation, Branch } from "../../src/shared/types.ts";

interface Filters {
  branch: string[];
  kind: string[];
  movie: "all" | "movie" | "other";
  country: "all" | "jp" | "foreign";
  year: string;
  season: Season | "";
  mem: "all" | "ex" | "only";
}

const EMPTY = (): Filters => ({ branch: [], kind: [], movie: "all", country: "all", year: "", season: "", mem: "all" });
const KIND_LABEL: Record<string, string> = { anime: "アニメ", tokusatsu: "特撮", live_action: "実写" };

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const cfg = JSON.parse($("top-config").textContent ?? "{}") as { recentHtml: number; recentJson: number; total: number };

const S = {
  sort: "date" as "date" | "views",
  rev: false,
  shown: cfg.recentHtml,
  filters: EMPTY(),
  draft: null as Filters | null,
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
  const st = d.s[r[4]];
  if (f.branch.length && !(st && f.branch.includes(`${st[2]}:${st[3]}`))) return false;
  if (f.mem === "ex" && r[3]) return false;
  if (f.mem === "only" && !r[3]) return false;
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

interface Chip { key: string; label: string }

function agBranches(ag: string): string[] {
  return [...document.querySelectorAll<HTMLInputElement>(`#sheet input[name="branch"][value^="${ag}:"]`)].map((i) => i.value);
}

function chipList(f: Filters): Chip[] {
  const chips: Chip[] = [];
  const byAg = new Map<string, string[]>();
  for (const v of f.branch) {
    const [ag] = v.split(":");
    byAg.set(ag!, [...(byAg.get(ag!) ?? []), v]);
  }
  for (const [ag, sel] of byAg) {
    const all = agBranches(ag);
    const name = AFFILIATION_LABEL[ag as Affiliation] ?? ag;
    chips.push({
      key: `ag:${ag}`,
      label: sel.length === all.length ? name : `${name} ${sel.map((v) => BRANCH_LABEL[v.split(":")[1] as Branch]).join("・")}`,
    });
  }
  for (const k of f.kind) chips.push({ key: `kind:${k}`, label: KIND_LABEL[k] ?? k });
  if (f.movie !== "all") chips.push({ key: "movie", label: f.movie === "movie" ? "映画" : "映画以外" });
  if (f.country !== "all") chips.push({ key: "country", label: f.country === "jp" ? "日本の作品" : "海外の作品" });
  if (f.year) chips.push({ key: "year", label: f.season ? `${f.year}年${SEASON_LABEL[f.season]}` : `${f.year}年` });
  if (f.mem !== "all") chips.push({ key: "mem", label: f.mem === "ex" ? "メン限を除く" : "メン限だけ" });
  return chips;
}

const activeCount = (f: Filters) => chipList(f).length;
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
    if (b.dataset.sort === "views") b.disabled = S.filters.mem === "only";
  }
  const lbl = S.sort === "date" ? (S.rev ? "古い順" : "新しい順") : (S.rev ? "少ない順" : "多い順");
  $("rev-label").textContent = lbl;
  const rev = $("rev");
  rev.setAttribute("aria-pressed", String(S.rev));
  rev.setAttribute("aria-label", `逆順にする（今は${lbl}）`);
  const note = $("sort-note");
  const memOnly = S.filters.mem === "only";
  note.hidden = !memOnly && S.sort !== "views";
  note.textContent = memOnly
    ? "メン限の枠は再生数を取得できないため、メン限だけのときは再生数では並べられません。"
    : "メン限の枠は再生数を取得できないため、再生数で並べたときは末尾に新しい順で並べています。";
}

function renderChips() {
  const chips = chipList(S.filters);
  const n = chips.length;
  $("chips").innerHTML = `<button type="button" class="btn-filter" id="open-filter" aria-haspopup="dialog">
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 6h16M7 12h10M10 18h4"></path></svg>絞り込み${n ? `（${n}）` : ""}</button>`
    + chips.map((c) => `<button type="button" class="chip" data-remove="${esc(c.key)}" aria-label="${esc(c.label)} の条件を外す">${esc(c.label)}<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"></path></svg></button>`).join("")
    + (n >= 2 ? '<button type="button" class="linkish" data-remove="all">すべて外す</button>' : "");
}

function render() {
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
    empty.innerHTML = `<div class="empty"><p><strong>条件に当たる枠がありません</strong></p><p class="note">上の条件のボタンを押すと、その条件を外せます。</p><button type="button" class="btn" data-remove="all">条件をすべて外す</button></div>`;
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

function removeFilter(key: string) {
  const f = S.filters;
  if (key === "all") S.filters = EMPTY();
  else if (key.startsWith("ag:")) f.branch = f.branch.filter((v) => !v.startsWith(`${key.slice(3)}:`));
  else if (key.startsWith("kind:")) f.kind = f.kind.filter((k) => k !== key.slice(5));
  else if (key === "movie") f.movie = "all";
  else if (key === "country") f.country = "all";
  else if (key === "year") { f.year = ""; f.season = ""; }
  else if (key === "mem") f.mem = "all";
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
  if (t.closest("#open-filter")) return openSheet();
  const rm = t.closest<HTMLElement>("[data-remove]");
  if (rm) return removeFilter(rm.dataset.remove!);
  const moreBtn = t.closest<HTMLButtonElement>("#more-btn");
  if (moreBtn) return showMore(moreBtn);
});

// ---------------------------------------------------------------- 絞り込みのシート

const sheet = $("sheet");
const scrim = $("scrim");

function syncSheet() {
  const d = S.draft!;
  for (const i of sheet.querySelectorAll<HTMLInputElement>('input[name="branch"]')) i.checked = d.branch.includes(i.value);
  for (const i of sheet.querySelectorAll<HTMLInputElement>("input[data-ag]")) {
    const keys = agBranches(i.dataset.ag!);
    const n = keys.filter((k) => d.branch.includes(k)).length;
    i.checked = n === keys.length;
    i.indeterminate = n > 0 && n < keys.length;
  }
  for (const i of sheet.querySelectorAll<HTMLInputElement>('input[name="kind"]')) i.checked = d.kind.includes(i.value);
  for (const name of ["movie", "country", "mem"] as const) {
    for (const i of sheet.querySelectorAll<HTMLInputElement>(`input[name="${name}"]`)) i.checked = d[name] === i.value;
  }
  ($("opt-year") as HTMLSelectElement).value = d.year;
  for (const b of sheet.querySelectorAll<HTMLButtonElement>("[data-season]")) {
    b.disabled = !d.year;
    b.setAttribute("aria-pressed", String(d.season === b.dataset.season));
  }
  const apply = $("sheet-apply");
  apply.textContent = S.index ? `${S.index.filter((r) => matches(r, d, S.dict!)).length.toLocaleString()}枠を表示` : "この条件で表示";
}

function openSheet() {
  S.draft = structuredClone(S.filters);
  scrim.hidden = false;
  sheet.hidden = false;
  syncSheet();
  ensureIndex().then(() => { if (!sheet.hidden) syncSheet(); }, () => {});
  $("sheet-close").focus();
}

function closeSheet() {
  sheet.hidden = true;
  scrim.hidden = true;
  S.draft = null;
  document.getElementById("open-filter")?.focus();
}

sheet.addEventListener("change", (ev) => {
  const t = ev.target as HTMLInputElement | HTMLSelectElement;
  const d = S.draft!;
  if (t instanceof HTMLInputElement && t.dataset.ag) {
    const keys = agBranches(t.dataset.ag);
    d.branch = d.branch.filter((k) => !keys.includes(k));
    if (t.checked) d.branch.push(...keys);
  } else if (t instanceof HTMLInputElement && t.name === "branch") {
    d.branch = t.checked ? [...d.branch, t.value] : d.branch.filter((k) => k !== t.value);
  } else if (t instanceof HTMLInputElement && t.name === "kind") {
    d.kind = t.checked ? [...d.kind, t.value] : d.kind.filter((k) => k !== t.value);
  } else if (t instanceof HTMLInputElement && (t.name === "movie" || t.name === "country" || t.name === "mem")) {
    (d as unknown as Record<string, string>)[t.name] = t.value;
  } else if (t.id === "opt-year") {
    d.year = t.value;
    if (!d.year) d.season = "";
  }
  syncSheet();
});

sheet.addEventListener("click", (ev) => {
  const t = ev.target as HTMLElement;
  const season = t.closest<HTMLButtonElement>("[data-season]");
  if (season && !season.disabled) {
    S.draft!.season = S.draft!.season === season.dataset.season ? "" : (season.dataset.season as Season);
    return syncSheet();
  }
  if (t.closest("#sheet-close")) return closeSheet();
  if (t.closest("#sheet-clear")) {
    S.draft = EMPTY();
    return syncSheet();
  }
  if (t.closest("#sheet-apply")) {
    S.filters = S.draft!;
    if (S.filters.mem === "only" && S.sort === "views") S.sort = "date";
    S.shown = cfg.recentHtml;
    closeSheet();
    render();
  }
});

sheet.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape") closeSheet();
});
scrim.addEventListener("click", closeSheet);
