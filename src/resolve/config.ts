import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { parse } from "yaml";
import { ROOT } from "../lib/paths.ts";

// config/extract.yaml の型と読み込み

export interface ExtractConfig {
  not_a_work: string[];
  tag_brackets: [string, string][];
  quote_brackets: [string, string][];
  tag_words: string[];
  noise_words: string[];
  trim_words: string[];
  stop_segments: string[];
  season_qualifiers: string[];
  /** not_a_work に当たっても、作品名だと明示された括弧があればその中身を照会する（正規表現） */
  not_a_work_quote_override?: string;
  /** 企画名・番組名（作品名ではない） */
  program_names?: string[];
  /** タイトルの期・部の表記 */
  title_markers?: { kind: "season" | "part"; re: string; tag: string; suffixes?: string[] }[];
  /** 概要欄の作品名の列挙の末尾の動詞 */
  description_list_verbs?: string[];
  /** Wikidata のラベルの完全一致で同定する段（Wikipedia に記事が無い作品。「来る」「笑いのカイブツ」）と、同名別作品の照合にラベル検索を使う */
  wikidata_label?: boolean;
  /** AI に回す型（src/resolve/route.ts の型か層）。この型の枠は AI が確かめるまでサイトに出さない */
  /** AI の判定役に見せる手がかり（src/report/neighbors.ts） */
  ai_context?: {
    neighbors?: number;
    same_name?: number;
    link_patterns?: string[];
    generic_titles?: string[];
    max_links?: number;
    /** 公開の枠で見せるコメントの数（0 で見せない）と1件の文字数 */
    comments?: number;
    comment_chars?: number;
    /** 同時視聴枠にならなかった同じ配信者の動画（videos_seen の題名だけ。src/report/neighbors.ts の otherVideos） */
    other_videos?: {
      /** この枠の作品名の区間を題名に含む動画の数（期間を限らない。0 で見せない） */
      same_name?: number;
      /** メン限の枠で見せる、前後 members_days 日のメン限の動画の数（0 で見せない） */
      members?: number;
      members_days?: number;
      /** チャンネルの動画のこの割合を超える動画（10本以上）に出る区間は、決まり文句として使わない */
      boilerplate_ratio?: number;
      /** 作品名でない区間の照合キー（正規表現） */
      ignore_keys?: string[];
    };
  };
  ai_routes?: string[];
  /** 視聴系列による期の割り当て（src/resolve/series.ts）。false で止める */
  series_assignment?: boolean;
  match_normalize: { strip_chars: string; season_patterns: string[]; fold_chars?: Record<string, string>; fold_kana?: boolean };
  annict: { batch_size: number; per_query: number };
  anilist: { batch_size: number };
  wikipedia: {
    title_suffixes: string[];
    work_classes: Record<string, "tv" | "movie" | "ova" | "web">;
    anime_classes: string[];
    /** 原作・作品の記事のクラス（小説・漫画など）。Wikidata のラベルの段で、区間と同名の記事がこれでなければ区間は一般の語とみなす */
    source_classes?: string[];
    not_work_classes: Record<string, string>;
    /** 映像の種類を決めるジャンル（P136）。特撮のジャンルがあれば特撮、アニメーションのジャンルか anime_classes の分類があればアニメ */
    tokusatsu_genres?: string[];
    tokusatsu_origin?: { language: string; country: string };
    tokusatsu_title_words?: string[];
    tokusatsu_inherit_classes?: string[];
    series_excluded_classes?: string[];
    series_excluded?: string[];
    animation_genres?: string[];
    /** シーズンの項目のクラス（テレビシリーズのシーズン）。実写ならシリーズの項目に付け替える */
    live_season_classes?: string[];
    /** AI の判定（ai:apply）で受け付けるときだけ足す作品のクラス。ルールの照合には使わない */
    ai_extra_work_classes?: Record<string, "tv" | "movie" | "ova" | "web">;
  };
  /** ルールのバージョン（ファイル内容とリゾルバのコードバージョンのハッシュ） */
  version: string;
}

/** リゾルバの処理を変えたら上げる。設定ファイルと合わせて再処理の要否を判断する */
export const RESOLVER_CODE_VERSION = 4;

export function loadExtractConfig(): ExtractConfig {
  const raw = readFileSync(join(ROOT, "config", "extract.yaml"), "utf8");
  const c = parse(raw) as Omit<ExtractConfig, "version">;
  const version = createHash("sha256").update(raw).update(String(RESOLVER_CODE_VERSION)).digest("hex").slice(0, 12);
  return { ...c, version };
}
