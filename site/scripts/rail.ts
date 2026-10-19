// 棚（.rail）の矢印。押すと、同じ section の中の見えている棚を1画面ぶん送る。端まで来たら矢印を押せなくする。
// 矢印が無くても棚はスクロールで動く（矢印はマウスの端末だけに出す）

const reduce = matchMedia("(prefers-reduced-motion: reduce)");

function visibleRail(scope: Element): HTMLElement | null {
  return [...scope.querySelectorAll<HTMLElement>(".rail")].find((r) => r.offsetParent !== null) ?? null;
}

function sync(scope: Element) {
  const rail = visibleRail(scope);
  for (const b of scope.querySelectorAll<HTMLButtonElement>("[data-rail-dir]")) {
    if (!rail) {
      b.disabled = true;
      continue;
    }
    const max = rail.scrollWidth - rail.clientWidth - 2;
    b.disabled = b.dataset.railDir === "-1" ? rail.scrollLeft <= 2 : rail.scrollLeft >= max;
  }
}

for (const btns of document.querySelectorAll<HTMLElement>(".rail-btns")) {
  const scope = btns.closest("section") ?? document.body;
  btns.addEventListener("click", (ev) => {
    const b = (ev.target as HTMLElement).closest<HTMLButtonElement>("[data-rail-dir]");
    const rail = visibleRail(scope);
    if (!b || !rail) return;
    rail.scrollBy({ left: Number(b.dataset.railDir) * rail.clientWidth * 0.9, behavior: reduce.matches ? "auto" : "smooth" });
  });
  for (const rail of scope.querySelectorAll<HTMLElement>(".rail")) rail.addEventListener("scroll", () => sync(scope), { passive: true });
  // ランキングの期間を切り替えたあと（見える棚が変わる）
  scope.addEventListener("click", () => requestAnimationFrame(() => sync(scope)));
  addEventListener("resize", () => sync(scope), { passive: true });
  sync(scope);
}
