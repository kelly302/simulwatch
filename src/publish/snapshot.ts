import { createHash } from "node:crypto";
import type { DB } from "../lib/db.ts";
import { activeEventSql, farFutureCutoff } from "../lib/events.ts";
import { publishState } from "../resolve/route.ts";
import type { Affiliation, Branch, EventStatus, WorkKind, WorkMedia } from "../shared/types.ts";
import type { Season, SiteData, SiteEvent, SiteFrame, SiteStreamer, SiteWork } from "../shared/site.ts";
import { SEASONS, episodeLabel, streamerPath, workPath } from "../shared/site.ts";
import { assignPublicKeys } from "./keys.ts";

// サイト用のデータ（SiteData）を DB から書き出す（Phase 3）。Astro のビルドはこのデータだけを読む。
//
//   - 出す枠は publishState（src/resolve/route.ts）が work・frame の枠。予定枠は予定時刻から upcoming_stale_hours を過ぎたら出さない（決定 A）
//   - 集計値（views_max など）は書き出しのたびに作り直す（終わった枠だけ。再生数は公開枠だけ）
//   - 作品の公開キーを付け直し（keys.ts）、ページの中身の指紋から中身が変わった日（lastmod）を決める。この2つは DB に書く
//     （トランザクションは呼ぶ側で張る。export.ts）

export interface SnapshotOptions {
  now: Date;
  aiRoutes: string[];
  maxDaysAhead: number;
  upcomingStaleHours: number;
}

interface EventRow {
  id: number;
  video_id: string;
  streamer_id: number;
  title_raw: string;
  started_at: string | null;
  scheduled_start_at: string | null;
  status: EventStatus;
  is_members_only: number;
  view_count: number | null;
  thumbnail_url: string | null;
  route: string | null;
  route_sub: string | null;
  ai_status: string | null;
  ai_conf: string | null;
  ai_extra: string | null;
  reason: string | null;
  extracted_text: string | null;
  has_works: number;
}

interface WorkRow {
  id: number;
  annict_id: number | null;
  anilist_id: number | null;
  wikidata_id: string | null;
  title: string;
  title_kana: string | null;
  media: string | null;
  season_name: string | null;
  series_id: string | null;
  series_title: string | null;
  episodes_count: number | null;
  image_url: string | null;
  release_year: number | null;
  kind: string | null;
  countries: string | null;
}

interface StreamerRow {
  id: number;
  channel_id: string;
  name: string;
  name_en: string | null;
  affiliation: string;
  branch: string | null;
  icon_url: string | null;
  is_active: number;
}

interface AiExtra {
  title?: string;
  kind?: WorkKind;
  movie?: boolean;
  missing?: string[];
}

function parseJson<T>(s: string | null): T | null {
  if (!s) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

/** 放送期（「2022-autumn」）。Wikidata の年だけの値は null */
export function seasonOf(seasonName: string | null): Season | null {
  const m = /^\d{4}-(\w+)$/.exec(seasonName ?? "");
  return m && (SEASONS as readonly string[]).includes(m[1]!) ? (m[1] as Season) : null;
}

export function yearOf(w: { release_year: number | null; season_name: string | null }): number | null {
  if (w.release_year != null) return w.release_year;
  const m = /^(\d{4})/.exec(w.season_name ?? "");
  return m ? Number(m[1]) : null;
}

/** 作品を付けずに出す枠の見せ方 */
export function frameOf(r: Pick<EventRow, "title_raw" | "ai_status" | "ai_conf" | "reason" | "extracted_text">, extra: AiExtra | null): SiteFrame {
  const plain: SiteFrame = { named: false, title: r.title_raw, kind: null, movie: null };
  if (r.ai_status === "identified") return plain; // 確度 low の同定。作品は出さない
  if (r.reason === "not_in_db") {
    const title = extra?.title ?? (r.extracted_text && r.extracted_text !== "(AI の判定)" ? r.extracted_text : null);
    return title ? { named: true, title, kind: extra?.kind ?? null, movie: extra?.movie ?? null } : plain;
  }
  if (r.reason === "unidentifiable" && extra?.title) return { named: true, title: extra.title, kind: extra.kind ?? null, movie: extra.movie ?? null };
  return plain;
}

export function buildSiteData(db: DB, opts: SnapshotOptions): SiteData {
  const nowIso = opts.now.toISOString();
  const staleBefore = new Date(opts.now.getTime() - opts.upcomingStaleHours * 3_600_000).toISOString();
  const cutoff = farFutureCutoff(opts.maxDaysAhead, opts.now);

  const rows = db.prepare(`SELECT e.id, e.video_id, e.streamer_id, e.title_raw, e.started_at, e.scheduled_start_at, e.status, e.is_members_only,
      e.view_count, e.thumbnail_url, er.route, er.route_sub,
      a.status AS ai_status, a.confidence AS ai_conf, a.extra AS ai_extra,
      u.reason, u.extracted_text,
      EXISTS (SELECT 1 FROM event_works ew WHERE ew.watch_event_id = e.id) AS has_works
    FROM watch_events e
    LEFT JOIN event_resolution er ON er.watch_event_id = e.id
    LEFT JOIN ai_decisions a ON a.watch_event_id = e.id AND a.revoked_at IS NULL
    LEFT JOIN unresolved u ON u.watch_event_id = e.id AND u.resolved_at IS NULL
    WHERE ${activeEventSql("e")}
    ORDER BY e.started_at DESC, e.id DESC`).all(cutoff) as unknown as EventRow[];

  const epRows = db.prepare(`SELECT ew.watch_event_id AS ev, ew.work_id AS work, ep.number, ep.number_text
    FROM event_works ew LEFT JOIN episodes ep ON ep.id = ew.episode_id`).all() as unknown as { ev: number; work: number; number: number | null; number_text: string | null }[];
  const worksOfEvent = new Map<number, Map<number, { number: number | null; text: string }[]>>();
  for (const r of epRows) {
    const m = worksOfEvent.get(r.ev) ?? new Map<number, { number: number | null; text: string }[]>();
    const eps = m.get(r.work) ?? [];
    if (r.number_text) eps.push({ number: r.number, text: r.number_text });
    m.set(r.work, eps);
    worksOfEvent.set(r.ev, m);
  }

  // 出す枠
  const events: SiteEvent[] = [];
  for (const r of rows) {
    if (!r.started_at) continue;
    const state = publishState({
      type: r.route, sub: r.route_sub,
      ai: r.ai_status ? { status: r.ai_status, confidence: r.ai_conf ?? "" } : null,
      hasWorks: !!r.has_works, unresolvedReason: r.reason, eventStatus: r.status,
    }, opts.aiRoutes);
    if (state !== "work" && state !== "frame") continue;
    if (r.status === "upcoming" && (r.scheduled_start_at ?? r.started_at) < staleBefore) continue;
    const extra = parseJson<AiExtra>(r.ai_extra);
    const ws = state === "work" ? [...(worksOfEvent.get(r.id) ?? new Map()).entries()] : [];
    if (state === "work" && ws.length === 0) continue;
    const members = !!r.is_members_only;
    events.push({
      id: r.id,
      videoId: r.video_id,
      streamerId: r.streamer_id,
      startedAt: r.started_at,
      status: r.status,
      membersOnly: members,
      views: r.status === "completed" && !members ? r.view_count : null,
      thumbnailUrl: r.thumbnail_url,
      works: ws.map(([id, eps]) => ({ id, episodes: episodeLabel(eps) })).sort((a, b) => a.id - b.id),
      missing: state === "work" ? (extra?.missing ?? []) : [],
      frame: state === "frame" ? frameOf(r, extra) : null,
    });
  }

  // 集計（終わった枠だけ）
  const completed = events.filter((e) => e.status === "completed");
  const workAgg = new Map<number, { streamers: Set<number>; events: number; members: number; vmax: number | null; vtotal: number | null; first: string; latest: string }>();
  const streamerAgg = new Map<number, { works: Set<number>; events: number; members: number; first: string; latest: string }>();
  for (const e of completed) {
    const s = streamerAgg.get(e.streamerId) ?? { works: new Set<number>(), events: 0, members: 0, first: e.startedAt, latest: e.startedAt };
    s.events++;
    if (e.membersOnly) s.members++;
    if (e.startedAt < s.first) s.first = e.startedAt;
    if (e.startedAt > s.latest) s.latest = e.startedAt;
    for (const w of e.works) {
      s.works.add(w.id);
      const a = workAgg.get(w.id) ?? { streamers: new Set<number>(), events: 0, members: 0, vmax: null, vtotal: null, first: e.startedAt, latest: e.startedAt };
      a.streamers.add(e.streamerId);
      a.events++;
      if (e.membersOnly) a.members++;
      if (e.views != null) {
        a.vmax = Math.max(a.vmax ?? 0, e.views);
        a.vtotal = (a.vtotal ?? 0) + e.views;
      }
      if (e.startedAt < a.first) a.first = e.startedAt;
      if (e.startedAt > a.latest) a.latest = e.startedAt;
      workAgg.set(w.id, a);
    }
    streamerAgg.set(e.streamerId, s);
  }

  // 作品（出す枠に付いた作品だけ）
  const usedWorkIds = new Set(events.flatMap((e) => e.works.map((w) => w.id)));
  const workRows = (db.prepare(`SELECT id, annict_id, anilist_id, wikidata_id, title, title_kana, media, season_name, series_id, series_title,
      episodes_count, image_url, release_year, kind, countries FROM works`).all() as unknown as WorkRow[]).filter((w) => usedWorkIds.has(w.id));
  const { keys, redirects } = assignPublicKeys(db, workRows.filter((w) => workAgg.has(w.id)).map((w) => ({
    id: w.id, annictId: w.annict_id, anilistId: w.anilist_id, wikidataId: w.wikidata_id,
  })), nowIso);
  db.prepare("UPDATE works SET public_key = NULL WHERE public_key IS NOT NULL").run();
  const setKey = db.prepare("UPDATE works SET public_key = ? WHERE id = ?");
  for (const [id, k] of keys) setKey.run(k, id);

  const works: SiteWork[] = workRows.map((w) => {
    const a = workAgg.get(w.id);
    const key = keys.get(w.id) ?? null;
    return {
      id: w.id,
      key,
      title: w.title,
      titleKana: w.title_kana,
      kind: (w.kind as WorkKind | null) ?? null,
      media: (w.media as WorkMedia | null) ?? null,
      year: yearOf(w),
      season: seasonOf(w.season_name),
      countries: parseJson<string[]>(w.countries),
      seriesId: w.series_id,
      seriesTitle: w.series_title,
      episodesCount: w.episodes_count,
      imageUrl: w.image_url,
      annictId: w.annict_id,
      anilistId: w.anilist_id,
      wikidataId: w.wikidata_id,
      hasPage: !!a && key != null,
      streamersCount: a?.streamers.size ?? 0,
      eventsCount: a?.events ?? 0,
      membersCount: a?.members ?? 0,
      viewsMax: a?.vmax ?? null,
      viewsTotal: a?.vtotal ?? null,
      firstEventAt: a?.first ?? null,
      latestEventAt: a?.latest ?? null,
      lastmod: null,
    };
  });

  // 配信者（出す枠のある配信者だけ）
  const usedStreamers = new Set(events.map((e) => e.streamerId));
  const streamers: SiteStreamer[] = (db.prepare(`SELECT id, channel_id, name, name_en, affiliation, branch, icon_url, is_active FROM streamers`)
    .all() as unknown as StreamerRow[]).filter((s) => usedStreamers.has(s.id)).map((s) => {
    const a = streamerAgg.get(s.id);
    return {
      id: s.id,
      channelId: s.channel_id,
      name: s.name,
      nameEn: s.name_en,
      affiliation: s.affiliation as Affiliation,
      branch: (s.branch as Branch | null) ?? "jp",
      iconUrl: s.icon_url,
      isActive: !!s.is_active,
      hasPage: !!a,
      eventsCount: a?.events ?? 0,
      worksCount: a?.works.size ?? 0,
      membersCount: a?.members ?? 0,
      firstEventAt: a?.first ?? null,
      latestEventAt: a?.latest ?? null,
      lastmod: null,
    };
  });

  const viewsFetchedAt = (db.prepare(`SELECT MAX(view_count_fetched_at) AS t FROM watch_events e WHERE ${activeEventSql("e")}`).get(cutoff) as { t: string | null }).t;
  const data: SiteData = { generatedAt: nowIso, viewsFetchedAt, streamers, works, events, redirects };
  stampLastmod(db, data, nowIso);
  return data;
}

/**
 * ページの中身の指紋（再生数は入れない。毎日変わるので）を前回と比べ、変わった日を lastmod にする。
 * 作品ページは作品の情報と枠（配信者・話数・メン限）、配信者ページは配信者の情報と枠（作品・話数・作品を付けない枠の見せ方）
 */
function stampLastmod(db: DB, data: SiteData, nowIso: string): void {
  const streamerById = new Map(data.streamers.map((s) => [s.id, s]));
  const workById = new Map(data.works.map((w) => [w.id, w]));
  const completed = data.events.filter((e) => e.status === "completed");
  const prints = new Map<string, { target: SiteWork | SiteStreamer; print: unknown }>();

  for (const w of data.works) {
    if (!w.hasPage || !w.key) continue;
    const evs = completed.filter((e) => e.works.some((x) => x.id === w.id)).map((e) => {
      const s = streamerById.get(e.streamerId)!;
      return [e.videoId, s.name, s.nameEn, s.branch, e.membersOnly, e.works.find((x) => x.id === w.id)!.episodes];
    }).sort();
    const series = data.works.filter((x) => x.hasPage && w.seriesId && x.seriesId === w.seriesId && x.seriesTitle).map((x) => [x.key, x.title]).sort();
    const { title, titleKana, kind, media, year, season, countries, seriesTitle, episodesCount, imageUrl, annictId, anilistId, wikidataId } = w;
    prints.set(workPath(w.key), { target: w, print: [title, titleKana, kind, media, year, season, countries, seriesTitle, episodesCount, imageUrl, annictId, anilistId, wikidataId, evs, series] });
  }
  for (const s of data.streamers) {
    if (!s.hasPage) continue;
    const evs = completed.filter((e) => e.streamerId === s.id).map((e) => [
      e.videoId, e.membersOnly, e.works.map((x) => [workById.get(x.id)?.key, workById.get(x.id)?.title, x.episodes]), e.missing, e.frame,
    ]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    prints.set(streamerPath(s.channelId), { target: s, print: [s.name, s.nameEn, s.affiliation, s.branch, s.iconUrl, evs] });
  }

  const get = db.prepare("SELECT fingerprint, changed_at FROM site_pages WHERE path = ?");
  const put = db.prepare(`INSERT INTO site_pages (path, fingerprint, changed_at, built_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET fingerprint = excluded.fingerprint, changed_at = excluded.changed_at, built_at = excluded.built_at`);
  for (const [path, { target, print }] of prints) {
    const fp = createHash("sha1").update(JSON.stringify(print)).digest("hex");
    const prev = get.get(path) as { fingerprint: string; changed_at: string } | undefined;
    const changedAt = prev && prev.fingerprint === fp ? prev.changed_at : nowIso;
    put.run(path, fp, changedAt, nowIso);
    target.lastmod = changedAt;
  }
}
