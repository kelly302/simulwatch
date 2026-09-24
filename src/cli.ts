import { parseArgs } from "node:util";
import { createCtx, finishCtx, runStep } from "./lib/context.ts";
import type { Ctx } from "./lib/context.ts";
import { openDb } from "./lib/db.ts";
import { loadDetectConfig } from "./lib/config.ts";
import { syncRoster } from "./roster/sync.ts";
import { crawlHourly, crawlDaily, refreshAll, fetchOrphans } from "./crawl/jobs.ts";
import { detectReport, quotaReport, rerunDetect } from "./report/reports.ts";
import { resolveEvents } from "./resolve/resolve.ts";
import type { ResolveOptions } from "./resolve/resolve.ts";
import { loadExtractConfig } from "./resolve/config.ts";
import { extract } from "./resolve/extract.ts";
import { resolveSummary, unresolvedStats, unresolvedList, exportUnresolved, resolveAudit } from "./report/resolve.ts";
import type { UnresolvedReason } from "./resolve/types.ts";

// 使い方: npm run cli -- <command> [options]

const HELP = `
コマンド（取得）:
  roster          Tier 1 の一覧を公式サイトと同期する（日次）
  crawl:hourly    RSS の差分 + playlistItems の一部 + 予定枠・配信中の状態更新（毎時）
  crawl:daily     全チャンネルの uploads 先頭 + メン限プレイリスト + 過去分の遡り（日次）
                  [--backfill-units N] で遡りの予算をその回だけ変える
  refresh         全枠の再生数・状態の取り直しとアーカイブ死活チェック（日次）
  report:detect   判定結果の集計と、誤検出・取りこぼしの候補を表示する [--limit N]
  report:quota    クォータ使用量を表示する [--days N]
  detect:rerun    語彙を変えたあと、保存済みタイトルで再判定する（API を使わない）
  detect:fetch    再判定で新たにヒットした動画の詳細を取り、WatchEvent にする（videos.list）

コマンド（名寄せ）:
  resolve         未処理の枠と、前回照会エラーだった枠を名寄せする
    --all           有効な枠をすべて再処理する（抽出ルールを直したあと。照会結果はキャッシュを使う）
    --reason R      未同定の理由が R の枠だけ再処理する（no_candidate / not_found / ambiguous / not_a_work / error）
    --video ID,...  指定した動画だけ再処理する
    --limit N       件数を絞る
  extract:test "タイトル"  タイトルから切り出される区間と話数を表示する（照会しない）
  resolve:summary 名寄せの件数・成功率・理由別の件数
  unresolved:stats  未同定を理由別に、頻出パターン順で表示する [--limit N]
  unresolved:list   未同定の一覧 [--reason R] [--limit N]
  unresolved:export 未同定を data/unresolved.json に書き出す（R2 に置くファイル）
  resolve:audit   誤同定の疑いがある同定を並べる [--limit N]

環境変数:
  YOUTUBE_API_KEY  YouTube Data API のキー（.env に書けば自動で読む）
  ANNICT_TOKEN     Annict の個人用アクセストークン（無ければ AniList と Wikipedia だけで名寄せする）
  DATA_DIR         SQLite と生レスポンスの置き場（既定 ./data）
`;

type Job = (ctx: Ctx) => Promise<void>;

async function main(): Promise<number> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      limit: { type: "string" },
      days: { type: "string" },
      "backfill-units": { type: "string" },
      all: { type: "boolean" },
      reason: { type: "string" },
      video: { type: "string" },
    },
  });
  const cmd = positionals[0];
  const limit = values.limit !== undefined ? Number(values.limit) : undefined;

  const resolveJob: Job = async (ctx) => {
    const opts: ResolveOptions = values.all
      ? { mode: "all", limit }
      : values.reason
        ? { mode: "reason", reason: values.reason as UnresolvedReason, limit }
        : values.video
          ? { mode: "videos", videoIds: values.video.split(","), limit }
          : { mode: "new", limit };
    ctx.summary.resolve = await runStep(ctx, `resolve (${opts.mode})`, () => resolveEvents(ctx, opts));
  };

  const JOBS: Record<string, { job: string; run: Job }> = {
    "roster": { job: "daily", run: syncRoster },
    "crawl:hourly": { job: "hourly", run: crawlHourly },
    "crawl:daily": { job: "daily", run: crawlDaily },
    "refresh": { job: "daily", run: refreshAll },
    "detect:fetch": { job: "daily", run: fetchOrphans },
    "resolve": { job: "resolve", run: resolveJob },
  };

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
    case "report:detect":
      console.log(detectReport(openDb(), loadDetectConfig(), limit ?? 20));
      return 0;
    case "report:quota":
      console.log(quotaReport(openDb(), Number(values.days ?? 7)));
      return 0;
    case "detect:rerun":
      console.log(rerunDetect(openDb(), loadDetectConfig()));
      return 0;
    case "extract:test": {
      const cfg = loadExtractConfig();
      for (const t of positionals.slice(1)) console.log(JSON.stringify(extract(t, cfg), null, 2));
      return 0;
    }
    case "resolve:summary":
      console.log(resolveSummary(openDb()));
      return 0;
    case "unresolved:stats":
      console.log(unresolvedStats(openDb(), loadExtractConfig(), limit ?? 10));
      return 0;
    case "unresolved:list":
      console.log(unresolvedList(openDb(), values.reason, limit ?? 50));
      return 0;
    case "unresolved:export":
      console.log(exportUnresolved(openDb()));
      return 0;
    case "resolve:audit":
      console.log(resolveAudit(openDb(), loadExtractConfig(), limit ?? 30));
      return 0;
    default:
      console.log(HELP);
      return cmd ? 1 : 0;
  }
}

process.exitCode = await main();
