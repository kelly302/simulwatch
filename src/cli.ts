import { parseArgs } from "node:util";
import { createCtx, finishCtx } from "./lib/context.ts";
import { openDb } from "./lib/db.ts";
import { loadDetectConfig } from "./lib/config.ts";
import { syncRoster } from "./roster/sync.ts";
import { crawlHourly, crawlDaily, refreshAll, fetchOrphans } from "./crawl/jobs.ts";
import { detectReport, quotaReport, rerunDetect } from "./report/reports.ts";

// 使い方: npm run cli -- <command> [options]

const HELP = `
コマンド:
  roster          Tier 1 の一覧を公式サイトと同期する（日次）
  crawl:hourly    RSS の差分 + playlistItems の一部 + 予定枠・配信中の状態更新（毎時）
  crawl:daily     全チャンネルの uploads 先頭 + メン限プレイリスト + 過去分の遡り（日次）
                  [--backfill-units N] で遡りの予算をその回だけ変える
  refresh         全枠の再生数・状態の取り直しとアーカイブ死活チェック（日次）
  report:detect   判定結果の集計と、誤検出・取りこぼしの候補を表示する [--limit N]
  report:quota    クォータ使用量を表示する [--days N]
  detect:rerun    語彙を変えたあと、保存済みタイトルで再判定する（API を使わない）
  detect:fetch    再判定で新たにヒットした動画の詳細を取り、WatchEvent にする（videos.list）

環境変数:
  YOUTUBE_API_KEY  YouTube Data API のキー（.env に書けば自動で読む）
  DATA_DIR         SQLite と生レスポンスの置き場（既定 ./data）
`;

type Job = (ctx: ReturnType<typeof createCtx>) => Promise<void>;

const JOBS: Record<string, { job: string; run: Job }> = {
  "roster": { job: "daily", run: syncRoster },
  "crawl:hourly": { job: "hourly", run: crawlHourly },
  "crawl:daily": { job: "daily", run: crawlDaily },
  "refresh": { job: "daily", run: refreshAll },
  "detect:fetch": { job: "daily", run: fetchOrphans },
};

async function main(): Promise<number> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { limit: { type: "string" }, days: { type: "string" }, "backfill-units": { type: "string" } },
  });
  const cmd = positionals[0];

  if (cmd && JOBS[cmd]) {
    const { job, run } = JOBS[cmd];
    const ctx = createCtx(job);
    if (values["backfill-units"] !== undefined) ctx.crawlCfg.backfill.max_units_per_run = Number(values["backfill-units"]);
    try {
      await run(ctx);
    } finally {
      finishCtx(ctx);
    }
    // ステップ単位の失敗は partial として記録済み。ジョブ自体は成功扱いにし、後続のジョブを止めない
    return 0;
  }

  switch (cmd) {
    case "report:detect": {
      const db = openDb();
      console.log(detectReport(db, loadDetectConfig(), Number(values.limit ?? 20)));
      return 0;
    }
    case "report:quota": {
      const db = openDb();
      console.log(quotaReport(db, Number(values.days ?? 7)));
      return 0;
    }
    case "detect:rerun": {
      const db = openDb();
      console.log(rerunDetect(db, loadDetectConfig()));
      return 0;
    }
    default:
      console.log(HELP);
      return cmd ? 1 : 0;
  }
}

process.exitCode = await main();
