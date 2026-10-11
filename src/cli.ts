import { parseArgs } from "node:util";
import { createCtx, finishCtx, runStep } from "./lib/context.ts";
import type { Ctx } from "./lib/context.ts";
import { openDb } from "./lib/db.ts";
import { loadDetectConfig, loadCrawlConfig } from "./lib/config.ts";
import { syncRoster } from "./roster/sync.ts";
import { crawlHourly, crawlDaily, refreshAll, fetchOrphans } from "./crawl/jobs.ts";
import { detectReport, quotaReport, rerunDetect } from "./report/reports.ts";
import { resolveEvents } from "./resolve/resolve.ts";
import type { ResolveOptions } from "./resolve/resolve.ts";
import { loadExtractConfig } from "./resolve/config.ts";
import { extract } from "./resolve/extract.ts";
import { resolveSummary, unresolvedStats, unresolvedList, exportUnresolved, resolveAudit } from "./report/resolve.ts";
import { seasonSample, unresolvedSample } from "./report/sample.ts";
import { aiQueue, aiQueueRoutes, aiApply, aiReport, aiRevoke } from "./report/ai.ts";
import { auditTypes, auditSample, auditCompare } from "./report/audit.ts";
import { assignSeasons } from "./resolve/series.ts";
import { persistRoutes, publishSummary } from "./resolve/routing.ts";
import { enrichWorks } from "./resolve/enrich.ts";
import { ResolveCache } from "./resolve/cache.ts";
import { AnnictClient } from "./resolve/sources/annict.ts";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./lib/paths.ts";
import { lookup } from "./report/lookup.ts";
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
    --all           有効な枠をすべて再処理する（抽出ルールを直したあと。照会結果はキャッシュを使う。期限切れの結果も使う）
    --refresh       再処理（--all・--reason・--video）でも、期限切れの照会結果は取り直す
    --reason R      未同定の理由が R の枠だけ再処理する（no_candidate / not_found / ambiguous / not_a_work / error）
    --video ID,...  指定した動画だけ再処理する
    --limit N       件数を絞る
  extract:test "タイトル"  タイトルから切り出される区間と話数を表示する（照会しない）
  resolve:summary 名寄せの件数・成功率・理由別の件数
  unresolved:stats  未同定を理由別に、頻出パターン順で表示する [--limit N]
  unresolved:list   未同定の一覧 [--reason R] [--limit N]
  unresolved:export 未同定を data/unresolved.json に書き出す（R2 に置くファイル）
  resolve:audit   誤同定の疑いがある同定を並べる [--limit N]
  resolve:sample  期の取り違えの検証用に、複数期のシリーズの枠を抽出して確認表を書き出す（data/review/）
                  [--n 60] [--seed S]。確認表の先頭に母集団・抽出・判定基準を書く
  unresolved:sample 未同定を理由ごとに抽出して分類用の確認表を書き出す（data/review/） [--reason not_found] [--n 100] [--seed S]
  lookup "語" ...  外部作品DB（Annict・AniList・Wikipedia・Wikidata）の照会結果を並べる（判断の確認用）
  resolve:series  視聴系列による期の割り当ての一覧を data/review/series-assign.md に書き出す（DB は変えない。確認用）

コマンド（AI の判定。人が起動する。定期実行のジョブからは呼ばない）:
  ai:queue        AI に回す型（extract.yaml の ai_routes）の枠のうち AI の判定が無いものを選び、候補を見せない待ち行列を data/ai/<batch>/ に書く
                  [--n 300] [--seed S] [--batch B（既定はシード）] [--type 型,...（ai_routes の代わり）] [--include-hold（保留の枠も入れる）] [--video ID,...（動画を指定する。判定し直し用）]
                  --reason R を付けると未同定の理由で選ぶ（ai-trial-1 の形。区間と注記を見せる）
  ai:apply PATH   判定のファイル（answers/*.json か decisions.json。フォルダならその中のすべて）を DB に入れる。resolve は上書きしない（確定）
  ai:report B     判定の根拠の一覧（report.md）と採点用の report.html を書く。採点の表は確度 high 以外・保留・特定できないを全部。
                  B をカンマでつなぐと複数の回を1つの表にまとめる（出力は data/ai/<回を _ でつないだ名前>/）
                  [--sample N --seed S（確度 high からシードで N 件を抜き取り）] [--include-high（確度 high も全部）]
                  [--exclude-scored F（採点済みの scores*.md を除いた残りを report-rest.html に）] [--video ID,…（必ず出す枠）]
  ai:revoke       判定を取り消して、ルールで名寄せし直す [--batch B] [--video ID,...]
  works:enrich    作品の属性（映像の種類・制作国・シリーズの名前）を外部DBから埋める [--all（全部埋め直す）]
  ai:status       サイトでの出し方（作品を付けて出す・枠として出す・出さない・AI の判定待ち）ごとの件数と、判定待ちの型の内訳

コマンド（型ごとの検証。ゲート2の決定。人が起動する）:
  audit:types     枠を同定の型に分け、型ごとの件数と目印の重なりを data/audit/types.md に書く（DB は変えない）
  audit:sample    型ごとに抽出し、AI に見せる待ち行列（タイトル・概要欄・サムネイルだけ）と封をしたルールの答えを
                  data/audit/<batch>/ に書き出す [--seed S（既定 audit-1）] [--batch B（既定はシード）]
                  [--type T,...（型か層を絞る。層は not_a_work_rule:スポーツ のように語の種類まで）]
                  [--exclude B,...（前の抽出で使った枠を除く）] [--n N（1層の件数を指定）]
  audit:compare B AI の答え（data/audit/<batch>/answers/*.json）とルールの答えを突き合わせ、不一致の一覧と型ごとの集計を書く

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
      refresh: { type: "boolean" },
      reason: { type: "string" },
      video: { type: "string" },
      n: { type: "string" },
      seed: { type: "string" },
      batch: { type: "string" },
      type: { type: "string" },
      exclude: { type: "string" },
      sample: { type: "string" },
      "exclude-scored": { type: "string" },
      "include-high": { type: "boolean" },
      "include-hold": { type: "boolean" },
    },
  });
  const cmd = positionals[0];
  const limit = values.limit !== undefined ? Number(values.limit) : undefined;

  const resolveJob: Job = async (ctx) => {
    const opts: ResolveOptions = values.all
      ? { mode: "all", limit, refresh: !!values.refresh }
      : values.reason
        ? { mode: "reason", reason: values.reason as UnresolvedReason, limit, refresh: !!values.refresh }
        : values.video
          ? { mode: "videos", videoIds: values.video.split(","), limit, refresh: !!values.refresh }
          : { mode: "new", limit };
    ctx.summary.resolve = await runStep(ctx, `resolve (${opts.mode})`, () => resolveEvents(ctx, opts));
    await recordRoutes(ctx);
  };

  // 枠の型を記録する（AI に回す型の枠は AI が確かめるまでサイトに出さない。src/resolve/route.ts の publishState）
  const recordRoutes = async (ctx: Ctx) => {
    ctx.summary.routes = await runStep(ctx, "resolve: 型分け", () => persistRoutes(ctx, loadExtractConfig()));
  };

  const JOBS: Record<string, { job: string; run: Job }> = {
    "roster": { job: "daily", run: syncRoster },
    "crawl:hourly": { job: "hourly", run: crawlHourly },
    "crawl:daily": { job: "daily", run: crawlDaily },
    "refresh": { job: "daily", run: refreshAll },
    "detect:fetch": { job: "daily", run: fetchOrphans },
    "resolve": { job: "resolve", run: resolveJob },
    "lookup": {
      job: "report",
      run: async (ctx) => {
        const r = await runStep(ctx, "lookup", () => lookup(ctx, loadExtractConfig(), positionals.slice(1), { limit: limit ?? 8 }));
        if (r) console.log(r);
      },
    },
    "resolve:series": {
      job: "report",
      run: async (ctx) => {
        const r = await runStep(ctx, "resolve:series", async () => {
          const cfg = loadExtractConfig();
          const token = process.env.ANNICT_TOKEN;
          if (!token) throw new Error("ANNICT_TOKEN が必要です（Annict のシリーズの全作品を取るため）");
          const annict = new AnnictClient(ctx.http, new ResolveCache(ctx.db, 30), token, cfg.annict);
          const s = await assignSeasons(ctx, cfg, annict, cfg.version, false);
          const dir = join(DATA_DIR, "review");
          mkdirSync(dir, { recursive: true });
          const path = join(dir, "series-assign.md");
          const head = [
            "# 視聴系列による期の割り当て（確認用の一覧）", "",
            "- 母集団: 一覧に出る枠のうち、同じ配信者 × 同じ区間で2枠以上あり、系統（同じ Annict シリーズで原題が区間で始まるテレビ・Web の7話以上の作品。総集編・新編集版を除く）に期が2つ以上ある系列の枠",
            "- 決め方は src/resolve/series.ts の先頭のコメント。「今」は DB の今の状態（resolve の後なら割り当て後）",
            `- 系列 ${s.runs}・枠 ${s.events}。期が決まった ${s.events - s.held}（${Object.entries(s.byRule).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join("・")}）・保留 ${s.held}`,
          ];
          writeFileSync(path, [...head, ...s.lines].join("\n"), "utf8");
          return `${head[head.length - 1]} → ${path}`;
        });
        if (r) console.log(r);
      },
    },
    "ai:queue": {
      job: "report",
      run: async (ctx) => {
        const seed = values.seed ?? "ai-1";
        const batch = values.batch ?? seed;
        // --reason を付けたときは未同定の理由で選ぶ（ai-trial-1 の形）。付けなければ AI に回す型の枠から候補を見せない形で選ぶ
        const r = await runStep(ctx, "ai:queue", () => values.reason
          ? aiQueue(ctx, loadExtractConfig(), { reason: values.reason, n: Number(values.n ?? 100), seed, batch })
          : aiQueueRoutes(ctx, loadExtractConfig(), {
            batch, seed, n: Number(values.n ?? 300), routes: values.type?.split(","), includeHold: !!values["include-hold"],
            ...(values.video ? { videos: values.video.split(",") } : {}),
          }));
        if (r) console.log(r);
      },
    },
    "ai:apply": {
      job: "ai",
      run: async (ctx) => {
        const file = positionals[1];
        if (!file) throw new Error("判定のファイルを指定してください");
        const r = await runStep(ctx, "ai:apply", () => aiApply(ctx, loadExtractConfig(), file));
        if (r) console.log(r);
      },
    },
    "ai:report": {
      job: "report",
      run: async (ctx) => {
        const batch = positionals[1] ?? values.batch;
        if (!batch) throw new Error("batch を指定してください");
        console.log(aiReport(ctx, batch, {
          ...(values.sample !== undefined ? { sample: Number(values.sample) } : {}), ...(values.seed ? { seed: values.seed } : {}),
          ...(values["exclude-scored"] ? { excludeScored: values["exclude-scored"].split(",") } : {}),
          ...(values.video ? { videos: values.video.split(",") } : {}),
          ...(values["include-high"] ? { includeHigh: true } : {}),
        }));
      },
    },
    "ai:revoke": {
      job: "ai",
      run: async (ctx) => {
        const videos = aiRevoke(ctx, { batch: values.batch, videos: values.video?.split(",") });
        console.log(`取り消した判定 ${videos.length} 件。ルールで名寄せし直します`);
        if (videos.length) {
          await runStep(ctx, "resolve (videos)", () => resolveEvents(ctx, { mode: "videos", videoIds: videos }));
          await recordRoutes(ctx);
        }
      },
    },
    "audit:types": {
      job: "report",
      run: async (ctx) => {
        const r = await runStep(ctx, "audit:types", () => auditTypes(ctx, loadExtractConfig()));
        if (r) console.log(r);
      },
    },
    "audit:sample": {
      job: "report",
      run: async (ctx) => {
        const seed = values.seed ?? "audit-1";
        const r = await runStep(ctx, "audit:sample", () =>
          auditSample(ctx, loadExtractConfig(), {
            seed, batch: values.batch ?? seed, only: values.type?.split(","), exclude: values.exclude?.split(","),
            ...(values.n ? { n: Number(values.n) } : {}),
          }));
        if (r) console.log(r);
      },
    },
    "audit:compare": {
      job: "report",
      run: async (ctx) => {
        const batch = positionals[1] ?? values.batch;
        if (!batch) throw new Error("batch を指定してください");
        const r = await runStep(ctx, "audit:compare", () => auditCompare(ctx, loadExtractConfig(), batch));
        if (r) console.log(r);
      },
    },
    "resolve:sample": {
      job: "report",
      run: async (ctx) => {
        const r = await runStep(ctx, "resolve:sample", () =>
          seasonSample(ctx, loadExtractConfig(), { n: Number(values.n ?? 60), seed: values.seed ?? "season-1" }));
        if (r) console.log(r);
      },
    },
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
    case "ai:status": {
      const s = publishSummary({ db: openDb(), crawlCfg: loadCrawlConfig() } as unknown as Ctx, loadExtractConfig());
      const label: Record<string, string> = { work: "作品を付けて出す", frame: "枠として出す", hidden: "出さない（作品ではない）", pending_ai: "AI の判定待ち（出さない）" };
      console.log("サイトでの出し方（一覧に出る枠）");
      for (const [k, v] of Object.entries(s.states)) console.log(`  ${label[k] ?? k}	${v}`);
      console.log("AI の判定待ちの内訳（型）");
      for (const [k, v] of Object.entries(s.pendingByRoute).sort((a, b) => b[1] - a[1])) console.log(`  ${k}	${v}`);
      if (s.noRoute) console.log(`型が記録されていない枠 ${s.noRoute}（resolve を流すと記録される）`);
      return 0;
    }
    case "works:enrich": {
      const ctx = createCtx("report");
      try {
        const r = await runStep(ctx, "works:enrich", () => enrichWorks(ctx, loadExtractConfig(), { all: !!values.all }));
        if (r) console.log(`作品の属性 ${r.updated} 件（${Object.entries(r.kinds).map(([k, v]) => `${k} ${v}`).join("・")}）・制作国が分からない ${r.noCountry}・同名の Wikipedia の記事で埋めた制作国 ${r.countryViaWikipedia}・同じシリーズの作品で埋めた制作国 ${r.countryViaSeries}・シリーズの名前 ${r.series}`);
      } finally {
        finishCtx(ctx);
      }
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
    case "unresolved:sample":
      console.log(unresolvedSample(openDb(), values.reason ?? "not_found", { n: Number(values.n ?? 100), seed: values.seed ?? "nf-1" }));
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
