// ジョブとフロント（Astro）で共有する型。
// DB の行の形と、画面用 JSON の形をここに集める。

export type Affiliation = "nijisanji" | "hololive" | "vspo" | "other";
export type Platform = "youtube";
export type Tier = 1 | 2;
export type EventStatus = "upcoming" | "live" | "completed";
export type DetectSource = "title" | "description";
/** 動画をどの経路で最初に見つけたか */
export type FoundVia = "rss" | "playlist" | "members_playlist" | "backfill";
/**
 * started_at に入れた値の出どころ。
 * actual_start: 実開始 / scheduled_start: 予定時刻（未開始など）/ published_at: 公開日時（ライブでない再アップなど）
 */
export type StartedAtSource = "actual_start" | "scheduled_start" | "published_at";

export const AFFILIATIONS: readonly Affiliation[] = ["nijisanji", "hololive", "vspo", "other"];

/** 作品の映像の種類（works.kind。外部DBから自動で埋める。src/resolve/enrich.ts） */
export type WorkKind = "anime" | "tokusatsu" | "live_action";

export const WORK_KIND_LABEL: Record<WorkKind, string> = { anime: "アニメ", tokusatsu: "特撮", live_action: "実写" };

/** 作品の形態（works.media）。映画かどうかは movie で見る */
export type WorkMedia = "tv" | "movie" | "ova" | "web";

/**
 * 所属の中の区分（streamers.branch。公式サイトから自動で埋める）。UI の所属の絞り込みで、事務所の下のチェックボックスにする。
 * にじさんじの公式の一覧には、統合した旧 NIJISANJI KR・旧 NIJISANJI ID のライバーも入っている（2026-10-02 決定: 外さずに区分で絞れるようにする）。
 * NIJISANJI EN・hololive EN も対象（2026-10-02 決定）。区分は en
 */
export type Branch = "jp" | "kr" | "id" | "en";

export const BRANCH_LABEL: Record<Branch, string> = { jp: "日本", kr: "KR", id: "ID", en: "EN" };

export const AFFILIATION_LABEL: Record<Affiliation, string> = {
  nijisanji: "にじさんじ",
  hololive: "ホロライブ",
  vspo: "ぶいすぽっ！",
  other: "その他",
};

export interface Streamer {
  id: number;
  name: string;
  /** 英語の名前（にじさんじは名簿の API の enName、ホロライブは英語版の一覧）。取れなければ null */
  name_en: string | null;
  affiliation: Affiliation;
  /** 所属の中の区分（にじさんじの jp / kr / id。ホロライブ・ぶいすぽっ！は jp） */
  branch: Branch | null;
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
  /** 実開始時刻。未開始なら予定時刻、ライブでない動画は公開日時 */
  started_at: string | null;
  started_at_source: StartedAtSource | null;
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
  /** 判定ルールの変更で同時視聴枠でなくなった時刻と理由。NULL でなければ一覧から消す（行は残す） */
  excluded_at: string | null;
  excluded_reason: string | null;
  last_checked_at: string | null;
  updated_at: string;
}
