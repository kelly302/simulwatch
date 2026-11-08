// 続きの回の候補の判定役の試し（D2）の答えと正解の突き合わせ。node scripts/cand-trial/compare.mjs <batch>
// 正解は data/ai/<batch>/sealed/key.json（基準は sealed/criteria.md）。compare.md（数）と report.html（ユーザーが採点する表）を書く
import fs from "node:fs";
import { join } from "node:path";

const batch = process.argv[2];
if (!batch) throw new Error("使い方: compare.mjs <batch>");
const dir = join(process.cwd(), "data", "ai", batch);
const key = JSON.parse(fs.readFileSync(join(dir, "sealed", "key.json"), "utf8")).labels;
const queue = new Map(JSON.parse(fs.readFileSync(join(dir, "queue.json"), "utf8")).items.map((x) => [x.video_id, x]));
const ans = new Map();
const files = [];
for (const f of fs.readdirSync(join(dir, "answers")).filter((f) => f.endsWith(".json")).sort()) {
  const j = JSON.parse(fs.readFileSync(join(dir, "answers", f), "utf8"));
  files.push({ file: f, model: j.model, started_at: j.started_at, finished_at: j.finished_at, n: j.answers?.length ?? 0 });
  for (const a of j.answers ?? []) ans.set(a.video_id, { ...a, file: f });
}

const SHOWN = ["identified", "not_in_db", "unidentifiable"]; // サイトに出る status
const isWork = (l) => l === "W-same" || l === "W-other";
const isW = (l) => l.startsWith("W");
const rows = key.map((k) => ({ k, a: ans.get(k.video_id) ?? null }));
const cnt = (xs, f) => xs.filter(f).length;
const yes = (r) => r.a?.watchalong === "yes";
const shown = (r) => yes(r) && SHOWN.includes(r.a?.status);

// 片側95%上限（二項分布の正確な上限。k 件 / n 件）
function upper(k, n) {
  if (n === 0) return null;
  if (k >= n) return 1;
  const cdf = (p) => { let s = 0, t = Math.pow(1 - p, n); for (let i = 0; i <= k; i++) { s += t; t = t * (n - i) / (i + 1) * p / (1 - p); } return s; };
  let lo = k / n, hi = 1;
  for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (cdf(m) > 0.05) lo = m; else hi = m; }
  return hi;
}
const pct = (x) => (x === null ? "-" : `${(x * 100).toFixed(1)}%`);

function block(name, xs) {
  const N = xs.filter((r) => r.k.label === "N");
  const notWork = xs.filter((r) => !isWork(r.k.label));
  const W = xs.filter((r) => isW(r.k.label));
  const work = xs.filter((r) => isWork(r.k.label));
  const nYes = cnt(N, yes), nShown = cnt(notWork, shown);
  const agree = cnt(xs, (r) => r.a && r.a.watchalong === r.k.watchalong);
  return {
    name, n: xs.length, N: N.length, W: W.length, work: work.length, nonwork: cnt(xs, (r) => r.k.label === "W-nonwork"), U: cnt(xs, (r) => r.k.label === "U"),
    nYes, nYesUp: upper(nYes, N.length), notWork: notWork.length, nShown, nShownUp: upper(nShown, notWork.length),
    wYes: cnt(W, yes), wNo: cnt(W, (r) => r.a?.watchalong === "no"), wUnsure: cnt(W, (r) => r.a?.watchalong === "unsure"),
    workShown: cnt(work, shown), agree, missing: cnt(xs, (r) => !r.a),
  };
}
const strata = [...new Set(key.map((k) => k.stratum))];
const blocks = [block("全体", rows), ...strata.map((s) => block(s, rows.filter((r) => r.k.stratum === s)))];

const out = [`# ${batch} の突き合わせ`, ""];
out.push(`答え ${ans.size} 件・正解 ${key.length} 件・答えの無い動画 ${cnt(rows, (r) => !r.a)}`, "");
out.push("答えのファイル: " + files.map((f) => `${f.file}（${f.n}件・${f.model}・${f.started_at}〜${f.finished_at}）`).join("、"), "");
out.push("| 層 | 本数 | 正解 W（作品／作品ではない） | 正解 N | 正解 U | **N に yes**（95%上限） | 作品でない動画をサイトに出る status で答えた（95%上限） | W に yes / unsure / no | 作品の W をサイトに出る status で答えた | watchalong の一致 |");
out.push("|---|---|---|---|---|---|---|---|---|---|");
for (const b of blocks) {
  out.push(`| ${b.name} | ${b.n} | ${b.W}（${b.work}／${b.nonwork}） | ${b.N} | ${b.U} | **${b.nYes}/${b.N}**（${pct(b.nYesUp)}） | ${b.nShown}/${b.notWork}（${pct(b.nShownUp)}） | ${b.wYes} / ${b.wUnsure} / ${b.wNo} | ${b.workShown}/${b.work} | ${b.agree}/${b.n} |`);
}
out.push("");
const all = blocks[0];
out.push(`- 参考（cont-trial-1021 の基準。合否は決めない）: 基準1（正解 N に yes が0件）${all.nYes === 0 ? "満たす" : "満たさない"}・基準2（正解 W のうち yes が半分以上）${all.wYes * 2 >= all.W ? "満たす" : "満たさない"}`, "");

const esc = (s) => String(s ?? "").replace(/\|/g, "｜").replace(/\n/g, " ");
const works = (a) => (a?.works ?? []).map((w) => w.key + (w.episodes?.length ? `(${w.episodes.join(",")})` : "")).join(" ") || a?.title || "";
const flag = (r) => (r.k.label === "N" && yes(r) ? "⚠N→yes" : !isWork(r.k.label) && shown(r) ? "⚠出る" : isW(r.k.label) && r.a?.watchalong === "no" ? "取りこぼし" : r.a && r.a.watchalong !== r.k.watchalong ? "不一致" : "");
const order = (r) => (flag(r).startsWith("⚠") ? 0 : flag(r) ? 1 : 2);
const sorted = [...rows].sort((x, y) => order(x) - order(y) || x.k.n - y.k.n);
out.push("| 印 | 番号 | 動画 | 層 | 配信者 | 題名 | 正解 | 正解の理由 | 判定役 | status | 作品 | 確度 | 判定役の理由 |", "|---|---|---|---|---|---|---|---|---|---|---|---|---|");
for (const r of sorted) {
  out.push(`| ${flag(r)} | ${queue.get(r.k.video_id)?.no ?? ""} | ${r.k.video_id} | ${esc(r.k.stratum)} | ${esc(r.k.streamer)} | ${esc(r.k.title).slice(0, 60)} | ${r.k.label} | ${esc(r.k.why).slice(0, 80)} | ${r.a?.watchalong ?? "（無し）"} | ${r.a?.status ?? ""} | ${esc(works(r.a))} | ${r.a?.confidence ?? ""} | ${esc(r.a?.rationale).slice(0, 140)} |`);
}
fs.writeFileSync(join(dir, "compare.md"), out.join("\n"), "utf8");

// report.html: ユーザーが採点する表（1件ごとに正解と判定役の答え。採点は scores.md に「video_id: ○／×・メモ」で書く）
const h = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const tr = sorted.map((r) => {
  const q = queue.get(r.k.video_id) ?? {};
  return `<tr class="${flag(r) ? "hl" : ""}"><td>${h(flag(r))}</td><td>${q.no ?? ""}</td><td><a href="https://www.youtube.com/watch?v=${h(r.k.video_id)}">${h(r.k.video_id)}</a><br><img src="thumbs/${h(r.k.video_id)}.jpg" alt=""></td>
<td>${h(r.k.streamer)}<br>${r.k.members ? "メン限" : "公開"}・${h(r.k.length)}<br><small>${h(r.k.stratum)}</small></td><td>${h(r.k.title)}</td>
<td><b>${h(r.k.label)}</b><br><small>${h(r.k.why)}</small></td><td><b>${h(r.a?.watchalong ?? "（無し）")}</b> ${h(r.a?.status ?? "")} ${h(r.a?.confidence ?? "")}<br>${h(works(r.a))}<br><small>${h(r.a?.rationale)}</small></td><td class="score"></td></tr>`;
}).join("\n");
const sum = blocks.map((b) => `<tr><td>${h(b.name)}</td><td>${b.n}</td><td>${b.W}（${b.work}／${b.nonwork}）</td><td>${b.N}</td><td>${b.U}</td><td><b>${b.nYes}/${b.N}</b>（${pct(b.nYesUp)}）</td><td>${b.nShown}/${b.notWork}（${pct(b.nShownUp)}）</td><td>${b.wYes}/${b.wUnsure}/${b.wNo}</td><td>${b.agree}/${b.n}</td></tr>`).join("\n");
fs.writeFileSync(join(dir, "report.html"), `<!doctype html><meta charset="utf-8"><title>${h(batch)} 採点</title>
<style>body{font:14px sans-serif;margin:16px}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:4px;vertical-align:top}img{width:160px}.hl{background:#fff4e0}.score{min-width:80px}small{color:#555}</style>
<h1>${h(batch)}：続きの回の候補を判定役が見分けられるか</h1>
<p>正解は判定役より先に付けた（基準は sealed/criteria.md）。<b>採点は scores.md に「video_id: 正解が正しい／判定役が正しい／どちらも違う・メモ」で書く</b>。印のある行（N に yes・作品でないのにサイトに出る答え・取りこぼし・不一致）を先に並べた。メン限の題名・概要欄を含むので公開しない。</p>
<table><tr><th>層</th><th>本数</th><th>正解 W（作品／作品ではない）</th><th>N</th><th>U</th><th>N に yes（95%上限）</th><th>作品でないのにサイトに出る答え（95%上限）</th><th>W に yes/unsure/no</th><th>一致</th></tr>
${sum}</table><br>
<table><tr><th>印</th><th>番号</th><th>動画</th><th>配信者・層</th><th>題名</th><th>正解</th><th>判定役</th><th>採点</th></tr>
${tr}</table>`, "utf8");
console.log(out.slice(0, 14).join("\n"));
