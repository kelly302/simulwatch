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
  match_normalize: { strip_chars: string; season_patterns: string[] };
  annict: { batch_size: number; per_query: number };
  anilist: { batch_size: number };
  wikipedia: {
    title_suffixes: string[];
    work_classes: Record<string, "tv" | "movie" | "ova" | "web">;
    not_work_classes: Record<string, string>;
  };
  /** ルールのバージョン（ファイル内容とリゾルバのコードバージョンのハッシュ） */
  version: string;
}

/** リゾルバの処理を変えたら上げる。設定ファイルと合わせて再処理の要否を判断する */
export const RESOLVER_CODE_VERSION = 1;

export function loadExtractConfig(): ExtractConfig {
  const raw = readFileSync(join(ROOT, "config", "extract.yaml"), "utf8");
  const c = parse(raw) as Omit<ExtractConfig, "version">;
  const version = createHash("sha256").update(raw).update(String(RESOLVER_CODE_VERSION)).digest("hex").slice(0, 12);
  return { ...c, version };
}
