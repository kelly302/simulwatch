import { mkdirSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DB } from "../lib/db.ts";
import { tx } from "../lib/db.ts";
import { DATA_DIR } from "../lib/paths.ts";
import type { CrawlConfig, SiteConfig } from "../lib/config.ts";
import type { ExtractConfig } from "../resolve/config.ts";
import { buildSiteData } from "./snapshot.ts";

/** サイト用のデータの置き場（Astro のビルドが読む。公開しない。SITE_DATA で変えられる） */
export const SITE_DATA_PATH = process.env.SITE_DATA ?? join(DATA_DIR, "site", "site-data.json");

/**
 * サイト用のデータを書き出す（公開キーと lastmod の表も更新する）。件数を返す。
 * 最初に前回のファイルを消す: 書き出しに失敗したら、ビルドが前回の古いデータで成功してアップロードされないように、
 * ファイル無しでビルドを失敗させる（前の版のサイトがそのまま公開され続ける）。ジョブの終了コードは 0 のまま（CLAUDE.md「実行方法」）
 */
export function exportSiteData(db: DB, cfg: { site: SiteConfig; crawl: CrawlConfig; extract: ExtractConfig }, out = SITE_DATA_PATH, now = new Date()): Record<string, number> {
  rmSync(out, { force: true });
  const data = tx(db, () => buildSiteData(db, {
    now,
    aiRoutes: cfg.extract.ai_routes ?? [],
    maxDaysAhead: cfg.crawl.upcoming.max_days_ahead,
    publishUpcoming: cfg.site.publish_upcoming ?? false,
    upcomingStaleHours: cfg.site.upcoming_stale_hours,
  }));
  mkdirSync(dirname(out), { recursive: true });
  // 書きかけのファイルをビルドが読まないよう、別名で書いてから置き換える
  writeFileSync(`${out}.tmp`, JSON.stringify(data));
  renameSync(`${out}.tmp`, out);
  const byStatus = (s: string) => data.events.filter((e) => e.status === s).length;
  return {
    events: data.events.length,
    completed: byStatus("completed"),
    upcoming: byStatus("upcoming"),
    live: byStatus("live"),
    frames: data.events.filter((e) => e.frame).length,
    works: data.works.length,
    work_pages: data.works.filter((w) => w.hasPage).length,
    streamers: data.streamers.length,
    streamer_pages: data.streamers.filter((s) => s.hasPage).length,
    redirects: data.redirects.length,
    skipped_no_works: data.skipped?.noWorks.length ?? 0,
  };
}
