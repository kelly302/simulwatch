import type { Ctx } from "../lib/context.ts";
import { activeEventSql, farFutureCutoff } from "../lib/events.ts";
import { tx } from "../lib/db.ts";
import { nowIso } from "../lib/time.ts";
import type { ExtractConfig } from "./config.ts";
import { matchKey } from "./normalize.ts";
import { extract } from "./extract.ts";
import { markersOf, workMarkers } from "./markers.ts";
import { releaseStart } from "./match.ts";
import type { AnnictClient, AnnictEpisode } from "./sources/annict.ts";
import type { WorkCandidate } from "./types.ts";
import { upsertWork, getOrCreateEpisode, markUnresolved, markResolved } from "./store.ts";

// 視聴系列による期の割り当て（名寄せの最後に、DB 全体に対して行う）。
//
//   視聴系列: 同じ配信者が、同じ区間（照合キー B）で同じ作品の系統を2枠以上観ているもの。
//   系統:     当たった Annict の作品と同じ Annict シリーズの作品のうち、原題の照合キーが B で始まるテレビ・Web の作品（7話以上）。
//             総集編・新編集版は期に数えない。B と原題が完全に一致する作品を1期とし、ほかは放送順。
//             B と原題が完全に一致する作品が2つ以上（リメイク）なら系列として扱わない
//   枠ごとに期を決め、決まらない枠は保留（ambiguous）にする。1枠だけの系列・期が1つだけの系統には何もしない。
//
// 期を決める根拠（強い順。詳しくは decideRun）:
//   marker    タイトルの期・部の表記が、作品の原題の期・部の表記と合う（「二期」「Season 2」「R2」）
//   ordinal   「N期」の表記で、系統のどの作品の原題にも期・部の表記が無いとき、放送順で N 番目（「呪術廻戦３期」→ 死滅回游 前編）
//   subtitle  タイトルが、系統の作品の B より後ろの部分（副題）を含む（「BLEACH 千年血戦篇 -禍進譚-」）
//   date      枠の時点で放送が始まっていた期が1つだけ
//   episodes  話数の流れ。1話から観始めていれば1期（first）、前の枠の続き（same）、前の期の最終話のあと1話に戻る（next）、
//             作品の話数を超える通し番号（through。期をまたげば両方の期）
//   start     系列の最初の枠が「#1」「今日から」「スタート」（観始めている）なら1期。次の枠が「#2」なら番号の無い最初の枠も1期（start:implicit）
//   continue  前の枠と同じ期の続き。配信の回数（#N）が1つ進む（continue）、または「最終回」（continue:final）。前の枠がその期の最終回なら続けない
//   between   前後の枠が同じ期で、前の枠がその期の最終回でない。前の枠の期の次の期が次の枠で始まる（1話・今日から・#1）なら前の枠の期（between:boundary）
//   leading   最初の決まった枠が1期の途中の話数（2話以降）から始まっていれば、その前の枠も1期
// 使わない根拠: 枠数（何枠目か）からの推定、「タイトルに続編の表記がない」こと

const EPISODIC = new Set(["tv", "web"]);
const MIN_SEASON_EPISODES = 7;
/** 期として数えない作品（総集編・新編集版）。「PSYCHO-PASS サイコパス 新編集版」を2期の前に数えない */
const NOT_A_SEASON = /新編集|再編集|総集編|特別編|ダイジェスト/;
/** 系列に入れない枠（未同定の枠のうち、映画・OVA・総集編を観る枠）。テレビの期の流れとは別に観るもの */
const NOT_SERIES_EVENT = /劇場版|映画|総集[編篇]|OVA|OAD|特別編|ダイジェスト|総復習/i;
const START = /今日から|本日から|きょうから|最初から|はじめから|初めから|スタート|開幕/;
const FINAL = /最終回|最終話/;

export interface RunEvent {
  id: number;
  startedAt: string;
  title: string;
  /** 系列の区間（EventWork の extracted_text） */
  text: string;
  eps: number[];
  counter: number | null;
  final: boolean;
  start: boolean;
  tags: string[];
  locked: boolean;
  /** 今付いている系統の作品（seasons の添字） */
  current: number[];
  unresolved: string | null;
}

export interface Decision {
  seasons: number[];
  rule: string;
}

export interface Run {
  streamerId: number;
  streamer: string;
  b: string;
  seasons: WorkCandidate[];
  evs: RunEvent[];
}

/** 配信の回数（「#3」「# 2」「第3回」「ゆるキャン△②」）。ハッシュタグ（「#2周年」）と「⑰話」は数えない */
export function counterOf(title: string): number | null {
  const circled = title.match(/([①-⑳])(?!\s*話)/);
  if (circled) return circled[1]!.charCodeAt(0) - 0x2460 + 1;
  const t = title.normalize("NFKC");
  const m = t.match(/[#＃]\s*0*([0-9]{1,3})(?![0-9A-Za-z぀-ヿ一-鿿])/) ?? t.match(/第\s*([0-9]{1,3})\s*回/);
  return m ? Number(m[1]) : null;
}

/** 枠のタイトルから、系列の流れに使う手がかり（話数・配信の回数・最終回・観始め・期と部の表記）を読む */
export function toRunEvent(
  e: { id: number; title: string; startedAt: string; text: string },
  cfg: ExtractConfig,
  state: Partial<Pick<RunEvent, "locked" | "current" | "unresolved">> = {},
): RunEvent {
  const mk = markersOf(e.title, cfg);
  const counter = counterOf(e.title);
  return {
    ...e,
    eps: extract(e.title, cfg).episodes.map((x) => x.number),
    counter,
    final: FINAL.test(e.title),
    start: START.test(e.title) || counter === 1,
    tags: [...mk.season.keys(), ...mk.part],
    locked: state.locked ?? false,
    current: state.current ?? [],
    unresolved: state.unresolved ?? null,
  };
}

/** 系統（期として数える作品）。B と原題が完全に一致する作品を先頭に、ほかは放送順 */
export function familyOf(series: WorkCandidate[], b: string, cfg: ExtractConfig): WorkCandidate[] {
  const key = (w: WorkCandidate) => matchKey(w.titles[0] ?? w.title, cfg);
  return series
    .filter((w) => w.media && EPISODIC.has(w.media) && (w.episodesCount ?? 0) >= MIN_SEASON_EPISODES && !NOT_A_SEASON.test(w.title) && key(w).startsWith(b))
    .sort((a, c) => Number(key(c) === b) - Number(key(a) === b) || (releaseStart(a) ?? 0) - (releaseStart(c) ?? 0));
}

/** 話数が当てになるか（「第一話(シーズン通し第四十一話)」のように期ごとの番号と通し番号が並んでいれば使わない） */
function reliableEps(eps: number[]): boolean {
  const s = [...eps].sort((a, b) => a - b);
  return s.every((x, i) => i === 0 || x - s[i - 1]! <= 12);
}

/**
 * 系列の各枠の期を決める（純粋関数）。null は保留。
 * evs は開始日時の昇順。
 */
export function decideRun(run: Pick<Run, "b" | "seasons" | "evs">, cfg: ExtractConfig): (Decision | null)[] {
  const { seasons, evs, b } = run;
  const m = seasons.length;
  const count = (i: number) => seasons[i]!.episodesCount ?? 0;
  // 0話がある作品（「Fate/stay night [Unlimited Blade Works]」の #00）は、話数を1つずらして数える
  const zero = evs.some((e) => e.eps.includes(0)) ? 1 : 0;
  const cum = seasons.reduce<number[]>((acc, s) => [...acc, (acc.at(-1) ?? 0) + (s.episodesCount ?? 0)], []);
  const idxOf = (x: number) => cum.findIndex((c) => x + zero <= c);
  const range = (a: number, z: number) => Array.from({ length: z - a + 1 }, (_, k) => a + k);
  const primaryMk = seasons.map((s) => workMarkers(s.titles.slice(0, 1), cfg));
  const ordinalOk = primaryMk.every((mk) => mk.season.size === 0 && mk.part.size === 0);
  // 部の表記は、系統のどれかの作品名に部の表記があるときだけ見る（「ジョジョの奇妙な冒険 第3部 スターダストクルセイダース」の系統は、区間がすでに第3部の副題）
  const partsInFamily = primaryMk.some((mk) => mk.part.size > 0);
  const suffixes = seasons.map((s) => { const k = matchKey(s.titles[0] ?? s.title, cfg); return k.length > b.length ? k.slice(b.length) : ""; });
  // 期のまとまり: 作品名が別の作品名 +「第2クール」「Part 2」「後編」のものは、その作品と同じ期（放送順に並べる）
  const keyOf = (i: number) => matchKey(seasons[i]!.titles[0] ?? seasons[i]!.title, cfg);
  const COUR = /^(第?[0-9一二三四五六七八九十]+クール|[0-9]+(st|nd|rd|th)クール|part[0-9]+|後編|後半)$/;
  const groupOf = seasons.map((_, i) => i);
  for (let i = 0; i < m; i++) for (let j = 0; j < m; j++) {
    if (i !== j && keyOf(j).startsWith(keyOf(i)) && COUR.test(keyOf(j).slice(keyOf(i).length))) groupOf[j] = groupOf[i]!;
  }
  const groups = [...new Set(groupOf)].map((g) => seasons.map((_, i) => i).filter((i) => groupOf[i] === g))
    .sort((x, y) => (releaseStart(seasons[x[0]!]!) ?? 0) - (releaseStart(seasons[y[0]!]!) ?? 0));
  // 1期（区間と原題が一致する作品のまとまり）を先頭に
  const first = groups.findIndex((g) => g.includes(0));
  if (first > 0) groups.unshift(...groups.splice(first, 1));

  const dec: (Decision | null)[] = evs.map(() => null);
  // 期の表記があるのに系統のどの作品にも合わない枠。ほかの根拠で決めない（「2期」と書いてあるのに1期に付けない）
  const blocked = evs.map(() => false);

  // 1. 枠ごとの根拠（期の表記・副題・放送時期）
  evs.forEach((e, n) => {
    if (e.locked) {
      if (e.current.length) dec[n] = { seasons: e.current, rule: "ai" };
      else blocked[n] = true;
      return;
    }
    const tags = e.tags.filter((t) => !/^p\d+$/.test(t) || partsInFamily);
    if (tags.length) {
      const hits = seasons.map((_, i) => i).filter((i) => tags.every((t) => (t === "s1"
        ? ![...primaryMk[i]!.season.keys()].some((k) => k !== "s1")
        : primaryMk[i]!.season.has(t) || primaryMk[i]!.part.has(t))));
      // 期の表記に合う作品が1つだけなら決める。2つ以上（「season3」に Part.1 と Part.2）なら決めない。
      // ただし「1期」は、区間と原題が一致する作品（系統の先頭）があればそれ（「Dr.STONE 第1期」。後の期の原題に期の表記が無い系統）
      if (hits.length === 1) { dec[n] = { seasons: hits, rule: "marker" }; return; }
      if (hits.length > 1 && tags.length === 1 && tags[0] === "s1" && hits[0] === 0 && matchKey(seasons[0]!.titles[0] ?? seasons[0]!.title, cfg) === b) {
        dec[n] = { seasons: [0], rule: "marker" };
        return;
      }
      const nums = tags.map((t) => t.match(/^s(\d+)$/)).filter((x): x is RegExpMatchArray => !!x).map((x) => Number(x[1]));
      if (hits.length === 0 && ordinalOk && nums.length === 1 && tags.length === 1 && nums[0]! >= 1 && nums[0]! <= groups.length) {
        // 「N期」は、クールで分かれた作品をひとまとまりにして N 番目（「Dr.STONE 第3期」は NEW WORLD と NEW WORLD 第2クール）。
        // まとまりに作品が2つ以上あれば、期の中の話数で選ぶ（話数が無ければ決めない）
        const g = groups[nums[0]! - 1]!;
        if (g.length === 1) { dec[n] = { seasons: g, rule: "ordinal" }; return; }
        const eps = e.eps.length && reliableEps(e.eps) ? e.eps : [];
        if (eps.length) {
          const gc = g.reduce<number[]>((acc, i) => [...acc, (acc.at(-1) ?? 0) + count(i)], []);
          const ia = gc.findIndex((c) => Math.min(...eps) <= c), iz = gc.findIndex((c) => Math.max(...eps) <= c);
          if (ia >= 0 && iz >= ia) { dec[n] = { seasons: g.slice(ia, iz + 1), rule: "ordinal" }; return; }
        }
      }
      blocked[n] = true;
      return;
    }
    const tk = matchKey(e.title, cfg);
    const sub = suffixes.map((x, i) => (x.length >= 2 && tk.includes(x) ? i : -1)).filter((i) => i >= 0);
    if (sub.length === 1) { dec[n] = { seasons: sub, rule: "subtitle" }; return; }
    const t = Date.parse(e.startedAt);
    const aired = seasons.map((s, i) => ({ s, i })).filter(({ s }) => { const st = releaseStart(s); return st === null || st <= t + 31 * 86_400_000; });
    if (aired.length === 1) dec[n] = { seasons: [aired[0]!.i], rule: "date" };
  });

  // 2・3 を決まる枠が無くなるまで繰り返す
  for (let guard = 0; guard < 8; guard++) {
    let changed = false;
    // 2. 系列の流れ（前から順に）
    type State = { i: number; last: number; ended: boolean; counter: number | null; global: boolean };
    let state: State | null | "unknown" = null;
    const endedAt: boolean[] = evs.map(() => false);
    const after = (d: Decision, e: RunEvent, prev: State | null): State => {
      const i = Math.max(...d.seasons);
      const global = (!!prev && prev.global) || d.rule === "episodes:through";
      const base = global && i > 0 ? cum[i - 1]! : 0;
      const eps = e.eps.length && reliableEps(e.eps) ? e.eps : [];
      const last = eps.length ? Math.max(...eps) + zero - base : prev && prev.i === i ? prev.last : 0;
      const ended = e.final || (count(i) > 0 && last >= count(i));
      const counter = e.counter ?? (prev && prev.i === i && prev.counter !== null ? prev.counter + 1 : d.rule === "start:implicit" ? 1 : null);
      return { i, last, ended, counter, global };
    };
    evs.forEach((e, n) => {
      const known = state !== null && state !== "unknown" ? state : null;
      if (dec[n]) {
        state = after(dec[n]!, e, known);
        endedAt[n] = state.ended;
        return;
      }
      if (blocked[n]) { state = "unknown"; return; }
      let r: Decision | null = null;
      const eps = e.eps.length && reliableEps(e.eps) ? e.eps : [];
      if (eps.length) {
        const a = Math.min(...eps), z = Math.max(...eps);
        const through = (): Decision | null => {
          const ia = idxOf(a), iz = idxOf(z);
          return ia >= 0 && iz >= ia ? { seasons: range(ia, iz), rule: "episodes:through" } : null;
        };
        if (known) {
          const c = count(known.i) - zero;
          if (known.global) r = through();
          else if (a <= 1 && known.ended && known.i + 1 < m) r = { seasons: [known.i + 1], rule: "episodes:next" };
          else if (!known.ended && z <= c) r = { seasons: [known.i], rule: "episodes:same" };
          else if (z > c) r = through();
        } else if (state === null) {
          if (a <= 1) r = { seasons: [0], rule: "episodes:first" };
          else if (z > count(0) - zero) r = through();
          else if (n === 1 && !dec[0] && !blocked[0] && evs[0]!.eps.length === 0 && evs[0]!.tags.length === 0 && a <= 13) {
            // 番号の無い最初の枠のすぐ次が途中の話数から（「STEINS;GATE」の次の枠が「6話～」）: 最初の枠で1話から観ている → 1期
            dec[0] = { seasons: [0], rule: "start:gap" };
            r = { seasons: [0], rule: "episodes:same" };
          }
        }
        if (!r) { state = "unknown"; return; }
      } else if (known && !known.ended) {
        if (e.final && (e.counter === null || known.counter === null || e.counter === known.counter + 1)) r = { seasons: [known.i], rule: "continue:final" };
        else if (e.counter !== null && known.counter !== null && e.counter === known.counter + 1) r = { seasons: [known.i], rule: "continue" };
      } else if (state === null) {
        const next = evs[n + 1];
        if (e.start) r = { seasons: [0], rule: "start" };
        else if (e.counter === null && next && next.counter === 2 && next.tags.length === 0) r = { seasons: [0], rule: "start:implicit" };
      }
      if (r) {
        dec[n] = r;
        changed = true;
        state = after(r, e, known);
        endedAt[n] = state.ended;
      }
    });
    // 3. 前後の決まった枠から埋める
    evs.forEach((e, n) => {
      if (dec[n] || blocked[n]) return;
      let p = -1, q = -1;
      for (let j = n - 1; j >= 0; j--) { if (blocked[j]) break; if (dec[j]) { p = j; break; } }
      for (let j = n + 1; j < evs.length; j++) { if (blocked[j]) break; if (dec[j]) { q = j; break; } }
      if (p >= 0 && q >= 0) {
        const sp = Math.max(...dec[p]!.seasons), sq = Math.min(...dec[q]!.seasons);
        const nq = evs[q]!;
        const qStarts = (nq.eps.length > 0 && Math.min(...nq.eps) <= 1) || nq.start || nq.counter === 1;
        if (sp === sq && !endedAt[p]) { dec[n] = { seasons: [sp], rule: "between" }; changed = true; }
        else if (sq === sp + 1 && !endedAt[p] && qStarts) { dec[n] = { seasons: [sp], rule: "between:boundary" }; changed = true; }
      } else if (p < 0 && q >= 0) {
        const nq = evs[q]!;
        const eps = nq.eps.length && reliableEps(nq.eps) ? nq.eps : [];
        if (dec[q]!.seasons.length === 1 && dec[q]!.seasons[0] === 0 && eps.length && Math.min(...eps) > 1 && e.eps.length === 0) {
          dec[n] = { seasons: [0], rule: "leading" };
          changed = true;
        }
      }
    });
    if (!changed) break;
  }
  return dec;
}

export interface SeriesStats {
  runs: number;
  events: number;
  byRule: Record<string, number>;
  held: number;
  /** 今と同じ期 */
  same: number;
  /** 別の期に付け替えた */
  changed: number;
  /** 未同定から期が決まった */
  rescued: number;
  /** 付いていた期を外して保留にした */
  removed: number;
  lines: string[];
}

interface EvRow {
  id: number;
  streamer_id: number;
  streamer: string;
  started_at: string;
  title_raw: string;
}

/**
 * 視聴系列を作って期を決め、apply なら DB に反映する（apply=false は確認用の一覧だけ）。
 * AI の判定で確定した枠は変えない（系列の根拠としては使う）
 */
export async function assignSeasons(ctx: Ctx, cfg: ExtractConfig, annict: AnnictClient, ruleVersion: string, apply = true): Promise<SeriesStats> {
  const db = ctx.db;
  const cutoff = farFutureCutoff(ctx.crawlCfg.upcoming.max_days_ahead);
  const events = db.prepare(`SELECT e.id, e.streamer_id, s.name AS streamer, e.started_at, e.title_raw FROM watch_events e
    JOIN streamers s ON s.id = e.streamer_id WHERE ${activeEventSql("e")} AND e.started_at IS NOT NULL ORDER BY e.started_at, e.id`).all(cutoff) as unknown as EvRow[];
  const evById = new Map(events.map((e) => [e.id, e]));
  const rows = db.prepare(`SELECT ew.id AS row_id, ew.watch_event_id AS ev, ew.extracted_text AS x, ew.match_method AS method, w.annict_id AS aid, w.media
    FROM event_works ew JOIN works w ON w.id = ew.work_id`).all() as { row_id: number; ev: number; x: string; method: string; aid: number | null; media: string | null }[];
  const unresolved = new Map((db.prepare(`SELECT watch_event_id AS ev, reason, detail FROM unresolved WHERE resolved_at IS NULL`).all() as { ev: number; reason: string; detail: string | null }[])
    .map((u) => [u.ev, { reason: u.reason, detail: u.detail ? (JSON.parse(u.detail) as Record<string, unknown>) : {} }]));
  const locked = new Set((db.prepare(`SELECT watch_event_id AS ev FROM ai_decisions WHERE revoked_at IS NULL AND status != 'hold'`).all() as { ev: number }[]).map((r) => r.ev));

  const rowsByEv = new Map<number, typeof rows>();
  for (const r of rows) rowsByEv.set(r.ev, [...(rowsByEv.get(r.ev) ?? []), r]);
  const candIds = (d: Record<string, unknown>) => ((d.candidates ?? []) as string[]).map((c) => c.split(" ")[0]!).filter((c) => c.startsWith("annict:")).map((c) => Number(c.slice(7)));
  const baseIds = rows.filter((r) => r.aid !== null && r.media && EPISODIC.has(r.media)).map((r) => r.aid!);
  const series = await annict.seriesWorks([...new Set([...baseIds, ...[...unresolved.values()].flatMap((u) => candIds(u.detail))])]);

  // 系列: 配信者 × B。同定済みの枠（系統の作品に B で当たったもの）から作る
  const runs = new Map<string, Run>();
  const allSeries = new Map<string, WorkCandidate[]>();
  const runKey = (sid: number, b: string) => `${sid}\t${b}`;
  for (const r of rows) {
    const e = evById.get(r.ev);
    if (!e || r.aid === null || !r.media || !EPISODIC.has(r.media)) continue;
    const b = matchKey(r.x, cfg);
    if (b.length < 2) continue;
    const ss = series.get(r.aid) ?? [];
    const fam = familyOf(ss, b, cfg);
    if (!fam.some((w) => w.annictId === r.aid)) continue;
    const k = runKey(e.streamer_id, b);
    const run = runs.get(k) ?? { streamerId: e.streamer_id, streamer: e.streamer, b, seasons: fam, evs: [] };
    if (run.seasons.length < fam.length) run.seasons = fam;
    allSeries.set(k, [...new Map([...(allSeries.get(k) ?? []), ...ss].map((w) => [w.sourceKey, w])).values()]);
    runs.set(k, run);
  }
  // 系列の枠を集める
  const members = new Map<string, { ev: EvRow; text: string }[]>();
  const add = (k: string, ev: EvRow, text: string) => {
    const list = members.get(k) ?? [];
    if (!list.some((x) => x.ev.id === ev.id)) list.push({ ev, text });
    members.set(k, list);
  };
  for (const r of rows) {
    const e = evById.get(r.ev);
    if (!e || r.aid === null) continue;
    const k = runKey(e.streamer_id, matchKey(r.x, cfg));
    if (runs.get(k)?.seasons.some((w) => w.annictId === r.aid)) add(k, e, r.x);
  }
  // 未同定の枠: 前回この系列で保留にした枠、候補に系統の作品がある枠、タイトルに B（4文字以上）を含む枠。
  // 映画・OVA・総集編の枠と、系統に入らない同じシリーズの作品名（「呪術廻戦0」）を含む枠は入れない。
  // 複数の系列に当てはまれば、B の長い（具体的な）系列に入れる
  for (const e of events) {
    const u = unresolved.get(e.id);
    if (!u || u.reason === "not_a_work" || u.reason === "error" || NOT_SERIES_EVENT.test(e.title_raw)) continue;
    if (rowsByEv.has(e.id)) continue;
    const tk = matchKey(e.title_raw, cfg);
    const prev = (u.detail.series as { b?: string } | undefined)?.b;
    const cids = candIds(u.detail);
    let best: string | null = null;
    for (const [k, run] of runs) {
      if (run.streamerId !== e.streamer_id) continue;
      const hit = prev === run.b || cids.some((c) => run.seasons.some((s) => s.annictId === c)) || (run.b.length >= 4 && tk.includes(run.b));
      if (!hit) continue;
      const others = (allSeries.get(k) ?? []).filter((w) => !run.seasons.some((s) => s.sourceKey === w.sourceKey))
        .map((w) => matchKey(w.titles[0] ?? w.title, cfg).replace(/^(劇場版|映画)/, "")).filter((x) => x.length > run.b.length);
      if (others.some((x) => tk.includes(x))) continue;
      if (!best || run.b.length > runs.get(best)!.b.length) best = k;
    }
    if (best) add(best, e, runs.get(best)!.b);
  }

  const stats: SeriesStats = { runs: 0, events: 0, byRule: {}, held: 0, same: 0, changed: 0, rescued: 0, removed: 0, lines: [] };
  type Plan = { run: Run; decisions: (Decision | null)[] };
  const plans: Plan[] = [];
  for (const [k, run] of runs) {
    const list = (members.get(k) ?? []).sort((a, c) => a.ev.started_at.localeCompare(c.ev.started_at) || a.ev.id - c.ev.id);
    if (list.length < 2 || run.seasons.length < 2) continue;
    // B と原題が完全に一致する作品が2つ以上（リメイク）: どちらの系統か決められないので系列として扱わない
    if (run.seasons.filter((w) => matchKey(w.titles[0] ?? w.title, cfg) === run.b).length > 1) continue;
    run.evs = list.map(({ ev, text }) => {
      const cur = (rowsByEv.get(ev.id) ?? []).map((r) => run.seasons.findIndex((s) => s.annictId === r.aid)).filter((i) => i >= 0);
      return toRunEvent({ id: ev.id, title: ev.title_raw, startedAt: ev.started_at, text }, cfg, {
        locked: locked.has(ev.id), current: [...new Set(cur)], unresolved: unresolved.get(ev.id)?.reason ?? null,
      });
    });
    const decisions = decideRun(run, cfg);
    plans.push({ run, decisions });
    stats.runs++;
    stats.events += run.evs.length;
    stats.lines.push(`\n### ${run.streamer} / ${run.b}\n\n系統: ${run.seasons.map((s, i) => `${i + 1}. ${s.title}（${s.episodesCount}話・${s.seasonName ?? "?"}）`).join(" → ")}\n`);
    stats.lines.push("| 日付 | 割り当て | 根拠 | 割り当ての前 | タイトル |\n| --- | --- | --- | --- | --- |");
    run.evs.forEach((e, n) => {
      const d = decisions[n];
      // 「系統N」は系統の中の並び順（上の「系統:」の番号）。期の番号とは限らない（クールで分かれた作品は別の番号）
      const now = e.current.length ? e.current.map((i) => `系統${i + 1}`).join("+") : e.unresolved ?? "-";
      stats.lines.push(`| ${e.startedAt.slice(0, 10)} | ${d ? d.seasons.map((i) => `系統${i + 1}`).join("+") : "保留"} | ${d?.rule ?? "-"} | ${now} | ${e.title.replace(/\|/g, "｜")} |`);
    });
  }

  // 話数を紐付けるテレビ作品の話の一覧
  const epIds = plans.flatMap((p) => p.decisions.flatMap((d, n) => (d && d.seasons.length === 1 && /^episodes:(first|same|next)$/.test(d.rule) && p.run.evs[n]!.eps.length ? [p.run.seasons[d.seasons[0]!]!.annictId!] : [])));
  const annictEpisodes: Map<number, AnnictEpisode[]> = epIds.length ? await annict.episodes(epIds) : new Map();

  const CONF: Record<string, number> = { ai: 1, marker: 0.9, subtitle: 0.9, date: 0.9, ordinal: 0.8 };
  const confOf = (rule: string) => CONF[rule] ?? (rule.startsWith("episodes") ? 0.85 : 0.75);
  const apply1 = () => {
    for (const { run, decisions } of plans) {
      run.evs.forEach((e, n) => {
        const d = decisions[n];
        if (d) stats.byRule[d.rule] = (stats.byRule[d.rule] ?? 0) + 1;
        else stats.held++;
        if (e.locked) return;
        const famIds = new Set(run.seasons.map((s) => s.annictId));
        const famRows = (rowsByEv.get(e.id) ?? []).filter((r) => r.aid !== null && famIds.has(r.aid));
        if (d) {
          const target = d.seasons.map((i) => run.seasons[i]!);
          const sameSet = famRows.length > 0 && new Set(famRows.map((r) => r.aid)).size === target.length && target.every((w) => famRows.some((r) => r.aid === w.annictId));
          if (sameSet) { stats.same++; return; }
          if (e.current.length) stats.changed++;
          else stats.rescued++;
          if (!apply) return;
          for (const r of famRows) db.prepare("DELETE FROM event_works WHERE id = ?").run(r.row_id);
          const now = nowIso();
          const ins = db.prepare(`INSERT OR IGNORE INTO event_works (watch_event_id, work_id, episode_id, confidence, match_method, extracted_text, rule_version, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
          for (const w of target) {
            const workId = upsertWork(db, w);
            const eps = d.seasons.length === 1 && /^episodes:(first|same|next)$/.test(d.rule) ? e.eps.filter((x) => x >= 0 && x <= (w.episodesCount ?? 0)) : [];
            if (eps.length) {
              const list = annictEpisodes.get(w.annictId!) ?? [];
              for (const x of eps) {
                const a = list.find((y) => y.number === x);
                ins.run(e.id, workId, getOrCreateEpisode(db, workId, x, a?.numberText ?? `第${x}話`, a?.title ?? null), confOf(d.rule), `series:${d.rule}`, e.text, ruleVersion, now);
              }
            } else {
              ins.run(e.id, workId, null, confOf(d.rule), `series:${d.rule}`, e.text, ruleVersion, now);
            }
          }
          if (e.unresolved) markResolved(db, e.id, ruleVersion);
          return;
        }
        // 保留: 付いていた系統の作品を外す。ほかの作品が残らなければ未同定（候補が複数）にする
        const info = { b: run.b, streamer_id: run.streamerId, seasons: run.seasons.map((s) => s.title) };
        if (famRows.length) {
          stats.removed++;
          if (!apply) return;
          for (const r of famRows) db.prepare("DELETE FROM event_works WHERE id = ?").run(r.row_id);
          const left = (db.prepare("SELECT COUNT(*) AS n FROM event_works WHERE watch_event_id = ?").get(e.id) as { n: number }).n;
          if (left === 0) {
            markUnresolved(db, e.id, "ambiguous", e.text, {
              series: info,
              ambiguous_methods: ["視聴系列で期が決まらない"],
              candidates: run.seasons.map((w) => `${w.sourceKey} ${w.title} (${w.media ?? "?"}, ${w.releaseYear ?? "?"})`),
            }, ruleVersion);
          }
        } else if (apply && e.unresolved) {
          const u = unresolved.get(e.id)!;
          db.prepare("UPDATE unresolved SET detail = ? WHERE watch_event_id = ? AND resolved_at IS NULL").run(JSON.stringify({ ...u.detail, series: info }), e.id);
        }
      });
    }
  };
  if (apply) tx(db, apply1);
  else apply1();
  return stats;
}
