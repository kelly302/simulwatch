import type { Ctx } from "../lib/context.ts";
import { activeEventSql, farFutureCutoff } from "../lib/events.ts";
import type { ExtractConfig } from "../resolve/config.ts";
import { matchKey } from "../resolve/normalize.ts";
import { extract } from "../resolve/extract.ts";
import { markersOf, workMarkers } from "../resolve/markers.ts";
import { releaseStart } from "../resolve/resolve.ts";
import { ResolveCache } from "../resolve/cache.ts";
import { AnnictClient } from "../resolve/sources/annict.ts";
import type { WorkCandidate } from "../resolve/types.ts";

// 視聴系列（同じ配信者が同じ作品の系統を続けて観た枠）の件数調査（ローカルの CLI。実装の判断材料）。
// 手順は出力の先頭に書く。

// 期として数える作品: テレビ・Web で7話以上（OVA・ショートアニメ・特番・総集編は期として数えない）
const EPISODIC = new Set(["tv", "web"]);
const MIN_SEASON_EPISODES = 7;

const PROCEDURE = `# 視聴系列の件数調査

## 手順

- **作品の系統**：アニメ（Annict）のテレビ・Web の作品が付いた枠だけを対象にする（映画・PV の枠は数えない）。
  系統は、付いた作品と同じ Annict シリーズ（Work.seriesList）の作品のうち、照合キーが「枠で当たった区間の照合キー」で始まるもの
  （配信者が「Fate/Zero」と書けば 1stシーズン・2ndシーズン、「CLANNAD」ならクラナド・AFTER STORY、「呪術廻戦」なら各期）。
  シリーズ全体（ガンダム・ドラゴンボールなど）を1つの系統にはしない。前方一致は同じ Annict シリーズの中だけで使う（「仮面ライダー」の件の対策）。
- **視聴系列**：同じ配信者 × 同じ区間（照合キー）で2枠以上。未同定の枠のうち、候補（ambiguous の候補）に系統の作品があるもの、
  またはタイトルにその区間（照合キー4文字以上）を含むものも同じ系列に含める。
- **1枠の期の決め方**（案を数えるためのもの。実装はまだしていない）:
  1. 枠のタイトルに期の表記がある → その期（期の表記で決まる）
  2. 枠の時点で放送が始まっていた期が1つだけ → その期（放送時期で決まる）
  3. 枠のタイトルに話数がある → 系列の流れで決める。
     直前の枠がその期の最終話で、話数が1に戻っていれば次の期。作品の話数を超える番号は通し番号として各期の話数を積み上げて当てる。
     系列の最初の枠で1話から始まっていれば1期。前の期の話の続きなら同じ期。それ以外は決めない
  4. 話数の無い枠 → 前後の話数付きの枠が同じ期で、前の枠の続きなら同じ期。最初の話数付きの枠が1期の2話以降なら、その前の枠も1期。
     期の境目に挟まれた枠と、後ろにしか話数付きの枠が無い・前にしか無い枠は決めない
  5. 系列内に話数も期の表記も無い → 期を推定しない（保留）
- **案c**：同名で続きの期がある作品は、話数か期の表記がない限り決めない。今の同定のうち、影響する枠を数える。
  「続きの期」は、付いた作品より後に始まる同じ系統の期。枠の時点でまだ始まっていない期は数えない版も出す。
`;

interface Ev {
  id: number;
  started_at: string;
  title_raw: string;
  description_raw: string | null;
  streamer: string;
  workIds: number[];
  reason: string | null;
  cands: string[];
}

export async function seriesReport(ctx: Ctx, cfg: ExtractConfig): Promise<string> {
  const db = ctx.db;
  const token = process.env.ANNICT_TOKEN;
  if (!token) throw new Error("ANNICT_TOKEN が必要です（Annict のシリーズの全作品を取るため）");
  const annict = new AnnictClient(ctx.http, new ResolveCache(db, 30), token, cfg.annict);
  const cutoff = farFutureCutoff(ctx.crawlCfg.upcoming.max_days_ahead);

  const events = (db.prepare(`SELECT e.id, e.started_at, e.title_raw, e.description_raw, s.name AS streamer,
      (SELECT GROUP_CONCAT(DISTINCT ew.work_id) FROM event_works ew WHERE ew.watch_event_id = e.id) AS wids,
      u.reason, u.detail
    FROM watch_events e JOIN streamers s ON s.id = e.streamer_id
    LEFT JOIN unresolved u ON u.watch_event_id = e.id AND u.resolved_at IS NULL
    WHERE ${activeEventSql("e")} ORDER BY e.started_at`).all(cutoff) as Record<string, string | number | null>[]).map((r): Ev => ({
    id: r.id as number, started_at: String(r.started_at), title_raw: String(r.title_raw), description_raw: r.description_raw as string | null,
    streamer: String(r.streamer), workIds: r.wids ? String(r.wids).split(",").map(Number) : [], reason: r.reason as string | null,
    cands: r.detail ? ((JSON.parse(String(r.detail)).candidates ?? []) as string[]).map((c) => c.split(" ")[0]!) : [],
  }));
  // 同定済みの枠: 付いた Annict の作品（テレビ・Web・OVA）と、当たった区間
  const rows = db.prepare(`SELECT ew.watch_event_id AS ev, ew.extracted_text AS x, w.annict_id AS aid, w.media
    FROM event_works ew JOIN works w ON w.id = ew.work_id WHERE w.annict_id IS NOT NULL GROUP BY ew.watch_event_id, w.id`).all() as { ev: number; x: string; aid: number; media: string | null }[];
  const candIds = [...new Set(events.flatMap((e) => e.cands).filter((c) => c.startsWith("annict:")).map((c) => Number(c.slice(7))))];
  const series = await annict.seriesWorks([...new Set([...rows.map((r) => r.aid), ...candIds])]);

  // 系統: 同じ Annict シリーズの作品のうち、照合キーが「当たった区間の照合キー B」で始まるもの（テレビ・Web で7話以上。OVA・ショートアニメ・総集編は期として数えない）。
  // 「Fate/Zero」→ 1stシーズン・2ndシーズン、「CLANNAD」→ クラナド・AFTER STORY、「機動戦士ガンダム 水星の魔女」→ Season1・Season2
  const familyOf = (aid: number, b: string): WorkCandidate[] =>
    (series.get(aid) ?? []).filter((w) => w.media && EPISODIC.has(w.media) && (w.episodesCount ?? 0) >= MIN_SEASON_EPISODES && w.titles.some((t) => matchKey(t, cfg).startsWith(b)))
      // 1期は作品名が区間と完全に一致する作品（同じ時期のミニアニメ「〜●●の魔法〜」を1期にしない）。ほかは放送順
      .sort((a, c) => (Number(matchKey(c.title, cfg) === b) - Number(matchKey(a.title, cfg) === b)) || (releaseStart(a) ?? 0) - (releaseStart(c) ?? 0));
  const evById = new Map(events.map((e) => [e.id, e]));
  // 系列: 配信者 × B
  const runs = new Map<string, { streamer: string; b: string; seasons: WorkCandidate[]; evs: Ev[] }>();
  for (const r of rows) {
    const e = evById.get(r.ev);
    if (!e || !r.media || !EPISODIC.has(r.media)) continue;
    const b = matchKey(r.x, cfg);
    if (b.length < 2) continue;
    const k = `${e.streamer}\t${b}`;
    const run = runs.get(k) ?? { streamer: e.streamer, b, seasons: familyOf(r.aid, b), evs: [] };
    if (run.seasons.length < familyOf(r.aid, b).length) run.seasons = familyOf(r.aid, b);
    if (!run.evs.includes(e)) run.evs.push(e);
    runs.set(k, run);
  }
  // 未同定の枠: 候補に系統の作品がある、またはタイトルに B（4文字以上）を含むものを、同じ配信者の系列に足す
  for (const e of events) {
    if (e.workIds.length || !e.reason || e.reason === "not_a_work") continue;
    const tk = matchKey(e.title_raw, cfg);
    for (const run of runs.values()) {
      if (run.streamer !== e.streamer || run.evs.includes(e)) continue;
      const inCands = e.cands.some((c) => c.startsWith("annict:") && run.seasons.some((s) => s.annictId === Number(c.slice(7))));
      if (inCands || (run.b.length >= 4 && tk.includes(run.b))) run.evs.push(e);
    }
  }
  const multiRuns = [...runs.values()].filter((r) => r.evs.length >= 2).map((r) => ({ ...r, evs: r.evs.sort((a, c) => a.started_at.localeCompare(c.started_at)) }));
  const withSeasons = multiRuns.filter((r) => r.seasons.length >= 2);

  // 1枠の期を決める
  const counts = { marker: 0, date: 0, episodes: 0, between: 0, leading: 0, undecided_with_eps_in_run: 0, no_eps_in_run: 0 };
  // 今の名寄せの結果との比べ: 系列で期が決まる枠のうち、今は未同定（ambiguous など）のもの・今と違う期に付いているもの・今と同じもの。
  // 系列で決まらない枠のうち、今は期に付いているもの（割り当てを入れると保留に回る）
  const cmp = { unresolved_to_decided: 0, differs: 0, same: 0, attached_to_hold: 0 };
  const decidedByReason = new Map<string, number>();
  const attachedAnnict = new Map<number, Set<number>>();
  for (const r of rows) attachedAnnict.set(r.ev, new Set([...(attachedAnnict.get(r.ev) ?? []), r.aid]));
  const examples: string[] = [];
  for (const run of withSeasons) {
    const seasons = run.seasons;
    const cum = seasons.reduce<number[]>((acc, s) => [...acc, (acc.at(-1) ?? 0) + (s.episodesCount ?? 0)], []);
    const info = run.evs.map((e) => {
      const ex = extract(e.title_raw, cfg);
      const mk = markersOf(e.title_raw, cfg);
      const eps = ex.episodes.map((x) => x.number);
      const t = Date.parse(e.started_at);
      const aired = seasons.map((s, i) => ({ s, i })).filter(({ s }) => { const st = releaseStart(s); return st === null || st <= t + 31 * 86_400_000; });
      return { e, eps, mk, aired };
    });
    const anyEps = info.some((x) => x.eps.length > 0);
    // 期の表記・放送時期で決まるもの
    const decided: (number | null)[] = info.map((x) => {
      const tags = [...x.mk.season.keys(), ...x.mk.part];
      if (tags.length) {
        const hit = seasons.findIndex((s) => {
          const wm = workMarkers(s.titles.slice(0, 1), cfg);
          return tags.every((t) => (t === "s1" ? ![...wm.season.keys()].some((k) => k !== "s1") : wm.season.has(t) || wm.part.has(t)));
        });
        if (hit >= 0) { counts.marker++; return hit; }
      }
      if (x.aired.length === 1) { counts.date++; return x.aired[0]!.i; }
      return null;
    });
    // 話数で決まるもの（系列の流れ）
    let state: { i: number; last: number } | null = null;
    info.forEach((x, n) => {
      if (decided[n] !== null) {
        const i = decided[n]!;
        state = { i, last: x.eps.length ? Math.max(...x.eps) : state && state.i === i ? state.last : 0 };
        return;
      }
      if (!x.eps.length) return;
      const a = Math.min(...x.eps), b = Math.max(...x.eps);
      let i: number | null = null;
      const st = state as { i: number; last: number } | null;
      if (st) {
        const count = seasons[st.i]!.episodesCount ?? 0;
        if (a === 1 && st.last === count && st.i + 1 < seasons.length) i = st.i + 1;
        else if (a > count) { const k = cum.findIndex((c) => b <= c); if (k >= 0 && (k === 0 || a > cum[k - 1]!)) i = k; }
        else if (a > st.last && b <= count) i = st.i;
      } else if (n === 0 && a === 1) i = 0;
      else if (a > (seasons[0]!.episodesCount ?? 0)) { const k = cum.findIndex((c) => b <= c); if (k >= 0 && (k === 0 || a > cum[k - 1]!)) i = k; }
      if (i !== null) { decided[n] = i; counts.episodes++; state = { i, last: b }; }
    });
    // 話数の無い枠: 前後の決まった枠から
    info.forEach((x, n) => {
      if (decided[n] !== null) return;
      const prev = [...info.keys()].slice(0, n).reverse().find((j) => decided[j] !== null);
      const next = [...info.keys()].slice(n + 1).find((j) => decided[j] !== null);
      if (prev !== undefined && next !== undefined && decided[prev] === decided[next]) {
        const lastPrev = info[prev]!.eps.length ? Math.max(...info[prev]!.eps) : 0;
        const count = seasons[decided[prev]!]!.episodesCount ?? 0;
        if (!(lastPrev === count)) { decided[n] = decided[prev]!; counts.between++; return; }
      }
      if (prev === undefined && next !== undefined && decided[next] === 0 && info[next]!.eps.length && Math.min(...info[next]!.eps) > 1) {
        decided[n] = 0; counts.leading++; return;
      }
      if (anyEps) counts.undecided_with_eps_in_run++;
      else counts.no_eps_in_run++;
    });
    info.forEach((x, n) => {
      const now = attachedAnnict.get(x.e.id);
      const inRun = now ? [...now].filter((aid) => seasons.some((s) => s.annictId === aid)) : [];
      if (decided[n] === null) {
        if (inRun.length) cmp.attached_to_hold++;
        return;
      }
      const want = seasons[decided[n]!]!.annictId;
      if (!now || inRun.length === 0) {
        cmp.unresolved_to_decided++;
        decidedByReason.set(x.e.reason ?? "(別の作品に付いている)", (decidedByReason.get(x.e.reason ?? "(別の作品に付いている)") ?? 0) + 1);
      }
      else if (inRun.includes(want!)) cmp.same++;
      else cmp.differs++;
    });
    if (examples.length < 15 && info.some((_, n) => decided[n] === null)) {
      examples.push(`${run.streamer} / ${seasons.map((s) => `${s.title}(${s.episodesCount}話)`).join(" → ")}\n` +
        info.map((x, n) => `    ${x.e.started_at.slice(0, 10)} ${decided[n] === null ? "保留" : `→${seasons[decided[n]!]!.title.slice(0, 18)}`} | ${x.e.title_raw.slice(0, 60)}`).join("\n"));
    }
  }

  // 案c: 続きの期がある作品に、話数も期の表記もない枠が付いている
  const planC = { literal: 0, aired: 0, events: 0 };
  const attached = db.prepare(`SELECT e.id, e.started_at, e.title_raw, w.annict_id, ew.extracted_text AS x FROM event_works ew JOIN watch_events e ON e.id = ew.watch_event_id
    JOIN works w ON w.id = ew.work_id WHERE ${activeEventSql("e")} AND w.annict_id IS NOT NULL GROUP BY e.id, w.id`).all(cutoff) as { id: number; started_at: string; title_raw: string; annict_id: number; x: string }[];
  const seenC = new Set<number>(), seenA = new Set<number>();
  for (const a of attached) {
    planC.events++;
    const w = (series.get(a.annict_id) ?? []).find((x) => x.annictId === a.annict_id);
    if (!w) continue;
    const seasons = familyOf(a.annict_id, matchKey(a.x, cfg));
    const start = releaseStart(w) ?? 0;
    const later = seasons.filter((s) => s.annictId !== w.annictId && (releaseStart(s) ?? 0) > start);
    if (later.length === 0) continue;
    const ex = extract(a.title_raw, cfg);
    const mk = markersOf(a.title_raw, cfg);
    if (ex.episodes.length || mk.season.size || mk.part.size) continue;
    seenC.add(a.id);
    const t = Date.parse(a.started_at);
    if (later.some((s) => (releaseStart(s) ?? 0) <= t + 31 * 86_400_000)) seenA.add(a.id);
  }
  planC.literal = seenC.size;
  planC.aired = seenA.size;

  const out: string[] = [PROCEDURE, "## 結果\n"];
  const evCount = (rs: { evs: Ev[] }[]) => rs.reduce((n, r) => n + r.evs.length, 0);
  out.push(`- 視聴系列（2枠以上）: ${multiRuns.length} 系列・${evCount(multiRuns)} 枠`);
  out.push(`  - うち、系統に期が2つ以上ある系列: ${withSeasons.length} 系列・${evCount(withSeasons)} 枠`);
  out.push(`- 期が2つ以上ある系列の枠の内訳:`);
  out.push(`  - 期の表記で決まる: ${counts.marker} 枠`);
  out.push(`  - 枠の時点で始まっていた期が1つだけ（放送時期で決まる）: ${counts.date} 枠`);
  out.push(`  - 系列内の話数で決まる: ${counts.episodes} 枠（話数付き）＋ ${counts.between} 枠（前後に挟まれた話数なし）＋ ${counts.leading} 枠（最初の話数付きの枠より前）`);
  out.push(`  - 系列内に話数があるが決まらない: ${counts.undecided_with_eps_in_run} 枠`);
  out.push(`  - 系列内に話数も期の表記もなく保留: ${counts.no_eps_in_run} 枠`);
  out.push(`- 今の名寄せの結果との比べ（期が2つ以上ある系列の枠）: 系列で期が決まり、今と同じ期 ${cmp.same} 枠・今と違う期 ${cmp.differs} 枠・` +
    `今は期に付いていない（未同定など）${cmp.unresolved_to_decided} 枠（${[...decidedByReason].map(([k, v]) => `${k} ${v}`).join("・")}）。系列で決まらず、今は期に付いている（割り当てを入れると保留に回る）${cmp.attached_to_hold} 枠`);
  out.push(`- 案c の影響: 今のアニメ（Annict）の同定 ${planC.events} 組（枠×作品）のうち、続きの期がある作品に話数も期の表記もない枠が付いているもの ${planC.literal} 枠。` +
    `うち、枠の時点で続きの期が始まっていたもの ${planC.aired} 枠`);
  out.push("\n## 保留が出る系列の例（先頭15系列）\n");
  out.push(examples.join("\n"));
  return out.join("\n");
}
