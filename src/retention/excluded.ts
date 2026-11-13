import type { DB } from "../lib/db.ts";
import { tx } from "../lib/db.ts";
import { CLEAR_DETAIL_SQL } from "../candidates/store.ts";

// 巡回しないチャンネル（config/roster.yaml の excluded_channels。決定 D-13）のデータは、30日の決まり（D-12）で取り直さずに消す。
// 今後使わないので、API で取り直す意味が無い（2026-11-13。親のセッションの提案を受けて決めた）。
// 卒業した（公式の一覧から外れた）配信者は過去の枠を出し続けるので、ふだんどおり取り直す。こちらは枠が1つも無いチャンネルを外す決定なので消す。
//
// - 消すのは、roster がそのチャンネルを is_active = 0 にしたあとだけ（roster が失敗して巡回中のままなら、ふだんどおり取り直す）
// - videos_seen: 題名を空文字・公開日を NULL にし、gone_at を立てる（返ってこない動画と同じ。行と判定の結果は残す）
// - candidates: 答える前と保留の候補（selected・waiting・ready・hold）は unavailable（fetch_note = excluded_channel）にして詳細を消す（判定に回さない）。
//   答えた候補はふだんの決まり（src/retention/purge.ts）のまま
// - streamers のアイコンとチャンネル名: roster の channels.list で引かずに消す（src/roster/sync.ts の refreshChannelMeta）
// 設定から外して巡回に戻すと、巡回で見た動画（uploads の先頭50本・メン限の再生リスト）は題名が入り直す。遡りで見た古い動画の題名と、unavailable にした候補は戻らない

export interface ExcludedStats {
  /** 設定にあり、roster が巡回を止めたチャンネル */
  channels: string[];
  /** 設定にあるが、まだ巡回中か行が無いチャンネル（roster が済んでいない。消さない） */
  pending_roster: string[];
  videos_seen: number;
  candidates: number;
}

/** 設定のチャンネルのうち、巡回を止めたもの（is_active = 0）と、まだのもの */
export function excludedInactive(db: DB, channelIds: readonly string[]): { inactive: string[]; pending: string[] } {
  const inactive = new Set((db.prepare(`SELECT channel_id FROM streamers WHERE is_active = 0 AND channel_id IN (${channelIds.map(() => "?").join(",") || "''"})`)
    .all(...channelIds) as { channel_id: string }[]).map((r) => r.channel_id));
  return { inactive: channelIds.filter((c) => inactive.has(c)), pending: channelIds.filter((c) => !inactive.has(c)) };
}

export function clearExcludedChannels(db: DB, channelIds: readonly string[], now: string = new Date().toISOString()): ExcludedStats {
  const { inactive, pending } = excludedInactive(db, channelIds);
  const s: ExcludedStats = { channels: inactive, pending_roster: pending, videos_seen: 0, candidates: 0 };
  if (!inactive.length) return s;
  const ph = inactive.map(() => "?").join(",");
  tx(db, () => {
    s.videos_seen = Number(db.prepare(`UPDATE videos_seen SET title = '', published_at = NULL, gone_at = ? WHERE gone_at IS NULL AND channel_id IN (${ph})`)
      .run(now, ...inactive).changes);
    s.candidates = Number(db.prepare(`UPDATE candidates SET state = 'unavailable', state_at = ?, fetch_note = 'excluded_channel',
        cleared_at = CASE WHEN title_raw IS NOT NULL OR description_raw IS NOT NULL OR thumbnail_url IS NOT NULL OR view_count IS NOT NULL THEN ? ELSE cleared_at END,
        ${CLEAR_DETAIL_SQL}
      WHERE state IN ('selected', 'waiting', 'ready', 'hold') AND streamer_id IN (SELECT id FROM streamers WHERE channel_id IN (${ph}))`)
      .run(now, now, ...inactive).changes);
  });
  return s;
}
