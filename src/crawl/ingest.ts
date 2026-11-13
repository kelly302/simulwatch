import type { Ctx } from "../lib/context.ts";
import type { DetectSource, FoundVia } from "../shared/types.ts";
import { detect, isMembersTitle, templateLines } from "../detect/detect.ts";
import { classifyVideo } from "./classify.ts";
import type { ClassifyOptions } from "./classify.ts";
import { chunk } from "../youtube/api.ts";
import { tx } from "../lib/db.ts";
import { nowIso } from "../lib/time.ts";
import { log } from "../lib/log.ts";

// 候補動画（RSS・playlistItems で見つけたもの）を判定し、
// 同時視聴枠だけ videos.list で詳細を取って WatchEvent に保存する。

export interface Candidate {
  videoId: string;
  channelId: string;
  title: string;
  description: string | null;
  publishedAt: string | null;
  via: FoundVia;
  /** メン限プレイリストで見つかった */
  inMembersPlaylist?: boolean;
}

export interface PendingHit {
  videoId: string;
  via: FoundVia;
  source: DetectSource;
  keyword: string;
  membersHint: boolean;
}

export interface IngestStats {
  candidates: number;
  skipped_known: number;
  detected_hits: number;
  misses: number;
  title_excluded: number;
  known_events_touched: number;
}

export function emptyStats(): IngestStats {
  return { candidates: 0, skipped_known: 0, detected_hits: 0, misses: 0, title_excluded: 0, known_events_touched: 0 };
}

interface SeenRow {
  title: string;
  detect_version: string;
  detect_result: string;
}

/**
 * 候補を判定する。詳細取得が必要な動画を返す。
 * - 既知の WatchEvent: タイトルが変わっていれば再取得の対象にする
 * - 前回と同じタイトル・同じ語彙バージョンで判定済み: 飛ばす
 */
export function judgeCandidates(ctx: Ctx, rawCands: Candidate[], stats: IngestStats): Map<string, PendingHit> {
  const { db, detectCfg } = ctx;
  const pending = new Map<string, PendingHit>();

  // 同じ動画が RSS と playlistItems の両方から来ることがある。先に来た方を残し、メン限の印だけ合わせる
  const byId = new Map<string, Candidate>();
  for (const c of rawCands) {
    const prev = byId.get(c.videoId);
    if (!prev) byId.set(c.videoId, { ...c });
    else if (c.inMembersPlaylist) prev.inMembersPlaylist = true;
  }
  const cands = [...byId.values()];

  // チャンネルごとに概要欄の定型文を集める
  const descByChannel = new Map<string, (string | null)[]>();
  for (const c of cands) descByChannel.set(c.channelId, [...(descByChannel.get(c.channelId) ?? []), c.description]);
  const templates = new Map<string, Set<string>>();
  for (const [ch, ds] of descByChannel) templates.set(ch, templateLines(ds, detectCfg));
  const now = nowIso();
  const getEvent = db.prepare("SELECT id, title_raw, is_members_only FROM watch_events WHERE video_id = ?");
  const getSeen = db.prepare("SELECT title, detect_version, detect_result FROM videos_seen WHERE video_id = ?");
  // 同じ題名を見た = 題名を API で確かめた（refreshed_at。30日の決まりの取り直しはこれの古いものから。src/retention/seen.ts）
  const touchSeen = db.prepare("UPDATE videos_seen SET last_seen_at = ?, refreshed_at = ?, is_members_hint = MAX(is_members_hint, ?) WHERE video_id = ?");
  // 同時視聴の枠の動画は判定し直さないが、題名は今のものにする（題名を消した行も戻す）
  const touchEventSeen = db.prepare("UPDATE videos_seen SET title = ?, last_seen_at = ?, refreshed_at = ?, gone_at = NULL, is_members_hint = MAX(is_members_hint, ?) WHERE video_id = ?");
  const upsertSeen = db.prepare(`
    INSERT INTO videos_seen (video_id, channel_id, title, published_at, first_seen_at, first_seen_via, last_seen_at,
                             detect_result, detect_note, detect_version, is_members_hint, refreshed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(video_id) DO UPDATE SET
      title = excluded.title, published_at = COALESCE(excluded.published_at, published_at),
      last_seen_at = excluded.last_seen_at, detect_result = excluded.detect_result,
      detect_note = excluded.detect_note, detect_version = excluded.detect_version,
      is_members_hint = MAX(is_members_hint, excluded.is_members_hint),
      refreshed_at = excluded.refreshed_at, gone_at = NULL`);
  const setMembers = db.prepare("UPDATE watch_events SET is_members_only = 1, updated_at = ? WHERE id = ?");

  tx(db, () => {
    for (const c of cands) {
      stats.candidates++;
      const membersHint = !!c.inMembersPlaylist || isMembersTitle(c.title, detectCfg);

      const ev = getEvent.get(c.videoId) as { id: number; title_raw: string; is_members_only: number } | undefined;
      if (ev) {
        stats.known_events_touched++;
        if (membersHint && !ev.is_members_only) setMembers.run(now, ev.id);
        touchEventSeen.run(c.title, now, now, membersHint ? 1 : 0, c.videoId);
        if (ev.title_raw !== c.title) {
          // タイトルが変わった既知の枠は詳細を取り直す（判定根拠は前回のものを引き継ぐ）
          pending.set(c.videoId, { videoId: c.videoId, via: c.via, source: "title", keyword: "(known)", membersHint });
        }
        continue;
      }

      const seen = getSeen.get(c.videoId) as SeenRow | undefined;
      // "hit" なのに WatchEvent が無いのは、前回クォータ切れなどで詳細を取れなかったもの。取り直す
      if (seen && seen.title === c.title && seen.detect_version === detectCfg.version && seen.detect_result !== "hit") {
        stats.skipped_known++;
        touchSeen.run(now, now, membersHint ? 1 : 0, c.videoId);
        continue;
      }

      const r = detect({ title: c.title, description: c.description, templateLines: templates.get(c.channelId) }, detectCfg);
      let result: string;
      let note: string | null = null;
      if (r.hit) {
        stats.detected_hits++;
        result = "hit";
        note = `${r.source}:${r.keyword}`;
        pending.set(c.videoId, { videoId: c.videoId, via: c.via, source: r.source, keyword: r.keyword, membersHint });
      } else if (r.excludedBy) {
        stats.title_excluded++;
        result = "rejected";
        note = `title_exclude:${r.excludedBy}`;
      } else {
        stats.misses++;
        result = "miss";
      }
      upsertSeen.run(
        c.videoId, c.channelId, c.title, c.publishedAt, now, c.via, now,
        result, note, detectCfg.version, membersHint ? 1 : 0, now,
      );
    }
  });
  return pending;
}

/**
 * 判定ではヒットしたのに WatchEvent が無い動画（前回クォータ切れ・API エラーで詳細を取れなかったもの）。
 * 遡りで見た動画は二度と候補に上がらないので、日次で拾い直す。
 */
export function orphanHits(ctx: Ctx): Map<string, PendingHit> {
  const rows = ctx.db
    .prepare(`
      SELECT v.video_id, v.first_seen_via, v.detect_note, v.is_members_hint FROM videos_seen v
      LEFT JOIN watch_events e ON e.video_id = v.video_id
      WHERE v.detect_result = 'hit' AND e.id IS NULL`)
    .all() as { video_id: string; first_seen_via: FoundVia; detect_note: string | null; is_members_hint: number }[];
  const out = new Map<string, PendingHit>();
  for (const r of rows) {
    const [source, ...kw] = (r.detect_note ?? "title:").split(":");
    out.set(r.video_id, {
      videoId: r.video_id,
      via: r.first_seen_via,
      source: source === "description" ? "description" : "title",
      keyword: kw.join(":"),
      membersHint: r.is_members_hint === 1,
    });
  }
  return out;
}

export interface UpsertStats {
  api_videos_requested: number;
  events_inserted: number;
  events_updated: number;
  rejected_not_live: number;
  rejected_unavailable: number;
  /** 詳細を取った時点の判定で当たらなくなった（語彙・ルールが変わった） */
  rejected_by_current_rule: number;
  missing: number;
  unknown_channel: number;
}

export function emptyUpsertStats(): UpsertStats {
  return { api_videos_requested: 0, events_inserted: 0, events_updated: 0, rejected_not_live: 0, rejected_unavailable: 0, rejected_by_current_rule: 0, missing: 0, unknown_channel: 0 };
}

/** 判定でヒットした動画の詳細を取り、WatchEvent を作る・更新する */
export async function fetchAndUpsert(ctx: Ctx, pending: Map<string, PendingHit>, stats: UpsertStats): Promise<void> {
  if (!ctx.yt || pending.size === 0) {
    if (!ctx.yt && pending.size > 0) log.warn(`APIキーが無いため ${pending.size} 件の詳細取得を保留します（次回の巡回で再判定）`);
    return;
  }
  const { db } = ctx;
  const streamerByChannel = new Map(
    (db.prepare("SELECT id, channel_id FROM streamers").all() as { id: number; channel_id: string }[]).map((r) => [r.channel_id, r.id]),
  );
  const markSeen = db.prepare("UPDATE videos_seen SET detect_result = ?, detect_note = ? WHERE video_id = ?");
  const getEvent = db.prepare("SELECT detect_source FROM watch_events WHERE video_id = ?");

  for (const ids of chunk([...pending.keys()], 50)) {
    stats.api_videos_requested += ids.length;
    const items = await ctx.yt.videos(ids);
    const now = nowIso();
    const returned = new Set(items.map((v) => v.id));
    tx(db, () => {
      for (const v of items) {
        const p = pending.get(v.id)!;
        const c = classifyVideo(v, classifyOptions(ctx));
        if (c.kind === "not_live") {
          stats.rejected_not_live++;
          markSeen.run("rejected", `not_live (${p.source}:${p.keyword})`, v.id);
          continue;
        }
        if (c.kind === "unavailable") {
          stats.rejected_unavailable++;
          markSeen.run("rejected", `unavailable:${c.reason}`, v.id);
          continue;
        }
        if (c.kind !== "event") continue;
        // 新しく作る枠は、取得したタイトル・概要欄を今の語彙で判定し直す。
        // 以前の語彙でヒットして保留されていた動画（orphan）が古いルールのまま入らないようにする。
        // 定型文の除外はここでは使えないが、除外を減らす方向にしか働かないので誤って落とすことはない
        // すでに行のある枠（AI が候補から足した枠 detect_source = 'ai_candidate' を含む）は判定し直さない。
        // ai_candidate の枠は題名に同時視聴の語が無いので、判定し直すと必ず外れる（docs/ai-ops.md 3-4）
        const known = p.keyword === "(known)" || getEvent.get(v.id) !== undefined;
        if (!known) {
          const again = detect({ title: c.title, description: c.description }, ctx.detectCfg);
          if (!again.hit) {
            stats.rejected_by_current_rule++;
            markSeen.run("miss", `rule_changed (was ${p.source}:${p.keyword})`, v.id);
            continue;
          }
          p.source = again.source;
          p.keyword = again.keyword;
        }
        const streamerId = streamerByChannel.get(c.channel_id);
        if (!streamerId) {
          stats.unknown_channel++;
          continue;
        }
        const inserted = upsertEvent(ctx, v.id, streamerId, c, p, now);
        if (inserted) stats.events_inserted++;
        else stats.events_updated++;
      }
      for (const id of ids) {
        if (!returned.has(id)) {
          stats.missing++;
          // 取得できなかった（削除・非公開）。既知の枠でなければ判定結果に残すだけ
          markSeen.run("rejected", "missing_in_videos_list", id);
        }
      }
    });
  }
}

type EventFields = Extract<ReturnType<typeof classifyVideo>, { kind: "event" }>;

export function classifyOptions(ctx: Ctx): ClassifyOptions {
  return { allowNonLive: !ctx.detectCfg.reject.require_live };
}

/**
 * WatchEvent の挿入・更新。更新時は取得できた値だけを上書きし、欠損で既存値を消さない。
 * アーカイブが消えて中身を消した枠（purged_at。src/retention/purge.ts）が見られるようになったら、ここで中身を入れ直して印を消す
 */
export function upsertEvent(ctx: Ctx, videoId: string, streamerId: number, c: EventFields, p: PendingHit | null, now: string): boolean {
  const { db } = ctx;
  const existing = db.prepare("SELECT id FROM watch_events WHERE video_id = ?").get(videoId) as { id: number } | undefined;
  const members = (p?.membersHint || isMembersTitle(c.title, ctx.detectCfg)) ? 1 : 0;
  if (!existing) {
    if (!p) return false;
    db.prepare(`
      INSERT INTO watch_events (streamer_id, video_id, title_raw, description_raw, thumbnail_url, url,
        started_at, started_at_source, scheduled_start_at, ended_at, status, is_members_only, view_count, view_count_fetched_at,
        detected_at, detect_source, detect_keyword, found_via, archive_gone_at, last_checked_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`).run(
      streamerId, videoId, c.title, c.description, c.thumbnail_url, `https://www.youtube.com/watch?v=${videoId}`,
      c.started_at, c.started_at_source, c.scheduled_start_at, c.ended_at, c.status, members,
      c.view_count, c.view_count === null ? null : now,
      now, p.source, p.keyword, p.via, now, now,
    );
    db.prepare("UPDATE videos_seen SET detect_result = 'hit', detect_note = ? WHERE video_id = ?").run(`${p.source}:${p.keyword}`, videoId);
    return true;
  }
  db.prepare(`
    UPDATE watch_events SET
      title_raw = ?, description_raw = ?,
      thumbnail_url = COALESCE(?, thumbnail_url),
      started_at = COALESCE(?, started_at),
      started_at_source = CASE WHEN ? IS NULL THEN started_at_source ELSE ? END,
      scheduled_start_at = COALESCE(?, scheduled_start_at),
      ended_at = COALESCE(?, ended_at),
      status = ?,
      is_members_only = MAX(is_members_only, ?),
      view_count = COALESCE(?, view_count),
      view_count_fetched_at = CASE WHEN ? IS NULL THEN view_count_fetched_at ELSE ? END,
      archive_gone_at = NULL, purged_at = NULL,
      last_checked_at = ?, updated_at = ?
    WHERE id = ?`).run(
    c.title, c.description, c.thumbnail_url, c.started_at, c.started_at, c.started_at_source,
    c.scheduled_start_at, c.ended_at, c.status, members,
    c.view_count, c.view_count, now, now, now, existing.id,
  );
  return false;
}
