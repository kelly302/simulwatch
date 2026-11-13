import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import type { Dirent } from "node:fs";
import { join, relative } from "node:path";

// 手元の data/ に残る YouTube の API のデータ（30日の決まり。規約 III.E.4。決定 D-12）の一覧。retention:files。
// 既定は一覧だけ。消すのは --delete のときだけで、消すのは「中のファイルが全部 days 日より古い」項目だけ（一部だけ古い項目は消さずに一覧に出す）。
//
// 区分（data/ の直下からの場所）:
//   raw       raw/<日付>/（生レスポンス。src/lib/rawlog.ts が書く。CI のランナーは毎回まっさらで、R2 の raw/ はライフサイクルで消す）
//   db        db.*.sqlite と -wal・-shm・-journal（DB の写し。本体の db.sqlite は入れない）
//   ai        ai/<batch>/ と ai-inbox/ の中（AI の判定の作業フォルダ。題名・概要欄・コメント欄・サムネイルの画像）。ai/quota.json（ユニットの数だけ）は入れない
//   audit・review・analysis   それぞれのフォルダの中の項目（題名・概要欄の抜き書き）
//   log       直下の *.log（ジョブの出力）
//   export    直下の unresolved.json（unresolved:export。題名・区間を含む）
//   site      site/site-data.json（site:data。題名・サムネの URL・再生数を含む。site:data を流せば作り直す）
// それ以外の直下の項目（db.sqlite・site/og-cache（文字だけの og:image）・job/ など）は「対象外」に一覧だけ出し、--delete でも消さない

export type FileCategory = "raw" | "db" | "ai" | "audit" | "review" | "analysis" | "log" | "export" | "site";
export const FILE_CATEGORIES: FileCategory[] = ["raw", "db", "ai", "audit", "review", "analysis", "log", "export", "site"];

export interface FileEntry {
  category: FileCategory | "other";
  /** data/ からの場所（区切りは /）。db はファイルの組の先頭（db.x.sqlite） */
  path: string;
  /** 消すときに消すもの（絶対パス） */
  targets: string[];
  bytes: number;
  files: number;
  oldest: number | null;
  newest: number | null;
  /** over: 中のファイルが全部 days 日より古い / partial: 一部が古い / fresh: 全部新しい / empty: ファイルが無い */
  status: "over" | "partial" | "fresh" | "empty";
}

interface Walk { bytes: number; files: number; oldest: number | null; newest: number | null }

function walk(path: string): Walk {
  const st = statSync(path);
  if (!st.isDirectory()) return { bytes: st.size, files: 1, oldest: st.mtimeMs, newest: st.mtimeMs };
  const out: Walk = { bytes: 0, files: 0, oldest: null, newest: null };
  for (const d of readdirSync(path, { withFileTypes: true })) {
    const w = walk(join(path, d.name));
    out.bytes += w.bytes;
    out.files += w.files;
    if (w.oldest !== null) out.oldest = out.oldest === null ? w.oldest : Math.min(out.oldest, w.oldest);
    if (w.newest !== null) out.newest = out.newest === null ? w.newest : Math.max(out.newest, w.newest);
  }
  return out;
}

function entry(dataDir: string, category: FileEntry["category"], targets: string[], cutoff: number): FileEntry {
  const ws = targets.map(walk);
  const w: Walk = {
    bytes: ws.reduce((a, x) => a + x.bytes, 0), files: ws.reduce((a, x) => a + x.files, 0),
    oldest: ws.reduce<number | null>((a, x) => (x.oldest === null ? a : a === null ? x.oldest : Math.min(a, x.oldest)), null),
    newest: ws.reduce<number | null>((a, x) => (x.newest === null ? a : a === null ? x.newest : Math.max(a, x.newest)), null),
  };
  const status = w.newest === null ? "empty" : w.newest < cutoff ? "over" : w.oldest! < cutoff ? "partial" : "fresh";
  return { category, path: relative(dataDir, targets[0]!).replaceAll("\\", "/"), targets, ...w, status };
}

const children = (dir: string): Dirent[] => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }) : []).sort((a, b) => a.name.localeCompare(b.name));

/** data/ の項目を区分ごとに並べる。cutoff は「これより前に書いたファイルは古い」（ミリ秒） */
export function listDataFiles(dataDir: string, cutoff: number): FileEntry[] {
  const out: FileEntry[] = [];
  const known = new Set<string>();
  // フォルダの中の項目ごと。category が null の項目は入れない
  const sub = (name: string, category: (n: string) => FileEntry["category"] | null) => {
    known.add(name);
    for (const d of children(join(dataDir, name))) {
      const c = category(d.name);
      if (c) out.push(entry(dataDir, c, [join(dataDir, name, d.name)], cutoff));
    }
  };
  sub("raw", () => "raw");
  sub("ai", (n) => (n === "quota.json" ? null : "ai"));
  sub("ai-inbox", () => "ai");
  sub("audit", () => "audit");
  sub("review", () => "review");
  sub("analysis", () => "analysis");
  sub("site", (n) => (n === "site-data.json" ? "site" : "other"));
  const top = children(dataDir).filter((d) => !known.has(d.name));
  // DB の写し（本体の db.sqlite とその -wal・-shm は入れない）。-wal・-shm・-journal は同じ組にまとめる
  const live = new Set(["db.sqlite", "db.sqlite-wal", "db.sqlite-shm", "db.sqlite-journal"]);
  const dbBase = (n: string) => /^db\..+\.sqlite(-wal|-shm|-journal)?$/.test(n) && !live.has(n) ? n.replace(/-(wal|shm|journal)$/, "") : null;
  const groups = new Map<string, string[]>();
  for (const d of top) {
    const b = d.isFile() ? dbBase(d.name) : null;
    if (b) groups.set(b, [...(groups.get(b) ?? []), join(dataDir, d.name)]);
  }
  for (const [b, paths] of [...groups].sort((a, z) => a[0].localeCompare(z[0]))) {
    out.push(entry(dataDir, "db", [join(dataDir, b), ...paths.filter((p) => p !== join(dataDir, b))].filter((p) => existsSync(p)), cutoff));
  }
  for (const d of top) {
    if (d.isFile() && dbBase(d.name)) continue;
    const c = d.isFile() && d.name.endsWith(".log") ? "log" : d.isFile() && d.name === "unresolved.json" ? "export" : "other";
    out.push(entry(dataDir, c, [join(dataDir, d.name)], cutoff));
  }
  return out;
}

/** 中のファイルが全部古い項目（over）だけを消す。一部だけ古い項目・対象外は消さない（呼ぶ側が区分で絞る） */
export function deleteEntries(entries: FileEntry[]): { deleted: FileEntry[]; errors: string[] } {
  const deleted: FileEntry[] = [];
  const errors: string[] = [];
  for (const e of entries) {
    if (e.status !== "over" || e.category === "other") continue;
    try {
      for (const t of e.targets) rmSync(t, { recursive: true, force: true });
      deleted.push(e);
    } catch (err) {
      errors.push(`${e.path}: ${(err as Error).message}`);
    }
  }
  return { deleted, errors };
}

const mb = (n: number) => `${(n / 1_048_576).toFixed(1)}MiB`;
const day = (t: number | null) => (t === null ? "-" : new Date(t + 9 * 3_600_000).toISOString().slice(0, 10));
const STATUS: Record<FileEntry["status"], string> = { over: "全部が古い", partial: "一部が古い", fresh: "新しい", empty: "空" };

/** 一覧の Markdown（区分ごとの合計と、項目ごとの行。日付は日本時間） */
export function formatFiles(entries: FileEntry[], o: { days: number; cutoff: number; dataDir: string }): string {
  const lines = [
    `# 手元のファイル（${o.dataDir}）`, "",
    `- 古い = ${o.days}日より前に書いた（ファイルの更新日時が ${day(o.cutoff)} より前。日本時間）。フォルダは中のファイルの古い・新しいで見る`,
    "- 「全部が古い」だけが --delete で消える。「一部が古い」と「対象外」は消さない", "",
    "| 区分 | 項目 | 全部が古い | 一部が古い | 新しい | 合計の大きさ | 全部が古いの大きさ |", "|---|---|---|---|---|---|---|",
  ];
  for (const c of [...FILE_CATEGORIES, "other" as const]) {
    const es = entries.filter((e) => e.category === c);
    if (!es.length) continue;
    const n = (s: FileEntry["status"]) => es.filter((e) => e.status === s).length;
    lines.push(`| ${c === "other" ? "対象外" : c} | ${es.length} | ${n("over")} | ${n("partial")} | ${n("fresh") + n("empty")} | ${mb(es.reduce((a, e) => a + e.bytes, 0))} | ${mb(es.filter((e) => e.status === "over").reduce((a, e) => a + e.bytes, 0))} |`);
  }
  lines.push("", "| 区分 | 場所 | 状態 | 大きさ | ファイル | いちばん古い | いちばん新しい |", "|---|---|---|---|---|---|---|");
  for (const e of entries) lines.push(`| ${e.category === "other" ? "対象外" : e.category} | ${e.path} | ${STATUS[e.status]} | ${mb(e.bytes)} | ${e.files} | ${day(e.oldest)} | ${day(e.newest)} |`);
  return lines.join("\n");
}
