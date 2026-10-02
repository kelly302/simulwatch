import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { parse } from "yaml";
import { ROOT } from "./paths.ts";

export interface DetectFieldConfig {
  include: string[];
  exclude: string[];
}

export interface DetectConfig {
  normalize: { nfkc: boolean; lowercase: boolean; strip_chars: string };
  title: DetectFieldConfig;
  description: DetectFieldConfig & {
    enabled: boolean;
    line_require: string[];
    line_exclude: string[];
    template_min_repeats: number;
  };
  reject: { require_live: boolean };
  members_only: { title_include: string[] };
  review_hints: string[];
  /** ファイル内容のハッシュ。語彙を変えたら変わる */
  version: string;
}

export interface RosterConfig {
  nijisanji: { list_url: string; detail_url: string; min_count: number; branch_markers?: Record<string, string[]>; extra_lists?: { url: string; branch: string }[] };
  hololive: {
    group_url: string;
    detail_url: string;
    groups: string[];
    group_branch?: Record<string, string>;
    inactive_name_markers: string[];
    exclude_channel_ids: string[];
    min_count: number;
  };
  vspo: { list_url: string; japanese_class: string; min_count: number };
}

export interface CrawlConfig {
  quota: { daily_limit: number; stop_at: number; per_run: Record<string, number> };
  rss: { url: string };
  hourly: { playlist_scan_interval_hours: number; playlist_scan_page_size: number };
  upcoming: { max_days_ahead: number };
  daily: { playlist_page_size: number; members_playlist: boolean };
  backfill: { enabled: boolean; max_units_per_run: number; since: string | null };
  refresh: { max_missing_ratio: number; min_batch_for_ratio: number };
  http: {
    timeout_ms: number;
    retries: number;
    min_interval_ms: Record<string, number>;
    user_agent: string;
  };
}

function readYaml(name: string): { data: unknown; raw: string } {
  const raw = readFileSync(join(ROOT, "config", name), "utf8");
  return { data: parse(raw), raw };
}

export function loadDetectConfig(): DetectConfig {
  const { data, raw } = readYaml("detect.yaml");
  const c = data as Omit<DetectConfig, "version">;
  const version = createHash("sha256").update(raw).digest("hex").slice(0, 12);
  return { ...c, version };
}

export function loadRosterConfig(): RosterConfig {
  return readYaml("roster.yaml").data as RosterConfig;
}

export function loadCrawlConfig(): CrawlConfig {
  return readYaml("crawl.yaml").data as CrawlConfig;
}
