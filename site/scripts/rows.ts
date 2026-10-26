// 作品ページ・配信者ページの行（すべて HTML にある）。行の展開（枠の一覧）と並べ替えと「メン限を除く」。
//   並び: name（HTML の並び＝名前順）・views（再生数。無い行は逆順に関係なく末尾で最終視聴日の新しい順）・latest（最終視聴日）
//   メン限を除く（2026-10-20）: メン限の枠（data-mem）と、公開の枠が無い行（data-pub="0"）を隠し、
//   数と日付（data-all / data-pub）を公開の枠だけの値に替える。最終視聴日の並びも公開の枠で決める
import { sortByViews } from "../../src/shared/site.ts";

const list = document.querySelector<HTMLElement>("[data-xrows]");
const bar = document.querySelector<HTMLElement>("[data-sortbar]");
const memBtn = document.querySelector<HTMLButtonElement>("[data-mem-toggle]");
const items = list ? [...list.querySelectorAll<HTMLLIElement>(":scope > li")] : [];

const S = { sort: bar?.querySelector<HTMLButtonElement>("[data-sort]")?.dataset.sort ?? "views", rev: false, memEx: false };
const LABEL: Record<string, [string, string]> = { name: ["五十音順", "逆順"], views: ["多い順", "少ない順"], latest: ["新しい順", "古い順"] };
const idx = (li: HTMLElement) => Number(li.dataset.i ?? 0);
const latest = (li: HTMLElement) => (S.memEx ? li.dataset.latestPub : li.dataset.latest) ?? "";
const views = (li: HTMLElement) => (li.dataset.views ? Number(li.dataset.views) : null);

list?.addEventListener("click", (ev) => {
  const btn = (ev.target as HTMLElement).closest<HTMLButtonElement>(".xbtn");
  if (!btn) return;
  const open = btn.getAttribute("aria-expanded") !== "true";
  btn.setAttribute("aria-expanded", String(open));
  btn.setAttribute("aria-label", (btn.getAttribute("aria-label") ?? "").replace(/を(開く|閉じる)$/, open ? "を閉じる" : "を開く"));
  const frames = document.getElementById(btn.getAttribute("aria-controls") ?? "");
  if (frames) frames.hidden = !open;
  btn.closest("li")?.classList.toggle("open", open);
});

function sortRows() {
  if (!list || !bar) return;
  for (const b of bar.querySelectorAll<HTMLButtonElement>("[data-sort]")) b.setAttribute("aria-pressed", String(b.dataset.sort === S.sort));
  const label = LABEL[S.sort]?.[S.rev ? 1 : 0] ?? "";
  const rev = bar.querySelector<HTMLButtonElement>("[data-rev]")!;
  rev.setAttribute("aria-pressed", String(S.rev));
  rev.setAttribute("aria-label", `逆順にする（今は${label}）`);
  bar.querySelector("[data-rev-label]")!.textContent = label;
  let sorted: HTMLLIElement[];
  if (S.sort === "views") sorted = sortByViews(items, views, latest, S.rev);
  else if (S.sort === "latest") sorted = [...items].sort((a, b) => (S.rev ? -1 : 1) * (latest(b).localeCompare(latest(a)) || idx(a) - idx(b)));
  else sorted = [...items].sort((a, b) => (S.rev ? -1 : 1) * (idx(a) - idx(b)));
  list.append(...sorted);
}

function applyMem() {
  memBtn?.setAttribute("aria-pressed", String(S.memEx));
  memBtn?.classList.toggle("on", S.memEx);
  for (const li of items) li.hidden = S.memEx && li.dataset.pub === "0";
  for (const f of document.querySelectorAll<HTMLElement>("[data-mem]")) f.hidden = S.memEx;
  for (const el of document.querySelectorAll<HTMLElement>("[data-all]")) el.textContent = (S.memEx ? el.dataset.pub : el.dataset.all) ?? "";
  for (const el of document.querySelectorAll<HTMLElement>("[data-memonly]")) el.hidden = S.memEx;
  for (const el of document.querySelectorAll<HTMLElement>("[data-pub-empty]")) el.hidden = !S.memEx;
  sortRows();
}

bar?.addEventListener("click", (ev) => {
  const t = ev.target as HTMLElement;
  const b = t.closest<HTMLButtonElement>("[data-sort]");
  if (b && b.dataset.sort !== S.sort) {
    S.sort = b.dataset.sort!;
    S.rev = false;
    sortRows();
  } else if (t.closest("[data-rev]")) {
    S.rev = !S.rev;
    sortRows();
  }
});

memBtn?.addEventListener("click", () => {
  S.memEx = !S.memEx;
  applyMem();
});
