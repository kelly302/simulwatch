// ジョブとフロント（Astro）で共有する型。
// DB の行の形と、画面用 JSON の形をここに集める。

export type Affiliation = "nijisanji" | "hololive" | "vspo" | "other";
export type Platform = "youtube";
export type Tier = 1 | 2;
export type EventStatus = "upcoming" | "live" | "completed";
export type DetectSource = "title" | "description";
/** 動画をどの経路で最初に見つけたか */
export type FoundVia = "rss" | "playlist" | "members_playlist" | "backfill";

export const AFFILIATIONS: readonly Affiliation[] = ["nijisanji", "hololive", "vspo", "other"];

export const AFFILIATION_LABEL: Record<Affiliation, string> = {
  nijisanji: "にじさんじ",
  hololive: "ホロライブ",
  vspo: "ぶいすぽっ！",
  other: "その他",
};

export interface Streamer {
  id: number;
  name: string;
  affiliation: Affiliation;
  channel_id: string;
  platform: Platform;
  icon_url: string | null;
  tier: Tier;
  /** 公式一覧に載っていて巡回対象か。卒業・引退で false（過去データは残す） */
  is_active: 0 | 1;
  /** 公式サイト上の識別子（例: "nijisanji:kuzuha"）。Tier 2 は null */
  source_key: string | null;
  channel_title: string | null;
  first_seen_at: string;
  last_listed_at: string | null;
  deactivated_at: string | null;
  updated_at: string;
}

export interface WatchEvent {
  id: number;
  streamer_id: number;
  video_id: string;
  /** YouTube のタイトル原文。正規化した文字列で上書きしない */
  title_raw: string;
  /** 概要欄の原文。extract と再判定のためだけに持つ。公開しない */
  description_raw: string | null;
  thumbnail_url: string | null;
  url: string;
  /** 実開始時刻。未開始なら予定時刻 */
  started_at: string | null;
  scheduled_start_at: string | null;
  ended_at: string | null;
  status: EventStatus;
  is_members_only: 0 | 1;
  /** NULL は「取得できていない」。0 と区別する */
  view_count: number | null;
  view_count_fetched_at: string | null;
  detected_at: string;
  detect_source: DetectSource;
  detect_keyword: string;
  found_via: FoundVia;
  /** アーカイブが見られなくなった時刻。NULL でなければ一覧から消す（行は残す） */
  archive_gone_at: string | null;
  last_checked_at: string | null;
  updated_at: string;
}
