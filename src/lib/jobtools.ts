import { createHash } from "node:crypto";
import { statSync, existsSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";

// 日次のワークフローが使う小さな道具（docs/workflows.md 2-6・2-9・5-2）。DB と API を書かない。

/** 日本時間の日付（YYYY-MM-DD） */
export function jstDate(d: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

/**
 * サイトの中身の指紋（docs/workflows.md 2-6）。site-data.json から毎回変わる generatedAt を除いた sha256。
 * commit を渡すと「データの指紋・コミット・日本時間の日付」をまとめた sha256 にする（ランキングの期間がビルドの日付で切れるので、1日1回は作り直す）
 */
export function siteFingerprint(siteDataJson: string, opts: { commit?: string; date?: string } = {}): { data: string; fingerprint: string } {
  const j = JSON.parse(siteDataJson) as Record<string, unknown>;
  delete j.generatedAt;
  const data = createHash("sha256").update(JSON.stringify(j)).digest("hex");
  if (!opts.commit) return { data, fingerprint: data };
  const fingerprint = createHash("sha256").update(`${data}\n${opts.commit}\n${opts.date ?? jstDate()}`).digest("hex");
  return { data, fingerprint };
}

/**
 * 保険の cron で日次を流すか（docs/workflows.md 5-2）。R2 の DB のメタデータの written-at と writer だけで決める（DB を落とす前に判断する）。
 * 日次（writer = daily）が hours 時間以内に書いていれば流さない。値が無い・読めない・未来の時刻なら流す（流して困るのは同じ日の2回目だけで、指紋で飛ぶ）
 */
export function jobDue(meta: { writtenAt?: string; writer?: string }, opts: { hours?: number; now?: Date } = {}): { due: boolean; reason: string } {
  const hours = opts.hours ?? 20;
  const now = opts.now ?? new Date();
  if (!meta.writtenAt) return { due: true, reason: "written-at が無い" };
  const t = Date.parse(meta.writtenAt);
  if (!Number.isFinite(t)) return { due: true, reason: `written-at を読めない（${meta.writtenAt}）` };
  if (meta.writer !== "daily") return { due: true, reason: `最後に書いたのは日次でない（writer=${meta.writer ?? "無い"}）` };
  const ago = (now.getTime() - t) / 3_600_000;
  if (ago < -0.1) return { due: true, reason: `written-at が未来（${meta.writtenAt}）` };
  if (ago < hours) return { due: false, reason: `日次が ${ago.toFixed(1)} 時間前に書いた（${hours} 時間以内）` };
  return { due: true, reason: `日次が書いたのは ${ago.toFixed(1)} 時間前（${hours} 時間を過ぎた）` };
}

interface RunRow {
  id: string;
  job: string;
  started_at: string;
  finished_at: string | null;
  status: string;
  summary: string | null;
}

/** 表のセルと、ワークフローのコマンド（::warning::）の値に入れられる形にする */
function cell(s: string, max = 300): string {
  const t = s.replace(/\s+/g, " ").trim();
  return (t.length > max ? `${t.slice(0, max)}…` : t).replace(/\|/g, "\\|");
}

function command(s: string): string {
  return s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

/**
 * 要約の値から数だけを平らに取り出す（a.b=1）。文字列は出さない（公開リポジトリのログに概要欄・判定の根拠・作品名を出さない）。配列は件数
 */
export function numericLeaves(v: unknown, prefix = "", depth = 0, out: string[] = []): string[] {
  if (typeof v === "number" || typeof v === "boolean") out.push(`${prefix}=${v}`);
  else if (Array.isArray(v)) out.push(`${prefix}=${v.length}件`);
  else if (v && typeof v === "object" && depth < 3) {
    for (const [k, x] of Object.entries(v)) numericLeaves(x, prefix ? `${prefix}.${k}` : k, depth + 1, out);
  }
  return out;
}

/** 要約の中でステップの結果として出さないもの（下の行で別に出す・ローカルのパス） */
const SKIP_KEYS = new Set(["quota", "errors", "raw_path", "raw_responses"]);

/**
 * この回の runs の行の要約（docs/workflows.md 2-9）。$GITHUB_STEP_SUMMARY に書く Markdown と、ログに出す ::warning:: の行を返す。
 * 出すのは件数・状態・エラーの文（300字まで）・クォータ・DB の大きさだけ。summary の文字列（概要欄・作品名・判定の根拠になりうる）は出さない
 */
export function runsSummary(db: DatabaseSync, since: Date, opts: { dbPath?: string; now?: Date } = {}): { markdown: string; warnings: string[] } {
  const rows = (db.prepare("SELECT id, job, started_at, finished_at, status, summary FROM runs ORDER BY started_at").all() as unknown as RunRow[])
    .filter((r) => Date.parse(r.started_at) >= since.getTime());
  const md: string[] = [`## 実行記録（${since.toISOString()} 以降・${rows.length} 回）`, ""];
  const warnings: string[] = [];
  if (rows.length) {
    md.push("| 開始（UTC） | job | 状態 | 秒 | エラー | クォータ（回／今日） |", "| --- | --- | --- | --- | --- | --- |");
  }
  let todayUnits: number | null = null;
  const details: string[] = [];
  for (const r of rows) {
    let s: Record<string, unknown> = {};
    try {
      s = r.summary ? (JSON.parse(r.summary) as Record<string, unknown>) : {};
    } catch {
      s = {};
    }
    const errors = Array.isArray(s.errors) ? (s.errors as { step?: string; error?: string }[]) : [];
    const q = (s.quota ?? {}) as { run_units?: number; today_units?: number };
    if (typeof q.today_units === "number") todayUnits = q.today_units;
    const secs = r.finished_at ? ((Date.parse(r.finished_at) - Date.parse(r.started_at)) / 1000).toFixed(0) : "—";
    md.push(`| ${r.started_at.slice(0, 19)} | ${r.job} | ${r.status} | ${secs} | ${errors.length} | ${q.run_units ?? "—"}／${q.today_units ?? "—"} |`);
    const steps = Object.entries(s).filter(([k]) => !SKIP_KEYS.has(k));
    const lines = steps.map(([k, v]) => `- ${cell(k, 60)}: ${cell(numericLeaves(v).join(", ") || "—", 600)}`);
    for (const e of errors) lines.push(`- **エラー** ${cell(e.step ?? "?", 80)}: ${cell(e.error ?? "")}`);
    if (lines.length) details.push(`### ${r.job} ${r.id}（${r.status}）`, "", ...lines, "");
    if (r.status !== "ok") {
      const what = r.status === "running" ? "終わっていない（プロセスが止まった・殺された）" : `${r.status}（エラー ${errors.length} 件）`;
      warnings.push(`::warning title=${command(`${r.job} ${r.status}`)}::${command(`${r.id} が ${what}${errors[0] ? `: ${cell(errors[0].step ?? "", 80)}: ${cell(errors[0].error ?? "", 200)}` : ""}`)}`);
    }
  }
  md.push("");
  if (todayUnits !== null) md.push(`- YouTube のクォータ: 今日（太平洋時間）${todayUnits} ユニット`);
  if (opts.dbPath && existsSync(opts.dbPath)) md.push(`- DB の大きさ: ${(statSync(opts.dbPath).size / 1048576).toFixed(1)}MB`);
  md.push("", ...details);
  return { markdown: md.join("\n"), warnings };
}
