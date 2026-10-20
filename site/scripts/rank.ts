// ランキングの期間の切り替え（トップとランキングのページ。3期間とも HTML に入っている）。
// トップの「30位まで見る」は、選んでいた期間をランキングのページに引き継ぐ（URL には出さない。読めなければ既定の期間のまま）

const KEY = "rank-period";
const group = document.getElementById("rank-period");

function show(days: string) {
  if (!group) return;
  const b = group.querySelector<HTMLButtonElement>(`button[data-period="${days}"]`);
  if (!b) return;
  for (const x of group.querySelectorAll("button")) x.setAttribute("aria-pressed", String(x === b));
  for (const p of document.querySelectorAll<HTMLElement>(".rank-pane")) p.hidden = p.dataset.period !== days;
}

group?.addEventListener("click", (ev) => {
  const b = (ev.target as HTMLElement).closest<HTMLButtonElement>("button[data-period]");
  if (b) show(b.dataset.period!);
});

document.addEventListener("click", (ev) => {
  const a = (ev.target as HTMLElement).closest<HTMLAnchorElement>("a.rank-link");
  if (!a) return;
  try { sessionStorage.setItem(KEY, a.dataset.period ?? ""); } catch { /* 保存できなくても移る */ }
});

if (document.querySelector("[data-rank-page]")) {
  try {
    const days = sessionStorage.getItem(KEY);
    if (days) { show(days); sessionStorage.removeItem(KEY); }
  } catch { /* 読めなければ既定の期間 */ }
}
