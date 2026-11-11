import type { Ctx } from "../lib/context.ts";
import type { Candidate } from "./ingest.ts";
import type { FoundVia } from "../shared/types.ts";
import type { PlaylistItem } from "../youtube/api.ts";
import { parseRss } from "../youtube/rss.ts";
import { uploadsPlaylistId, membersPlaylistId } from "../youtube/api.ts";
import { QuotaExhausted } from "../lib/quota.ts";
import { errorMessage, log } from "../lib/log.ts";
import { nowIso, hoursAgo } from "../lib/time.ts";

// 候補動画の取得元（RSS と playlistItems）。
// チャンネル単位で失敗しても他のチャンネルは続ける。クォータ切れのときだけ打ち切る。

export interface ActiveChannel {
  channel_id: string;
  name: string;
}

export function activeChannels(ctx: Ctx): ActiveChannel[] {
  return ctx.db.prepare("SELECT channel_id, name FROM streamers WHERE is_active = 1 ORDER BY id").all() as unknown as ActiveChannel[];
}

function ensureState(ctx: Ctx, channelId: string): void {
  ctx.db.prepare("INSERT OR IGNORE INTO crawl_state (channel_id) VALUES (?)").run(channelId);
}

export interface SourceStats {
  channels: number;
  ok: number;
  failed: number;
  items: number;
  failures: { channel_id: string; error: string }[];
}

function emptySource(): SourceStats {
  return { channels: 0, ok: 0, failed: 0, items: 0, failures: [] };
}

/** 全アクティブチャンネルの RSS。クォータ0 */
export async function collectRss(ctx: Ctx, out: Candidate[]): Promise<SourceStats> {
  const s = emptySource();
  const upd = ctx.db.prepare("UPDATE crawl_state SET rss_checked_at = ?, rss_error = ? WHERE channel_id = ?");
  for (const ch of activeChannels(ctx)) {
    s.channels++;
    ensureState(ctx, ch.channel_id);
    try {
      const url = ctx.crawlCfg.rss.url.replace("{channel_id}", ch.channel_id);
      const res = await ctx.http.get(url);
      const entries = parseRss(res.body);
      for (const e of entries) {
        out.push({
          videoId: e.videoId,
          channelId: e.channelId || ch.channel_id,
          title: e.title,
          description: e.description,
          publishedAt: e.publishedAt,
          via: "rss",
        });
      }
      s.items += entries.length;
      s.ok++;
      upd.run(nowIso(), null, ch.channel_id);
    } catch (e) {
      s.failed++;
      s.failures.push({ channel_id: ch.channel_id, error: errorMessage(e) });
      upd.run(nowIso(), errorMessage(e), ch.channel_id);
    }
  }
  return s;
}

function toCandidate(it: PlaylistItem, channelId: string, via: FoundVia, members: boolean): Candidate {
  return {
    videoId: it.contentDetails?.videoId ?? it.snippet.resourceId.videoId,
    channelId: it.snippet.videoOwnerChannelId ?? it.snippet.channelId ?? channelId,
    title: it.snippet.title,
    description: it.snippet.description ?? null,
    publishedAt: it.contentDetails?.videoPublishedAt ?? it.snippet.publishedAt ?? null,
    via,
    inMembersPlaylist: members,
  };
}

/** 削除済み・非公開の動画はプレイリストに "Deleted video" / "Private video" として残るので除く */
function isPlaceholder(it: PlaylistItem): boolean {
  const t = it.snippet.title;
  return t === "Deleted video" || t === "Private video";
}

/**
 * uploads プレイリストの先頭ページ。
 * mode=rotate: こまめな巡回（crawl:hourly。今は流さない）。最後に見てから interval 時間以上たったチャンネルを、1時間あたり 1/interval ずつ見る
 * mode=all:    日次。全チャンネル
 */
export async function collectPlaylistHeads(
  ctx: Ctx,
  out: Candidate[],
  mode: "rotate" | "all",
): Promise<SourceStats> {
  const s = emptySource();
  const yt = ctx.yt;
  if (!yt) return s;
  const { db } = ctx;
  const channels = activeChannels(ctx);
  for (const ch of channels) ensureState(ctx, ch.channel_id);

  let targets: ActiveChannel[] = channels;
  let pageSize = ctx.crawlCfg.daily.playlist_page_size;
  if (mode === "rotate") {
    const interval = ctx.crawlCfg.hourly.playlist_scan_interval_hours;
    pageSize = ctx.crawlCfg.hourly.playlist_scan_page_size;
    const state = new Map(
      (db.prepare("SELECT channel_id, playlist_scanned_at FROM crawl_state").all() as { channel_id: string; playlist_scanned_at: string | null }[])
        .map((r) => [r.channel_id, r.playlist_scanned_at]),
    );
    // 1回に見るチャンネルの数は、こまめな巡回を何時間ごとに回すか（run_interval_hours）で決める（2時間ごとなら 1/6 ずつ）
    const every = ctx.crawlCfg.hourly.run_interval_hours ?? 1;
    const perRun = Math.ceil((channels.length * every) / Math.max(1, interval));
    targets = channels
      .filter((c) => hoursAgo(state.get(c.channel_id) ?? null) >= interval - 0.25)
      .sort((a, b) => (state.get(a.channel_id) ?? "").localeCompare(state.get(b.channel_id) ?? ""))
      .slice(0, perRun);
  }

  const upd = db.prepare("UPDATE crawl_state SET playlist_scanned_at = ?, playlist_error = ? WHERE channel_id = ?");
  const initBackfill = db.prepare(
    "UPDATE crawl_state SET backfill_page_token = ? WHERE channel_id = ? AND backfill_page_token IS NULL AND backfill_done = 0",
  );
  const markDoneIfShort = db.prepare("UPDATE crawl_state SET backfill_done = 1 WHERE channel_id = ? AND backfill_page_token IS NULL");
  for (const ch of targets) {
    s.channels++;
    try {
      const page = await yt.playlistPage(uploadsPlaylistId(ch.channel_id), null, pageSize);
      if (!page.ok) throw new Error(`uploads playlist ${page.reason}`);
      const items = page.items.filter((it) => !isPlaceholder(it));
      for (const it of items) out.push(toCandidate(it, ch.channel_id, "playlist", false));
      s.items += items.length;
      s.ok++;
      upd.run(nowIso(), null, ch.channel_id);
      if (mode === "all") {
        // 過去分の遡りは2ページ目から始める
        if (page.nextPageToken) initBackfill.run(page.nextPageToken, ch.channel_id);
        else markDoneIfShort.run(ch.channel_id);
      }
    } catch (e) {
      if (e instanceof QuotaExhausted) throw e;
      s.failed++;
      s.failures.push({ channel_id: ch.channel_id, error: errorMessage(e) });
      upd.run(nowIso(), errorMessage(e), ch.channel_id);
    }
  }
  return s;
}

/**
 * メン限動画のプレイリスト（UUMO...）の先頭ページ。
 * プレイリストが無い（メンバーシップ未開設・API非対応）チャンネルは記録し、7日間は見に行かない。
 */
export async function collectMembersPlaylists(ctx: Ctx, out: Candidate[]): Promise<SourceStats & { not_found: number; forbidden: number }> {
  const s = { ...emptySource(), not_found: 0, forbidden: 0 };
  const yt = ctx.yt;
  if (!yt || !ctx.crawlCfg.daily.members_playlist) return s;
  const { db } = ctx;
  const getState = db.prepare("SELECT members_playlist_status FROM crawl_state WHERE channel_id = ?");
  const setState = db.prepare("UPDATE crawl_state SET members_playlist_status = ? WHERE channel_id = ?");
  const initBackfill = db.prepare(
    "UPDATE crawl_state SET members_backfill_page_token = ? WHERE channel_id = ? AND members_backfill_page_token IS NULL AND members_backfill_done = 0",
  );
  const markDone = db.prepare("UPDATE crawl_state SET members_backfill_done = 1 WHERE channel_id = ? AND members_backfill_page_token IS NULL");
  for (const ch of activeChannels(ctx)) {
    ensureState(ctx, ch.channel_id);
    const st = (getState.get(ch.channel_id) as { members_playlist_status: string | null } | undefined)?.members_playlist_status;
    if (st && !st.startsWith("ok") && hoursAgo(st.split("@")[1] ?? null) < 24 * 7) continue;
    s.channels++;
    try {
      const page = await yt.playlistPage(membersPlaylistId(ch.channel_id), null, ctx.crawlCfg.daily.playlist_page_size);
      if (!page.ok) {
        if (page.reason === "not_found") s.not_found++;
        else s.forbidden++;
        setState.run(`${page.reason}@${nowIso()}`, ch.channel_id);
        continue;
      }
      const items = page.items.filter((it) => !isPlaceholder(it));
      for (const it of items) out.push(toCandidate(it, ch.channel_id, "members_playlist", true));
      s.items += items.length;
      s.ok++;
      setState.run(`ok@${nowIso()}`, ch.channel_id);
      // 過去分の遡りは2ページ目から
      if (page.nextPageToken) initBackfill.run(page.nextPageToken, ch.channel_id);
      else markDone.run(ch.channel_id);
    } catch (e) {
      if (e instanceof QuotaExhausted) throw e;
      s.failed++;
      s.failures.push({ channel_id: ch.channel_id, error: errorMessage(e) });
    }
  }
  return s;
}

/**
 * 過去分の遡り。uploads の2ページ目以降を、クォータの予算内で古い方へ進める。
 * チャンネルごとに続きのページトークンを持ち、次回はそこから再開する。
 */
export type BackfillKind = "members" | "uploads";

export interface BackfillStats {
  pages: number;
  items: number;
  channels_done: number;
  channels_remaining: number;
  stopped: string | null;
}

/**
 * 過去分の遡り。メン限プレイリスト → uploads の順に、予算を共有して進める。
 * 同時視聴枠はメン限が大半で、メン限プレイリストは本数が少なく安く遡れるため先に回す。
 */
export async function collectBackfill(
  ctx: Ctx,
  onPage: (cands: Candidate[]) => void,
): Promise<Record<BackfillKind, BackfillStats>> {
  const budgetStart = ctx.quota.runUsed;
  const members = await collectBackfillKind(ctx, "members", budgetStart, onPage);
  const uploads = await collectBackfillKind(ctx, "uploads", budgetStart, onPage);
  return { members, uploads };
}

const BACKFILL_COLS: Record<BackfillKind, { token: string; done: string }> = {
  members: { token: "members_backfill_page_token", done: "members_backfill_done" },
  uploads: { token: "backfill_page_token", done: "backfill_done" },
};

async function collectBackfillKind(
  ctx: Ctx,
  kind: BackfillKind,
  budgetStart: number,
  onPage: (cands: Candidate[]) => void,
): Promise<BackfillStats> {
  const r: BackfillStats = { pages: 0, items: 0, channels_done: 0, channels_remaining: 0, stopped: null };
  const yt = ctx.yt;
  const cfg = ctx.crawlCfg.backfill;
  if (!yt || !cfg.enabled) return r;
  const { db } = ctx;
  const col = BACKFILL_COLS[kind];
  const since = cfg.since ? Date.parse(cfg.since) : null;
  const rows = db
    .prepare(`
      SELECT cs.channel_id, cs.${col.token} AS token FROM crawl_state cs
      JOIN streamers s ON s.channel_id = cs.channel_id
      WHERE s.is_active = 1 AND cs.${col.done} = 0 AND cs.${col.token} IS NOT NULL
      ORDER BY s.id`)
    .all() as { channel_id: string; token: string }[];
  const saveUploads = db.prepare("UPDATE crawl_state SET backfill_page_token = ?, backfill_done = ?, backfill_oldest_at = ? WHERE channel_id = ?");
  const saveMembers = db.prepare("UPDATE crawl_state SET members_backfill_page_token = ?, members_backfill_done = ? WHERE channel_id = ?");
  const save = (token: string | null, done: boolean, oldest: string | null, channelId: string) => {
    if (kind === "uploads") saveUploads.run(token, done ? 1 : 0, oldest, channelId);
    else saveMembers.run(token, done ? 1 : 0, channelId);
  };
  const playlistOf = kind === "uploads" ? uploadsPlaylistId : membersPlaylistId;

  outer: for (const row of rows) {
    let token: string | null = row.token;
    while (token) {
      if (ctx.quota.runUsed - budgetStart >= cfg.max_units_per_run) {
        r.stopped = "budget";
        break outer;
      }
      let page;
      try {
        page = await yt.playlistPage(playlistOf(row.channel_id), token, 50);
      } catch (e) {
        if (e instanceof QuotaExhausted) {
          r.stopped = "quota";
          break outer;
        }
        log.warn(`backfill failed ${row.channel_id}: ${errorMessage(e)}`);
        continue outer;
      }
      if (!page.ok) {
        log.warn(`backfill playlist ${page.reason} ${row.channel_id}`);
        continue outer;
      }
      r.pages++;
      const items = page.items.filter((it) => !isPlaceholder(it));
      const cands = items.map((it) => toCandidate(it, row.channel_id, "backfill", kind === "members"));
      r.items += cands.length;
      onPage(cands);
      const oldest = cands.map((c) => c.publishedAt).filter((x): x is string => !!x).sort()[0] ?? null;
      token = page.nextPageToken;
      const reachedSince = since !== null && oldest !== null && Date.parse(oldest) < since;
      const done = !token || reachedSince;
      save(done ? null : token, done, oldest, row.channel_id);
      if (done) {
        r.channels_done++;
        break;
      }
    }
  }
  r.channels_remaining = (db
    .prepare(`SELECT COUNT(*) AS n FROM crawl_state cs JOIN streamers s ON s.channel_id = cs.channel_id
      WHERE s.is_active = 1 AND cs.${col.done} = 0 AND cs.${col.token} IS NOT NULL`)
    .get() as { n: number }).n;
  return r;
}
