// 名寄せで使う共通の型

export type Media = "tv" | "movie" | "ova" | "web";
export type WorkSource = "annict" | "anilist" | "wikidata";

/** 外部作品DBから得た作品の候補 */
export interface WorkCandidate {
  source: WorkSource;
  /** 照会先の中での一意なキー（例 "annict:123"） */
  sourceKey: string;
  annictId: number | null;
  anilistId: number | null;
  wikidataId: string | null;
  malId: number | null;
  title: string;
  titleKana: string | null;
  /** 照合に使う表記（原題・英題・ローマ字・別名など） */
  titles: string[];
  media: Media | null;
  seasonName: string | null;
  releaseYear: number | null;
  episodesCount: number | null;
  imageUrl: string | null;
  seriesId: string | null;
  /** Wikidata の作品がアニメ（P31 がアニメのクラス）か。アニメなら期の表記で照合する */
  isAnime?: boolean;
}

export type UnresolvedReason = "no_candidate" | "unidentifiable" | "not_found" | "ambiguous" | "not_a_work" | "error";

export const UNRESOLVED_REASON_LABEL: Record<UnresolvedReason, string> = {
  no_candidate: "作品名を切り出せない",
  unidentifiable: "同時視聴だが作品を特定できない",
  not_found: "照会でヒットしない",
  ambiguous: "候補が複数あり決められない",
  not_a_work: "作品ではない",
  error: "照会エラー（次回再試行）",
};
