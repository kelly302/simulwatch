import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import type { Ctx } from "../lib/context.ts";
import { activeEventSql, farFutureCutoff } from "../lib/events.ts";
import { DATA_DIR, ROOT } from "../lib/paths.ts";
import { nowIso } from "../lib/time.ts";
import { log } from "../lib/log.ts";
import type { ExtractConfig } from "../resolve/config.ts";
import { extract, extractFromDescription } from "../resolve/extract.ts";
import { tiers } from "../resolve/resolve.ts";
import type { Plan } from "../resolve/resolve.ts";
import { matchKey } from "../resolve/normalize.ts";
import { hasDisambiguation, usableAnimeCandidate, isShortLatin, workMedia, labelCandidate, releaseStart } from "../resolve/match.ts";
import { ResolveCache } from "../resolve/cache.ts";
import { AnnictClient } from "../resolve/sources/annict.ts";
import { WikipediaClient } from "../resolve/sources/wikipedia.ts";
import type { WorkCandidate } from "../resolve/types.ts";
import { ROUTES, ROUTE_ORDER, classifyRoute, routeFlags, zeroErrorUpper95, notAWorkGroups, stratumOf } from "../resolve/route.ts";
import type { RouteType, RouteFacts, SegmentFrom } from "../resolve/route.ts";
import { sampleOrder } from "./sample.ts";
import { validateAnswer } from "./answer.ts";
import type { AuditAnswer } from "./answer.ts";
export { validateAnswer } from "./answer.ts";
export type { AuditAnswer, AuditStatus } from "./answer.ts";
import { collectRoutes, strataOf } from "../resolve/routing.ts";
import type { RuleAnswer, RuleWork, Routed } from "../resolve/routing.ts";
export { siblingTitles } from "../resolve/routing.ts";
export type { RuleAnswer, RuleWork } from "../resolve/routing.ts";
import { fetchWorks } from "./ai.ts";
import { writeBlindQueue } from "./blind.ts";
export type { BlindItem } from "./blind.ts";
import type { BlindItem } from "./blind.ts";
import { writeReviewHtml } from "./review.ts";

// 型ごとの抽出と、候補を見ない AI の判定との突き合わせ（ゲート2の決定。ローカルの CLI。定期実行のジョブからは呼ばない）。
//
//   audit:types    枠を型に分けて、型ごとの件数と危なさの目印の重なりを data/audit/types.md に書く（DB は変えない）
//   audit:sample   型ごとにシード付きで抽出し、data/audit/<batch>/ に書き出す
//                    queue/NN.md      AI に見せる待ち行列。タイトル・概要欄・サムネイルだけ（型・区間・ルールの答えは出さない）
//                    sealed/          ルールの答え（抽出の時点で固定）。判定が終わるまで AI は開かない
//   （判定）       Claude Code のセッションで queue/NN.md とサムネイルを見て、lookup で外部DBを確かめ、answers/NN.json を書く
//   audit:compare  AI の答えとルールの答えを突き合わせ、不一致の一覧（mismatches.md）と型ごとの集計（summary.md）を書く
//
// 待ち行列は型をまたいでシードで混ぜる（並び順や件数から型が分からないように）


function jst(t: string | null): string {
  if (!t) return "?";
  return new Date(Date.parse(t) + 9 * 3_600_000).toISOString().slice(0, 16).replace("T", " ");
}

function lastResolve(ctx: Ctx): string {
  const r = ctx.db.prepare("SELECT id, finished_at FROM runs WHERE job = 'resolve' AND status IN ('ok','partial') ORDER BY started_at DESC LIMIT 1")
    .get() as { id: string; finished_at: string } | undefined;
  return r ? `最後の名寄せ ${r.id}（${jst(r.finished_at)} 終了）の結果` : "名寄せの実行記録なし";
}

function typeTable(routed: Routed[]): { lines: string[] } {
  const strata = strataOf(routed);
  const lines = [
    "| 型 | 枠数 | 一次の抽出 | 0件のときの誤りの割合の95%上限 |",
    "| --- | ---: | ---: | --- |",
    ...strata.map((s) => {
      const n = s.rows.length;
      const k = Math.min(ROUTES[s.type].sample, n);
      const ub = k > 0 ? `${(zeroErrorUpper95(k) * 100).toFixed(1)}%${k === n ? "（全数）" : ""}` : ROUTES[s.type].note ?? "";
      return `| ${s.key}: ${ROUTES[s.type].label}${s.sub ? `（${s.sub}）` : ""} | ${n} | ${k} | ${ub} |`;
    }),
    `| 合計 | ${routed.length} | ${strata.reduce((a, s) => a + Math.min(ROUTES[s.type].sample, s.rows.length), 0)} | |`,
  ];
  return { lines };
}

function overlapTable(routed: Routed[]): string[] {
  const flags = ROUTE_ORDER.filter((t) => t !== "unique_exact");
  const rows = ROUTE_ORDER.filter((t) => routed.some((r) => r.rule.type === t));
  return [
    `| 型 ＼ 目印 | ${flags.join(" | ")} |`,
    `| --- | ${flags.map(() => "---:").join(" | ")} |`,
    ...rows.map((t) => {
      const rs = routed.filter((r) => r.rule.type === t);
      return `| ${t} | ${flags.map((f) => rs.filter((r) => r.rule.flags.includes(f)).length || "").join(" | ")} |`;
    }),
  ];
}

const METHOD_NOTE = `## 型の決め方

- 母集団: 一覧に出る枠（アーカイブ消失・判定ルールで除外・30日以上先の予定枠を除く）。DB は変えない
- 1枠は1つの型に入る。確定の AI の判定がある枠は AI の型、未同定の枠は理由で分け、同定済みの枠は下の順で先に当たった目印の型に入る
  （series → multi → tiebreak → season_variant → sub_desc_tag → search → label → disambiguation → prefix_sibling → suffix → redirect → unique_exact）
- 目印の出どころ
  - series・tiebreak・season_variant・search・label・suffix・redirect: EventWork の match_method
  - multi: 1枠に付いた作品が2つ以上
  - sub_desc_tag: 当たった区間の段。今の抽出ルールでタイトルと概要欄を切り出し直し、区間がどの段にあるかで見る
  - disambiguation: 当たった区間の Wikipedia の記事が曖昧さ回避ページか、「区間 (曖昧さ回避)」の記事がある
  - prefix_sibling: 当たった区間の照合キーで始まるほかの作品（同名の別作品を含む）が、Annict の検索（区間の部分一致）・
    当たった Annict 作品のシリーズ・Wikidata のラベル検索（前方一致。作品クラスで日本語ラベルのあるもの）にあり、枠の時点で公開済み
- 見ていないもの: AniList だけにある作品（Annict に無いアニメ）はほかの作品名の確認に入れていない。Wikidata のラベル検索は上位20件まで
`;

/** 型ごとの件数と目印の重なりを書く */
export async function auditTypes(ctx: Ctx, cfg: ExtractConfig): Promise<string> {
  const { routed, unknownFrom } = await collectRoutes(ctx, cfg);
  const { lines } = typeTable(routed);
  const dir = join(DATA_DIR, "audit");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "types.md");
  const md = [
    "# 同定の型（件数と目印の重なり）", "",
    `- DB の状態: ${lastResolve(ctx)}（${jst(nowIso())} に集計）`,
    `- 段が分からなかった区間（今の抽出ルールで切り出し直しても見つからない。series を除く）: ${unknownFrom}`, "",
    METHOD_NOTE,
    "## 型ごとの件数", "", ...lines, "",
    "## 目印の重なり（行の型に入った枠のうち、列の目印も付いている枠の数）", "", ...overlapTable(routed), "",
  ];
  writeFileSync(path, md.join("\n"), "utf8");
  return [...lines, "", `段が分からなかった区間 ${unknownFrom} → ${path}`].join("\n");
}

function batchDir(batch: string): string {
  if (!/^[A-Za-z0-9_.-]+$/.test(batch)) throw new Error(`batch の名前は英数字と _ . - だけにしてください: ${batch}`);
  return join(DATA_DIR, "audit", batch);
}

/** 型ごとに抽出して、AI に見せる待ち行列と、封をしたルールの答えを書き出す */
export async function auditSample(
  ctx: Ctx, cfg: ExtractConfig,
  opts: { seed: string; batch: string; only?: string[]; exclude?: string[]; n?: number },
): Promise<string> {
  const dir = batchDir(opts.batch);
  if (existsSync(join(dir, "sealed", "answers.json"))) throw new Error(`${dir} はもうあります（同じ batch に抽出し直すと答えと食い違う）。別の batch 名にしてください`);
  // 前の抽出で使った枠は除く（測り直しで同じ枠を二度数えない）
  const used = new Set<string>();
  for (const b of opts.exclude ?? []) {
    const f = join(batchDir(b), "sealed", "answers.json");
    if (!existsSync(f)) throw new Error(`除く抽出が見つからない: ${b}`);
    for (const a of (JSON.parse(readFileSync(f, "utf8")) as { answers: RuleAnswer[] }).answers) used.add(a.video_id);
  }
  const { routed, unknownFrom } = await collectRoutes(ctx, cfg);
  const { lines } = typeTable(routed);
  const picked: Routed[] = [];
  const perType: { type: string; population: number; excluded: number; n: number }[] = [];
  for (const s of strataOf(routed)) {
    // --type は層（not_a_work_rule:スポーツ）か型（not_a_work_rule。区分をすべて）で指定する
    if (opts.only && !opts.only.includes(s.key) && !opts.only.includes(s.type)) continue;
    const rs = s.rows.filter((r) => !used.has(r.ev.video_id));
    const n = Math.min(opts.n ?? ROUTES[s.type].sample, rs.length);
    if (n === 0) continue;
    const idx = new Map(rs.map((r) => [r.ev.video_id, r]));
    const ids = sampleOrder(`${opts.seed}:${s.key}`, [...idx.keys()]).slice(0, n);
    picked.push(...ids.map((id) => idx.get(id)!));
    perType.push({ type: s.key, population: rs.length, excluded: s.rows.length - rs.length, n });
  }
  const created = nowIso();
  const dbState = lastResolve(ctx);
  const { items, chunks } = await writeBlindQueue(ctx, dir, {
    batch: opts.batch, seed: opts.seed, rows: picked,
    sealed: { created_at: created, db_state: dbState, per_type: perType }, sealedNote: "audit:compare だけが読む",
  });
  const plan = [
    `# 型ごとの抽出（${opts.batch}）`, "",
    `- DB の状態: ${dbState}`,
    `- 抽出: 層（型。作品ではないの型は語の種類）ごとに sha256(シード + ":" + 層 + ":" + video_id) の昇順で先頭 n 件（枠数が n 未満なら全数）。シード「${opts.seed}」`,
    `- 除いた枠: ${opts.exclude?.length ? `前の抽出（${opts.exclude.join("・")}）で使った枠` : "なし"}${opts.n ? `。1層の件数は ${opts.n} 件に指定` : ""}`,
    "- 待ち行列の並び: sha256(シード + \":queue:\" + video_id) の昇順（型をまたいで混ぜる）",
    `- AI に見せるもの: 配信者・日時・タイトル・概要欄（定型文と URL の行を除き、その枠を指す行を先に12行まで）・サムネイル。型・区間・候補・ルールの答えは見せない`,
    `- 段が分からなかった区間: ${unknownFrom}`, "",
    METHOD_NOTE,
    "## 型ごとの件数", "", ...lines, "",
    "## 抽出した件数", "",
    "| 層 | 母集団（除いた枠を引いたあと） | 除いた枠 | 抽出 | 0件のときの95%上限 |", "| --- | ---: | ---: | ---: | --- |",
    ...perType.map((p) => `| ${p.type} | ${p.population} | ${p.excluded} | ${p.n} | ${(zeroErrorUpper95(p.n) * 100).toFixed(1)}%${p.n === p.population ? "（全数）" : ""} |`),
    `| 合計 | ${perType.reduce((a, p) => a + p.population, 0)} | ${perType.reduce((a, p) => a + p.excluded, 0)} | ${items.length} | |`, "",
  ];
  writeFileSync(join(dir, "plan.md"), plan.join("\n"), "utf8");
  return [
    `抽出 ${items.length} 件（${perType.map((p) => `${p.type} ${p.n}/${p.population}`).join("・")}）`,
    `サムネイル ${items.filter((x) => x.thumbnail).length} 件・待ち行列 ${chunks} ファイル → ${dir}`,
  ].join("\n");
}

// ---------------------------------------------------------------------------------------------
// 突き合わせ

/**
 * 突き合わせの結果。一致しないものは、サイトに誤った情報が出うるもの（wrong）と、出ないだけのもの（missing）に分ける
 *   wrong:            ルールの答えに AI と食い違う内容がある（ルールだけの作品がある・区分が違う。「作品ではない」で枠が消えるものを含む）
 *   wrong_episodes:   作品は一致。ルールの付けた話数に、AI の話数に無いものがある
 *   missing:          ルールの答えは AI の答えの一部（AI だけの作品がある・ルールは作品を特定できなかった）
 *   missing_episodes: 作品は一致。ルールの話数は AI の話数の一部（ルールが話数を付けていないものを含む）
 */
export type Outcome = "agree" | "wrong" | "wrong_episodes" | "missing" | "missing_episodes" | "hold";

export const OUTCOME_LABEL: Record<Outcome, string> = {
  agree: "一致", wrong: "誤りの疑い（作品・区分）", wrong_episodes: "誤りの疑い（話数）",
  missing: "取りこぼし（作品）", missing_episodes: "取りこぼし（話数）", hold: "AI 保留",
};

const STATUS_LABEL: Record<string, string> = {
  identified: "同定", not_a_work: "作品ではない", unidentifiable: "作品を特定できない", not_in_db: "作品だが外部DBに無い",
  hold: "保留", unresolved: "未同定",
};

/**
 * ルールの答えと AI の答えを比べる。
 * 作品は、AI のキー（key と also）がルールの作品のキーのどれかと同じか、MyAnimeList の ID が同じなら同じ作品とみなす。
 * 映画でない作品の話数は組で比べる
 */
export function compareAnswer(rule: RuleAnswer, ai: AuditAnswer, malOf: (key: string) => number | null): { outcome: Outcome; why: string } {
  if (ai.status === "hold") return { outcome: "hold", why: "AI が保留" };
  if (rule.status !== "identified") {
    if (ai.status === rule.status) return { outcome: "agree", why: "" };
    const why = `ルールは${STATUS_LABEL[rule.status] ?? rule.status}・AI は${STATUS_LABEL[ai.status]}`;
    // ルールが作品を特定できなかった枠を、AI が特定した（ルールは誤ったことは言っていない）
    if (rule.status === "unidentifiable" && (ai.status === "identified" || ai.status === "not_in_db")) return { outcome: "missing", why };
    return { outcome: "wrong", why };
  }
  if (ai.status !== "identified") return { outcome: "wrong", why: `ルールは同定・AI は${STATUS_LABEL[ai.status]}` };
  const aws = ai.works ?? [];
  const same = (rw: RuleWork, aw: NonNullable<AuditAnswer["works"]>[number]) =>
    [aw.key, ...(aw.also ?? [])].some((k) => rw.keys.includes(k) || (rw.mal !== null && malOf(k) === rw.mal));
  const onlyRule = rule.works.filter((rw) => !aws.some((aw) => same(rw, aw)));
  const onlyAi = aws.filter((aw) => !rule.works.some((rw) => same(rw, aw)));
  const whyWorks = [
    onlyRule.length ? `ルールだけ: ${onlyRule.map((w) => w.title).join("、")}` : "",
    onlyAi.length ? `AI だけ: ${onlyAi.map((w) => w.key).join("、")}` : "",
    ai.missing?.length ? `AI だけ（外部DBに無い）: ${ai.missing.join("、")}` : "",
  ].filter(Boolean).join(" ／ ");
  if (onlyRule.length) return { outcome: "wrong", why: whyWorks };
  const wrongEp: string[] = [];
  const missEp: string[] = [];
  for (const rw of rule.works) {
    if (rw.media === "movie") continue;
    const aw = aws.find((x) => same(rw, x))!;
    const a = [...new Set(aw.episodes ?? [])].sort((x, y) => x - y);
    if (a.join(",") === rw.episodes.join(",")) continue;
    const line = `${rw.title}: ルール ${rw.episodes.join(",") || "なし"}・AI ${a.join(",") || "なし"}`;
    if (rw.episodes.every((e) => a.includes(e))) missEp.push(line);
    else wrongEp.push(line);
  }
  if (wrongEp.length) return { outcome: "wrong_episodes", why: `話数が違う（${wrongEp.join(" ／ ")}）${whyWorks ? ` ／ ${whyWorks}` : ""}` };
  if (onlyAi.length || ai.missing?.length) return { outcome: "missing", why: [whyWorks, ...missEp].filter(Boolean).join(" ／ ") };
  if (missEp.length) return { outcome: "missing_episodes", why: `ルールの話数が足りない（${missEp.join(" ／ ")}）` };
  return { outcome: "agree", why: "" };
}

/**
 * AI が書いたキーの作品名が、枠のタイトル・概要欄・照会した語と2文字も重ならないか（キーの書き間違い・ほかの照会結果の取り違えの疑い）。
 * 照合キーの2文字の組で比べる。英題と和題のように表記が違う正しい答えも引っかかるので、疑いを並べるだけ
 */
export function keyLooksUnrelated(workTitles: string[], texts: string[], cfg: ExtractConfig): boolean {
  const grams = (t: string) => {
    const k = [...matchKey(t, cfg)];
    return new Set(k.length < 2 ? k : k.slice(1).map((c, i) => k[i] + c));
  };
  const pool = new Set(texts.flatMap((t) => [...grams(t)]));
  return !workTitles.some((w) => [...grams(w)].some((g) => pool.has(g)));
}

function fmtRuleWork(w: RuleWork): string {
  const what = [w.media ?? "種別なし", w.season ?? (w.year ? String(w.year) : "年なし")].join("・");
  return `${w.title}（${w.keys.join(" ")}・${what}）${w.episodes.length ? ` 話 ${w.episodes.join(",")}` : ""}［${w.method}、区間「${w.text}」・${w.from}］`;
}

/** AI の答えとルールの答えを突き合わせて、不一致の一覧と型ごとの集計を書く */
export async function auditCompare(ctx: Ctx, cfg: ExtractConfig, batch: string): Promise<string> {
  const dir = batchDir(batch);
  const sealed = JSON.parse(readFileSync(join(dir, "sealed", "answers.json"), "utf8")) as {
    seed: string; created_at: string; db_state: string; per_type: { type: string; population: number; n: number }[]; answers: RuleAnswer[];
  };
  const queue = JSON.parse(readFileSync(join(dir, "queue.json"), "utf8")) as { items: BlindItem[] };
  const itemOf = new Map(queue.items.map((x) => [x.video_id, x]));
  const ruleOf = new Map(sealed.answers.map((r) => [r.video_id, r]));
  const files = existsSync(join(dir, "answers")) ? readdirSync(join(dir, "answers")).filter((f) => f.endsWith(".json")).sort() : [];
  const answers = new Map<string, AuditAnswer & { model: string; file: string }>();
  const problems: string[] = [];
  for (const f of files) {
    const j = JSON.parse(readFileSync(join(dir, "answers", f), "utf8")) as { model?: string; answers?: AuditAnswer[] };
    if (!j.model || !Array.isArray(j.answers)) { problems.push(`${f}: model・answers が必要`); continue; }
    for (const a of j.answers) {
      const why = !ruleOf.has(a.video_id) ? "抽出に無い枠" : answers.has(a.video_id) ? `重複（${answers.get(a.video_id)!.file} にもある）` : validateAnswer(a);
      if (why) { problems.push(`${f} ${a.video_id}: ${why}`); continue; }
      answers.set(a.video_id, { ...a, model: j.model, file: f });
    }
  }

  // AI のキーの作品（表示と MyAnimeList の ID の突き合わせに使う）
  const keys = [...new Set([...answers.values()].flatMap((a) => (a.works ?? []).flatMap((w) => [w.key, ...(w.also ?? [])])))];
  const info = await fetchWorks(ctx, cfg, keys);
  for (const k of keys) if (!info.has(k)) problems.push(`外部DBで引けないキー（作品クラスでない Wikidata の項目を含む）: ${k}`);
  const malOf = (k: string) => info.get(k)?.malId ?? null;

  // キーの確認（作品名が枠の文字・照会語と重ならない答え）
  const suspicious: string[] = [];
  for (const a of answers.values()) {
    const it = itemOf.get(a.video_id);
    const texts = [it?.title ?? "", ...(it?.description_lines ?? []), ...(a.evidence.queries ?? []), a.evidence.thumbnail ?? "", a.rationale];
    for (const w of a.works ?? []) {
      const titles = [w.key, ...(w.also ?? [])].flatMap((k) => info.get(k)?.titles ?? []);
      if (titles.length && keyLooksUnrelated(titles, texts, cfg)) suspicious.push(`${a.file} ${a.video_id}: ${w.key} ${info.get(w.key)?.title ?? "?"}（タイトル: ${it?.title ?? "?"}）`);
    }
  }

  type Row = { rule: RuleAnswer; ai: AuditAnswer & { model: string; file: string }; outcome: Outcome; why: string };
  const rows: Row[] = [];
  for (const r of sealed.answers) {
    const a = answers.get(r.video_id);
    if (!a) continue;
    rows.push({ rule: r, ai: a, ...compareAnswer(r, a, malOf) });
  }

  // 型ごとの集計
  const cols: Outcome[] = ["agree", "wrong", "wrong_episodes", "missing", "missing_episodes", "hold"];
  const sum = [
    `| 型 | 母集団 | 抽出 | 答え | ${cols.map((o) => OUTCOME_LABEL[o]).join(" | ")} | 比べた件数 | 誤りの疑い0件なら95%上限 |`,
    `| --- | ---: | ---: | ---: | ${cols.map(() => "---:").join(" | ")} | ---: | --- |`,
    ...sealed.per_type.map((p) => {
      const rs = rows.filter((x) => stratumOf(x.rule) === p.type);
      const c = (o: Outcome) => rs.filter((x) => x.outcome === o).length;
      const compared = rs.length - c("hold");
      const bad = c("wrong") + c("wrong_episodes");
      return `| ${p.type} | ${p.population} | ${p.n} | ${rs.length} | ${cols.map((o) => c(o)).join(" | ")} | ${compared} | ${bad === 0 && compared > 0 ? `${(zeroErrorUpper95(compared) * 100).toFixed(1)}%` : bad ? "裁定待ち" : ""} |`;
    }),
  ];
  const head = [
    `- 抽出: ${sealed.created_at}・シード「${sealed.seed}」・${sealed.db_state}`,
    `- AI の答え: answers/ の ${files.length} ファイル（${[...new Set([...answers.values()].map((a) => a.model))].join("・") || "なし"}）。答えた枠 ${answers.size} / ${sealed.answers.length}`,
    "- 突き合わせの基準（抽出の前に決めたもの）:",
    "  - 同定どうしは、作品の組が同じなら一致。作品は、AI のキー（key と also）がルールの作品のキー（Annict・AniList・Wikidata）のどれかと同じか、MyAnimeList の ID が同じなら同じ作品",
    "  - 作品の組が同じで、映画でない作品の話数の組が違えば一致しない（AI が話数を書かなかったときも違うとみなす）",
    "  - 同定でない答えどうしは、区分（作品ではない・作品を特定できない）が同じなら一致。AI の「作品だが外部DBに無い」はどちらとも一致しない",
    "  - AI の保留は比べない（比べた件数から外す）",
    "- 一致しないものの分け方（2026-09-30、queue/01 の結果を見て分けた。一致の基準は変えていない）:",
    "  - 誤りの疑い: ルールの答えに AI と食い違う内容がある（ルールだけの作品・区分の違い・AI の話数に無い話数）。サイトに誤った情報が出うる",
    "  - 取りこぼし: ルールの答えが AI の答えの一部（AI だけの作品・ルールは特定できなかった・ルールの話数が足りない）。サイトに出ないだけ",
    "  - 取りこぼしを型の「誤り」に数えるかはユーザーが決める",
    "- 一致は「ルールが正しい」の証明ではない（AI とルールが同じ誤りをした枠は一致に入る）。不一致はユーザーが裁定する",
  ];
  writeFileSync(join(dir, "summary.md"), [`# 突き合わせの集計（${batch}）`, "", ...head, "", ...sum, "", ...(problems.length ? ["## 読めなかった答え", "", ...problems.map((p) => `- ${p}`)] : [])].join("\n"), "utf8");

  // 不一致の一覧
  const section = (title: string, list: Row[]) => [
    `## ${title}（${list.length} 件）`, "",
    ...list.flatMap((x, i) => {
      const it = itemOf.get(x.rule.video_id);
      const aiWorks = (x.ai.works ?? []).map((w) => {
        const c = info.get(w.key);
        return `${c?.title ?? "?"}（${[w.key, ...(w.also ?? [])].join(" ")}・${c?.media ?? "?"}・${c?.seasonName ?? c?.releaseYear ?? "?"}）${w.episodes?.length ? ` 話 ${w.episodes.join(",")}` : ""}`;
      });
      const ruleAns = x.rule.status === "identified"
        ? x.rule.works.map(fmtRuleWork).join(" ＋ ")
        : `${x.rule.text ? `「${x.rule.text}」` : ""}${x.rule.reason ? `（${x.rule.reason}）` : ""}`;
      return [
        `### ${i + 1}. ${x.rule.video_id}　型 ${stratumOf(x.rule)}　${it?.streamer ?? ""}　${it?.started_at ?? ""}`,
        ...(it?.thumbnail ? [`![サムネイル](${it.thumbnail})`, ""] : []),
        `- タイトル: ${it?.title ?? "?"}`,
        `- URL: https://www.youtube.com/watch?v=${x.rule.video_id}`,
        `- 概要欄（ローカルの確認用・公開しない）: ${it?.description_lines.join(" ／ ") || "なし"}`,
        `- ルールの答え: **${STATUS_LABEL[x.rule.status] ?? x.rule.status}** ${ruleAns}`,
        `  - 目印: ${x.rule.flags.join("・") || "なし"}${x.rule.prefixSiblings.length ? `（ほかの作品名: ${x.rule.prefixSiblings.join("、")}）` : ""}`,
        `- AI の答え: **${STATUS_LABEL[x.ai.status]}**${aiWorks.length ? ` ${aiWorks.join(" ＋ ")}` : ""}${x.ai.missing?.length ? ` ＋ 外部DBに無い作品「${x.ai.missing.join("」「")}」` : ""}${x.ai.title ? ` 作品名「${x.ai.title}」` : ""}（確度 ${x.ai.confidence}）`,
        `  - 見たもの: ${x.ai.evidence.looked.join("・")}${x.ai.evidence.queries?.length ? `（照会: ${x.ai.evidence.queries.join(" ／ ")}）` : ""}`,
        ...(x.ai.evidence.thumbnail ? [`  - サムネイル: ${x.ai.evidence.thumbnail}`] : []),
        `  - 理由: ${x.ai.rationale}`,
        `- 食い違い: ${x.why}`,
        "- 裁定: （ルール / AI / 両方誤り（正解: ） / 判断できない）",
        "",
      ];
    }),
  ];
  const mism = [
    `# 不一致の一覧（${batch}）`, "",
    "裁定のしかた: 「裁定」欄に、正しい方（ルール / AI）、両方誤りなら正しい答え、決められなければ「判断できない」を書く。", "",
    ...head, "",
    ...(["wrong", "wrong_episodes", "missing", "missing_episodes"] as Outcome[]).flatMap((o) => section(OUTCOME_LABEL[o], rows.filter((x) => x.outcome === o))),
    ...section("AI の保留（比べていない。参考）", rows.filter((x) => x.outcome === "hold")),
    `## キーの確認（AI のキーの作品名が、枠のタイトル・概要欄・照会語・理由と2文字も重ならないもの。${suspicious.length} 件）`, "",
    "表記の違う正しい答え（英題・略称）も入る。キーの書き間違いや、ほかの照会結果の取り違えがないかを見る", "",
    ...suspicious.map((x) => `- ${x}`), "",
  ];
  writeFileSync(join(dir, "mismatches.md"), mism.join("\n"), "utf8");

  // 裁定用の HTML（ボタンとメモ。裁定はブラウザに残し、md に書き出す）
  const aiLines = (x: Row) => [
    ...(x.ai.works ?? []).map((w) => {
      const c = info.get(w.key);
      return `${c?.title ?? "?"}（${[w.key, ...(w.also ?? [])].join(" ")}・${c?.media ?? "?"}・${c?.seasonName ?? c?.releaseYear ?? "?"}）${w.episodes?.length ? ` 話 ${w.episodes.join(",")}` : ""}`;
    }),
    ...(x.ai.missing ?? []).map((m) => `外部DBに無い作品「${m}」`),
    ...(x.ai.title ? [`作品名「${x.ai.title}」`] : []),
  ];
  const SECTIONS: { key: Outcome; label: string; required: boolean; note?: string }[] = [
    { key: "wrong", label: OUTCOME_LABEL.wrong, required: true, note: "ルールの答えに AI と食い違う内容がある枠。型ごとに「ルールの誤り」があるかを決める" },
    { key: "wrong_episodes", label: OUTCOME_LABEL.wrong_episodes, required: true },
    { key: "missing", label: OUTCOME_LABEL.missing, required: false, note: "参考。ルールの答えは AI の答えの一部（サイトに誤った情報は出ない）。気になるものだけ裁定する" },
    { key: "missing_episodes", label: OUTCOME_LABEL.missing_episodes, required: false, note: "参考。ルールが話数を付けていない・足りない枠" },
    { key: "hold", label: "AI 保留", required: false, note: "参考。AI が決められなかった枠（ルールの答えだけ見て、誤りがあれば裁定する）" },
  ];
  const sections = SECTIONS.filter((sec) => rows.some((x) => x.outcome === sec.key));
  const reviewItems = sections.flatMap((sec) => rows.filter((x) => x.outcome === sec.key).map((x, i) => {
    const it = itemOf.get(x.rule.video_id);
    return {
      id: x.rule.video_id, no: i + 1, section: sec.key, type: stratumOf(x.rule),
      typeLabel: `${ROUTES[x.rule.type]?.label ?? x.rule.type}${x.rule.sub ? `（${x.rule.sub}）` : ""}`,
      streamer: it?.streamer ?? "", started_at: it?.started_at ?? "", title: it?.title ?? "", url: `https://www.youtube.com/watch?v=${x.rule.video_id}`,
      thumb: it?.thumbnail ?? null, desc: it?.description_lines ?? [],
      rule: {
        status: STATUS_LABEL[x.rule.status] ?? x.rule.status,
        lines: x.rule.status === "identified" ? x.rule.works.map(fmtRuleWork) : [`${x.rule.text ? `「${x.rule.text}」` : ""}${x.rule.reason ? `（${x.rule.reason}）` : ""}`],
        flags: [x.rule.flags.join("・"), x.rule.prefixSiblings.length ? `ほかの作品名: ${x.rule.prefixSiblings.join("、")}` : ""].filter(Boolean).join(" ／ "),
      },
      ai: {
        status: STATUS_LABEL[x.ai.status] ?? x.ai.status, confidence: x.ai.confidence, lines: aiLines(x),
        looked: `${x.ai.evidence.looked.join("・")}${x.ai.evidence.queries?.length ? `（照会: ${x.ai.evidence.queries.join(" ／ ")}）` : ""}`,
        thumbnail: x.ai.evidence.thumbnail ?? "", rationale: x.ai.rationale,
      },
      why: x.why,
    };
  }));
  writeReviewHtml(join(dir, "review.html"), { mode: "audit", batch, source: join(dir, "mismatches.md"), file: "verdicts.md", sections, items: reviewItems });
  const c = (o: Outcome) => rows.filter((x) => x.outcome === o).length;
  return [
    `答え ${answers.size} / ${sealed.answers.length}: ${(Object.keys(OUTCOME_LABEL) as Outcome[]).map((o) => `${OUTCOME_LABEL[o]} ${c(o)}`).join("・")}`,
    ...problems.slice(0, 20).map((p) => `  ✖ ${p}`),
    ...(suspicious.length ? [`  キーの確認が要る答え ${suspicious.length} 件（mismatches.md の末尾）`] : []),
    `→ ${join(dir, "mismatches.md")}・${join(dir, "summary.md")}・裁定用 ${join(dir, "review.html")}`,
  ].join("\n");
}
