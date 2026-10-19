// 配信者一覧のブラウザ側の動き（行はすべて HTML にある）。名前の検索・区分のチェック・並べ替え（最終視聴日・枠数・作品数と逆順）
import { norm } from "../lib/text.ts";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const list = $("streamer-rows");
const items = [...list.querySelectorAll<HTMLLIElement>(":scope > li")];
const q = $<HTMLInputElement>("q");
const S = { sort: "latest" as "latest" | "events" | "works", rev: false };

const revLabel = () => (S.sort === "latest" ? (S.rev ? "古い順" : "新しい順") : (S.rev ? "少ない順" : "多い順"));
const num = (li: HTMLElement, k: string) => Number(li.dataset[k] ?? 0);

function render() {
  for (const b of document.querySelectorAll<HTMLButtonElement>("#sortbar [data-sort]")) b.setAttribute("aria-pressed", String(b.dataset.sort === S.sort));
  $("rev-label").textContent = revLabel();
  $("rev").setAttribute("aria-pressed", String(S.rev));
  $("rev").setAttribute("aria-label", `逆順にする（今は${revLabel()}）`);

  const sign = S.rev ? -1 : 1;
  const byLatest = (a: HTMLElement, b: HTMLElement) => (b.dataset.latest ?? "").localeCompare(a.dataset.latest ?? "");
  const sorted = [...items].sort((a, b) => {
    if (S.sort === "latest") return sign * byLatest(a, b) || num(a, "i") - num(b, "i");
    return sign * (num(b, S.sort) - num(a, S.sort)) || byLatest(a, b) || num(a, "i") - num(b, "i");
  });
  const word = norm(q.value.trim());
  const checked = new Set([...document.querySelectorAll<HTMLInputElement>("#branches input:checked")].map((i) => i.value));
  const hasBranches = !!document.getElementById("branches");
  let shown = 0;
  for (const li of sorted) {
    const ok = (!word || (li.dataset.q ?? "").includes(word)) && (!hasBranches || checked.has(li.dataset.branch ?? ""));
    li.hidden = !ok;
    if (ok) shown++;
    list.append(li);
  }
  const filtered = !!word || (hasBranches && checked.size < document.querySelectorAll("#branches input").length);
  $("status").textContent = filtered ? `条件に当たる配信者 ${shown}人` : "";
  $("streamer-empty").hidden = shown > 0;
}

$("sortbar").addEventListener("click", (ev) => {
  const t = ev.target as HTMLElement;
  const b = t.closest<HTMLButtonElement>("[data-sort]");
  if (b && b.dataset.sort !== S.sort) {
    S.sort = b.dataset.sort as typeof S.sort;
    S.rev = false;
    render();
  } else if (t.closest("#rev")) {
    S.rev = !S.rev;
    render();
  }
});
q.addEventListener("input", render);
document.getElementById("branches")?.addEventListener("change", render);
