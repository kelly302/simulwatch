import type { Ctx } from "../lib/context.ts";
import { runStep } from "../lib/context.ts";
import type { Affiliation } from "../shared/types.ts";
import type { RosterEntry, KnownChannels } from "./sources.ts";
import { fetchNijisanji, fetchHololive, fetchVspo } from "./sources.ts";
import { chunk } from "../youtube/api.ts";
import { bestThumbnail } from "../youtube/api.ts";
import { QuotaExhausted } from "../lib/quota.ts";
import { tx } from "../lib/db.ts";
import { nowIso } from "../lib/time.ts";
import { log, errorMessage } from "../lib/log.ts";

// Tier 1 の一覧を公式サイトと同期する。
// - 事務所ごとに独立。1つが失敗しても他は進める
// - 取得件数が min_count 未満なら失敗扱い。前回の一覧を保持し、誰も卒業扱いにしない
// - 公式一覧から外れた人は is_active = 0（巡回を止める。データは残す）
// - config/roster.yaml の excluded_channels に書いたチャンネルも、一覧に載っていても is_active = 0（卒業と同じ扱い。2026-11-13 決定 D-13）

interface OrgResult {
  fetched: number;
  active: number;
  inactive: number;
  inserted: number;
  reactivated: number;
  deactivated: number;
  no_channel: string[];
  /** excluded_channels で巡回しないことにした source_key */
  excluded: string[];
}

function knownChannels(ctx: Ctx): KnownChannels {
  const rows = ctx.db.prepare("SELECT source_key, channel_id FROM streamers WHERE source_key IS NOT NULL").all() as { source_key: string; channel_id: string }[];
  // まとめた配信者（source_key が「a+b」）は、まとめる前のそれぞれの source_key でも引けるようにする（詳細ページを毎回取らない）
  return new Map(rows.flatMap((r) => [[r.source_key, r.channel_id] as [string, string], ...(r.source_key.includes("+") ? r.source_key.split("+").map((k) => [k, r.channel_id] as [string, string]) : [])]));
}

async function resolveHandles(ctx: Ctx, entries: RosterEntry[]): Promise<void> {
  for (const e of entries) {
    if (e.channelId || !e.handle || e.inactive) continue;
    if (!ctx.yt) continue;
    try {
      const ch = await ctx.yt.channelByHandle(e.handle);
      if (ch) e.channelId = ch.id;
    } catch (err) {
      if (err instanceof QuotaExhausted) throw err;
      log.warn(`handle 解決に失敗 @${e.handle}: ${errorMessage(err)}`);
    }
  }
}

function applyOrg(ctx: Ctx, affiliation: Affiliation, entries: RosterEntry[]): OrgResult {
  const { db } = ctx;
  const now = nowIso();
  const r: OrgResult = { fetched: entries.length, active: 0, inactive: 0, inserted: 0, reactivated: 0, deactivated: 0, no_channel: [], excluded: [] };
  const bySource = db.prepare("SELECT id, is_active, channel_title FROM streamers WHERE source_key = ?");
  const byChannel = db.prepare("SELECT id, is_active, channel_title FROM streamers WHERE channel_id = ?");
  const insert = db.prepare(`
    INSERT INTO streamers (name, name_en, affiliation, branch, channel_id, platform, tier, is_active, source_key, first_seen_at, last_listed_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'youtube', 1, 1, ?, ?, ?, ?)`);
  // 英語の名前は取れなかったら前回の値を残す
  const update = db.prepare(`
    UPDATE streamers SET name = ?, name_en = COALESCE(?, name_en), affiliation = ?, branch = ?, channel_id = ?, tier = 1, is_active = 1, source_key = ?,
      last_listed_at = ?, deactivated_at = NULL, updated_at = ? WHERE id = ?`);
  const deactivate = db.prepare("UPDATE streamers SET is_active = 0, deactivated_at = ?, updated_at = ? WHERE id = ? AND is_active = 1");

  const listedIds = new Set<number>();
  tx(db, () => {
    for (const e of entries) {
      const existing = (bySource.get(e.sourceKey) ?? (e.channelId ? byChannel.get(e.channelId) : undefined)) as
        | { id: number; is_active: number; channel_title: string | null }
        | undefined;
      if (e.inactive) {
        r.inactive++;
        if (existing && deactivate.run(now, now, existing.id).changes > 0) r.deactivated++;
        continue;
      }
      r.active++;
      if (!e.channelId) {
        // チャンネルを抜き出せなかった。既存なら現状維持、新規なら次回に回す
        r.no_channel.push(e.sourceKey);
        if (existing) listedIds.add(existing.id);
        continue;
      }
      if (existing) {
        if (!existing.is_active) r.reactivated++;
        // まとめた配信者の名前は、チャンネル名から取れればそれを使う（FUWAMOCO）。英語の名前も同じ（名前と同じなら併記しない）
        const shared = e.sourceKey.includes("+") ? sharedChannelName(existing.channel_title) : null;
        update.run(shared ?? e.name, shared ?? e.nameEn, affiliation, e.branch, e.channelId, e.sourceKey, now, now, existing.id);
        listedIds.add(existing.id);
      } else {
        const res = insert.run(e.name, e.nameEn, affiliation, e.branch, e.channelId, e.sourceKey, now, now, now);
        listedIds.add(Number(res.lastInsertRowid));
        r.inserted++;
      }
    }
    // 公式一覧から外れた Tier 1 は巡回を止める
    const current = db.prepare("SELECT id FROM streamers WHERE tier = 1 AND affiliation = ? AND is_active = 1").all(affiliation) as { id: number }[];
    for (const row of current) {
      if (!listedIds.has(row.id) && deactivate.run(now, now, row.id).changes > 0) r.deactivated++;
    }
  });
  return r;
}

async function syncOrg(
  ctx: Ctx,
  affiliation: Affiliation,
  minCount: number,
  fetcher: (known: KnownChannels) => Promise<RosterEntry[]>,
  excluded: ReadonlySet<string> = new Set(),
): Promise<OrgResult & { shared_channel: Record<string, string[]> }> {
  const entries = await fetcher(knownChannels(ctx));
  const activeCount = entries.filter((e) => !e.inactive).length;
  if (activeCount < minCount) {
    throw new Error(`${affiliation}: 取得件数 ${activeCount} が min_count ${minCount} 未満。抜き出しが壊れた可能性があるため前回の一覧を保持します`);
  }
  // 同じ handle を何度も解決しないよう解決前に一度、別の handle が同じチャンネルを指す場合に備えて解決後にもう一度見る
  const sharedBefore = mergeSharedChannels(entries);
  await resolveHandles(ctx, entries);
  const sharedAfter = mergeSharedChannels(entries);
  const excludedKeys = applyExcluded(entries, excluded);
  const r = applyOrg(ctx, affiliation, entries);
  return { ...r, excluded: excludedKeys, shared_channel: { ...sharedBefore, ...sharedAfter } };
}

/**
 * 公式の一覧に載っていても巡回しないチャンネル（config/roster.yaml の excluded_channels）を、卒業と同じ inactive にする。
 * 既にいる行は applyOrg が is_active = 0 にし、新しい行は作らない。設定から消せば次の roster で戻る。
 * 戻り値は外した source_key。entries はその場で書き換える
 */
export function applyExcluded(entries: RosterEntry[], excluded: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const e of entries) {
    if (e.inactive || !e.channelId || !excluded.has(e.channelId)) continue;
    e.inactive = true;
    out.push(e.sourceKey);
  }
  return out;
}

/**
 * 複数のタレントが1つのチャンネルで配信している組（FUWAMOCO のフワワ・モココ）は、1配信者にまとめる（2026-10-03 決定）。
 * 名前はチャンネル名から取る（sharedChannelName。「FUWAMOCO」。2026-10-09 決定）。取れるまで・取れないときは公式の一覧の順に「＆」でつなぐ。
 * source_key は「hololive:fuwawa-abyssgard+hololive:mococo-abyssgard」のようにつなぐ。
 * （ゲート1では共用チャンネルを対象外にしていたが、外したかった holoAN room は公式アナウンサーの番組チャンネルなので、
 *  名簿の対象のグループから holoAN を外す形に改めた。config/roster.yaml）
 * 戻り値はまとめたチャンネル → まとめる前の source_key。entries はその場で書き換える
 */
export function mergeSharedChannels(entries: RosterEntry[]): Record<string, string[]> {
  const byChannel = new Map<string, RosterEntry[]>();
  for (const e of entries) {
    const key = e.channelId ?? (e.handle ? `@${e.handle.toLowerCase()}` : null);
    if (e.inactive || !key) continue;
    byChannel.set(key, [...(byChannel.get(key) ?? []), e]);
  }
  const shared: Record<string, string[]> = {};
  for (const [key, es] of byChannel) {
    if (es.length < 2) continue;
    shared[key] = es.map((e) => e.sourceKey);
    const merged: RosterEntry = {
      ...es[0]!, name: es.map((e) => e.name).join("＆"), sourceKey: es.map((e) => e.sourceKey).join("+"),
      nameEn: es.every((e) => e.nameEn) ? es.map((e) => e.nameEn).join(" & ") : null,
    };
    const at = entries.indexOf(es[0]!);
    for (const e of es) entries.splice(entries.indexOf(e), 1);
    entries.splice(at, 0, merged);
  }
  return shared;
}

/**
 * まとめた配信者（共用チャンネル）の名前。チャンネル名の「Ch.」「Channel」より前（「FUWAMOCO Ch. hololive」→「FUWAMOCO」）。
 * その形でなければ null（タレントの名前を「＆」でつないだままにする）
 */
export function sharedChannelName(channelTitle: string | null | undefined): string | null {
  const m = /^(.+?)\s+(?:Ch\.|Channel(?:\s|$))/i.exec((channelTitle ?? "").trim());
  return m?.[1]?.trim() || null;
}

/** まとめた配信者の名前を、いま持っているチャンネル名で付け直す（新しくまとめた回は channels.list のあとでチャンネル名が入る） */
function nameSharedChannels(ctx: Ctx): { renamed: string[] } {
  const rows = ctx.db.prepare("SELECT id, name, channel_title FROM streamers WHERE source_key LIKE '%+%'").all() as { id: number; name: string; channel_title: string | null }[];
  const out = { renamed: [] as string[] };
  const upd = ctx.db.prepare("UPDATE streamers SET name = ?, name_en = ?, updated_at = ? WHERE id = ?");
  for (const r of rows) {
    const name = sharedChannelName(r.channel_title);
    if (!name || name === r.name) continue;
    upd.run(name, name, nowIso(), r.id);
    out.renamed.push(`${r.name} → ${name}`);
  }
  return out;
}

/**
 * channels.list でアイコンとチャンネル名を更新する（50件で1ユニット）。
 * 巡回を止めた（卒業した）配信者も取り直す（過去の枠と一緒にアイコンを出すので、30日の決まりで取り直す。D-12）。
 * 返ってこないチャンネルは、最後に返ってきた時刻（channel_meta_at）が act_after_days を過ぎていればアイコンとチャンネル名を消す（名前は事務所の名簿の値なので残る）。
 * 1バッチ（10件以上）の半分超が返ってこなければ API の異常とみなして消さない（refresh と同じ）
 */
export async function refreshChannelMeta(ctx: Pick<Ctx, "db" | "yt" | "crawlCfg">, now: Date = new Date()): Promise<{ updated: number; inactive_updated: number; missing: string[]; cleared: string[] }> {
  const out = { updated: 0, inactive_updated: 0, missing: [] as string[], cleared: [] as string[] };
  if (!ctx.yt) return out;
  const rows = ctx.db.prepare("SELECT id, channel_id, is_active, channel_meta_at FROM streamers ORDER BY is_active DESC, id").all() as
    { id: number; channel_id: string; is_active: number; channel_meta_at: string | null }[];
  const byChannel = new Map(rows.map((r) => [r.channel_id, r]));
  const before = new Date(now.getTime() - ctx.crawlCfg.retention.act_after_days * 86_400_000).toISOString();
  const { min_batch_for_ratio: minBatch, max_missing_ratio: maxMissing } = ctx.crawlCfg.refresh;
  const upd = ctx.db.prepare("UPDATE streamers SET icon_url = COALESCE(?, icon_url), channel_title = COALESCE(?, channel_title), channel_meta_at = ?, updated_at = ? WHERE channel_id = ?");
  const clear = ctx.db.prepare("UPDATE streamers SET icon_url = NULL, channel_title = NULL, updated_at = ? WHERE channel_id = ? AND (icon_url IS NOT NULL OR channel_title IS NOT NULL)");
  for (const ids of chunk(rows.map((r) => r.channel_id), 50)) {
    const items = await ctx.yt.channels(ids);
    const got = new Set(items.map((i) => i.id));
    const at = nowIso();
    const guard = ids.length >= minBatch && (ids.length - items.length) / ids.length > maxMissing;
    if (guard) log.warn(`channels.list の欠落が多すぎるため、アイコンとチャンネル名を消しません (${ids.length - items.length}/${ids.length})`);
    tx(ctx.db, () => {
      for (const it of items) {
        upd.run(bestThumbnail(it.snippet?.thumbnails), it.snippet?.title ?? null, at, at, it.id);
        out.updated++;
        if (byChannel.get(it.id)?.is_active === 0) out.inactive_updated++;
      }
      for (const id of ids) {
        if (got.has(id)) continue;
        out.missing.push(id);
        const r = byChannel.get(id);
        if (guard || !r || (r.channel_meta_at !== null && r.channel_meta_at >= before)) continue;
        if (clear.run(at, id).changes > 0) out.cleared.push(id);
      }
    });
  }
  return out;
}

export async function syncRoster(ctx: Ctx): Promise<void> {
  const cfg = ctx.rosterCfg;
  const excluded = new Set((cfg.excluded_channels ?? []).map((c) => c.channel_id));
  const results: Record<string, unknown> = {};
  results.nijisanji = await runStep(ctx, "roster: nijisanji", () =>
    syncOrg(ctx, "nijisanji", cfg.nijisanji.min_count, (k) => fetchNijisanji(ctx.http, cfg.nijisanji, k), excluded));
  results.hololive = await runStep(ctx, "roster: hololive", () =>
    syncOrg(ctx, "hololive", cfg.hololive.min_count, (k) => fetchHololive(ctx.http, cfg.hololive, k), excluded));
  results.vspo = await runStep(ctx, "roster: vspo", () =>
    syncOrg(ctx, "vspo", cfg.vspo.min_count, () => fetchVspo(ctx.http, cfg.vspo), excluded));
  results.channel_meta = await runStep(ctx, "roster: channels.list", () => refreshChannelMeta(ctx));
  results.shared_names = await runStep(ctx, "roster: 共用チャンネルの名前", async () => nameSharedChannels(ctx));
  const counts = ctx.db
    .prepare("SELECT affiliation, SUM(is_active) AS active, COUNT(*) AS total FROM streamers GROUP BY affiliation ORDER BY affiliation")
    .all();
  results.totals = counts;
  ctx.summary.roster = results;
}
