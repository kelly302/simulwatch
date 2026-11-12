import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import type { DB } from "../lib/db.ts";
import { ROOT, DATA_DIR } from "../lib/paths.ts";
import { activeEventSql, farFutureCutoff } from "../lib/events.ts";
import type { ExtractConfig } from "../resolve/config.ts";
import { publishState } from "../resolve/route.ts";
import { streamerFrames, streamerVideos, videoKeys, inTitle } from "../report/neighbors.ts";
import type { Frame, Video } from "../report/neighbors.ts";

// 続きの回の候補の選び方（docs/ai-ops.md 3-1。決定 D-04。API を使わない）。
// 題名に同時視聴の語が無い続きの回（同じ配信者のメン限の続きの回など）を、同時視聴枠にならなかった動画（videos_seen）から選ぶ。
// 選んだ動画は videos.list で詳細を取り（candidates:fetch）、人が起動した AI の判定役が「同時視聴か・どの作品か」を答える。
// 層の中身と語は config/candidates.yaml。作品名の区間は判定役に見せる「同じ作品名の動画」と同じ決まり（neighbors.ts の videoKeys）。
// 表（candidates）への保存と詳細の取得は src/candidates/store.ts。ここは選ぶだけ（--dry-run は件数と一覧だけ）

export type CandidateReason = "same_work_members" | "continuation_word" | "same_title_body";
export const CANDIDATE_REASONS: CandidateReason[] = ["same_work_members", "continuation_word", "same_title_body"];

export interface CandidatesConfig {
  layers: CandidateReason[];
  members_days: number;
  title_body_min_chars: number;
  continuation_words: string[];
}

export function loadCandidatesConfig(): CandidatesConfig {
  return parse(readFileSync(join(ROOT, "config", "candidates.yaml"), "utf8")) as CandidatesConfig;
}

/** 種の枠（一覧に出る同時視聴枠のうち、サイトで出さないもの以外） */
export interface Seed {
  id: number;
  startedAt: string | null;
  title: string;
  membersOnly: boolean;
}

/** 配信者ごとの入力 */
export interface StreamerInput {
  id: number;
  name: string;
  /** 判定から外していない同時視聴枠のすべて（決まり文句の判定に使う。neighbors.ts の streamerFrames） */
  frames: Frame[];
  seeds: Seed[];
  /** 同時視聴枠にならなかった動画（neighbors.ts の streamerVideos） */
  videos: Video[];
}

/** 候補にした理由の1つ（どの種の枠から。same_work_members・continuation_word の作品名の区間は key） */
export interface CandidateHit {
  reason: CandidateReason;
  seed: number;
  key?: string;
}

export interface Candidate {
  videoId: string;
  streamerId: number;
  streamer: string;
  title: string;
  /** 公開日（日本時間） */
  date: string;
  members: boolean;
  reasons: CandidateReason[];
  hits: CandidateHit[];
}

const DAY = 86_400_000;

/** 題名の本体（NFKC・小文字にして【】の中身・感嘆符・空白を除く） */
export function titleBody(t: string): string {
  return t.normalize("NFKC").toLowerCase().replace(/【[^】]*】/g, "").replace(/[!！]/g, "").replace(/\s+/g, "");
}

/** 候補を選ぶ（純粋関数）。並びは公開日時・動画の ID の順 */
export function selectCandidates(streamers: StreamerInput[], cfg: ExtractConfig, ccfg: CandidatesConfig): Candidate[] {
  const on = new Set(ccfg.layers);
  const cont = ccfg.continuation_words.map((p) => new RegExp(p, "i"));
  const isCont = (t: string) => {
    const n = t.normalize("NFKC");
    return cont.some((re) => re.test(n));
  };
  const out: Candidate[] = [];
  for (const s of streamers) {
    if (!s.videos.length || !s.seeds.length) continue;
    // 動画ごとに、作品名の区間で当たった種（s1）・前後のメン限の種（s3）・本体が同じ種を集める
    const s1 = new Map<Video, CandidateHit[]>();
    const s3 = new Map<Video, number[]>();
    const body = new Map<Video, number[]>();
    const push = <T>(m: Map<Video, T[]>, v: Video, x: T) => {
      const a = m.get(v);
      if (a) a.push(x);
      else m.set(v, [x]);
    };
    const members = s.videos.filter((v) => v.members);
    const byBody = new Map<string, Video[]>();
    for (const v of s.videos) {
      const b = titleBody(v.title);
      const a = byBody.get(b);
      if (a) a.push(v);
      else byBody.set(b, [v]);
    }
    for (const seed of s.seeds) {
      const keys = videoKeys(s.videos, s.frames, seed.title, cfg, s.name);
      if (keys.length) {
        for (const v of members) {
          const k = keys.find((k) => inTitle(k, v));
          if (k) push(s1, v, { reason: "same_work_members", seed: seed.id, key: k });
        }
      }
      const t0 = seed.startedAt ? Date.parse(seed.startedAt) : NaN;
      if (seed.membersOnly && !Number.isNaN(t0)) {
        for (const v of members) if (Math.abs(v.at - t0) <= ccfg.members_days * DAY) push(s3, v, seed.id);
      }
      const b = titleBody(seed.title);
      if ([...b].length >= ccfg.title_body_min_chars) for (const v of byBody.get(b) ?? []) push(body, v, seed.id);
    }
    for (const v of s.videos) {
      const hits: CandidateHit[] = [];
      const a = s1.get(v) ?? [];
      if (on.has("same_work_members")) hits.push(...a);
      if (on.has("continuation_word") && v.members && (a.length || s3.has(v)) && isCont(v.title)) {
        if (a.length) hits.push(...a.map((h) => ({ ...h, reason: "continuation_word" as const })));
        else hits.push(...s3.get(v)!.map((seed) => ({ reason: "continuation_word" as const, seed })));
      }
      if (on.has("same_title_body")) hits.push(...(body.get(v) ?? []).map((seed) => ({ reason: "same_title_body" as const, seed })));
      if (!hits.length) continue;
      out.push({
        videoId: v.id, streamerId: s.id, streamer: s.name, title: v.title, date: v.date, members: v.members,
        reasons: CANDIDATE_REASONS.filter((r) => hits.some((h) => h.reason === r)), hits,
      });
    }
  }
  const at = new Map(streamers.flatMap((s) => s.videos.map((v) => [v.id, v.at])));
  return out.sort((a, b) => at.get(a.videoId)! - at.get(b.videoId)! || (a.videoId < b.videoId ? -1 : a.videoId > b.videoId ? 1 : 0));
}

/**
 * DB から配信者ごとの入力を読む（読むだけ）。種の枠は一覧に出る枠（activeEventSql）のうち、publishState が hidden 以外。
 * eventStatus は渡さない（予定・配信中の枠の分岐は pending_ai と frame を分けるだけで、hidden かどうかは変わらない）
 */
export function loadSelectInput(db: DB, cfg: ExtractConfig, maxDaysAhead: number, now: Date = new Date()): StreamerInput[] {
  const ctx = { db };
  const framesOf = streamerFrames(ctx);
  const videosOf = streamerVideos(ctx, cfg);
  const rows = db.prepare(`SELECT e.id, e.streamer_id, e.started_at, e.title_raw, e.is_members_only, er.route, er.route_sub,
      (SELECT a.status FROM ai_decisions a WHERE a.watch_event_id = e.id AND a.revoked_at IS NULL) AS ai_status,
      (SELECT a.confidence FROM ai_decisions a WHERE a.watch_event_id = e.id AND a.revoked_at IS NULL) AS ai_conf,
      EXISTS (SELECT 1 FROM event_works ew WHERE ew.watch_event_id = e.id) AS has_works,
      (SELECT u.reason FROM unresolved u WHERE u.watch_event_id = e.id AND u.resolved_at IS NULL) AS reason
    FROM watch_events e LEFT JOIN event_resolution er ON er.watch_event_id = e.id
    WHERE ${activeEventSql("e")} ORDER BY e.started_at, e.id`).all(farFutureCutoff(maxDaysAhead, now)) as Record<string, string | number | null>[];
  const seeds = new Map<number, Seed[]>();
  for (const r of rows) {
    const state = publishState({
      type: r.route as string | null, sub: r.route_sub as string | null,
      ai: r.ai_status ? { status: String(r.ai_status), confidence: String(r.ai_conf) } : null,
      hasWorks: !!r.has_works, unresolvedReason: r.reason as string | null,
    }, cfg.ai_routes ?? []);
    if (state === "hidden") continue;
    const sid = Number(r.streamer_id);
    const a = seeds.get(sid) ?? [];
    a.push({ id: Number(r.id), startedAt: r.started_at as string | null, title: String(r.title_raw), membersOnly: !!r.is_members_only });
    seeds.set(sid, a);
  }
  const streamers = db.prepare("SELECT id, name FROM streamers ORDER BY id").all() as { id: number; name: string }[];
  return streamers.map((s) => ({ id: s.id, name: s.name, frames: framesOf(s.id), seeds: seeds.get(s.id) ?? [], videos: videosOf(s.id) }));
}

/**
 * candidates:select --dry-run。DB を読むだけで候補を選び、件数のまとめを返して、一覧を data/review/candidates-select.{json,md} に書く
 * （メン限の題名を含むのでコミットしない）
 */
export function candidatesDryRun(db: DB, cfg: ExtractConfig, maxDaysAhead: number, now: Date = new Date()): string {
  const list = selectCandidates(loadSelectInput(db, cfg, maxDaysAhead, now), cfg, loadCandidatesConfig());
  const lastCrawl = (db.prepare("SELECT max(last_seen_at) AS m FROM videos_seen").get() as { m: string | null }).m;
  const dir = join(DATA_DIR, "review");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "candidates-select.json"), JSON.stringify(list, null, 1), "utf8");
  const md = ["# 続きの回の候補（candidates:select --dry-run）", "", `- 最後の巡回 ${lastCrawl}・選んだ時刻 ${now.toISOString()}`, ...summarize(list).map((l) => `- ${l}`), "",
    "| 動画 | 配信者 | 公開日 | メン限 | 層 | 題名 | 種の枠（区間） |", "|---|---|---|---|---|---|---|",
    ...list.map((c) => `| ${c.videoId} | ${c.streamer} | ${c.date} | ${c.members ? "○" : ""} | ${c.reasons.join("+")} | ${c.title.replaceAll("|", "｜")} | ${
      [...new Set(c.hits.map((h) => `${h.seed}${h.key ? `（${h.key}）` : ""}`))].slice(0, 3).join("・")} |`)];
  writeFileSync(join(dir, "candidates-select.md"), md.join("\n"), "utf8");
  const mh = cfg.ai_context?.other_videos?.members_heading;
  return [
    `最後の巡回 ${lastCrawl}。メン限の見出し: ${mh ? `メン限の動画の ${mh.ratio} 超・${mh.min}本以上` : "見ない"}`,
    ...summarize(list),
    `videos.list の見積もり ${Math.ceil(list.length / 50)} ユニット（50本で1）`,
    `一覧 → ${join(dir, "candidates-select.{json,md}")}`,
  ].join("\n");
}

/** 件数のまとめ（層ごと・重なり・配信者の上位） */
export function summarize(list: Candidate[]): string[] {
  const top = (xs: Candidate[], n: number) => Object.entries(xs.reduce((m: Record<string, number>, c) => {
    m[c.streamer] = (m[c.streamer] ?? 0) + 1;
    return m;
  }, {})).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${k} ${v}`).join("・");
  const lines = [`候補 ${list.length}本（メン限 ${list.filter((c) => c.members).length}・配信者 ${new Set(list.map((c) => c.streamerId)).size}）`];
  for (const r of CANDIDATE_REASONS) {
    const xs = list.filter((c) => c.reasons.includes(r));
    lines.push(`  ${r}\t${xs.length}（この層だけ ${xs.filter((c) => c.reasons.length === 1).length}）\t${top(xs, 5)}`);
  }
  const combos = Object.entries(list.reduce((m: Record<string, number>, c) => {
    const k = c.reasons.join("+");
    m[k] = (m[k] ?? 0) + 1;
    return m;
  }, {})).sort((a, b) => b[1] - a[1]);
  lines.push(`  重なり: ${combos.map(([k, v]) => `${k} ${v}`).join("・")}`);
  lines.push(`  上位の配信者: ${top(list, 10)}`);
  return lines;
}
