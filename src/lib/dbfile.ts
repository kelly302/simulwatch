import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip, createGunzip } from "node:zlib";
import { join } from "node:path";
import { schemaVersion } from "./db.ts";
import { nowIso } from "./time.ts";

// 日次のジョブの DB の検査（db:check）と梱包（db:pack）。docs/workflows.md の 2-3・2-4。
// R2 との出し入れ（aws）はワークフローの側で、ここはローカルのファイルだけを扱う。
// どちらもワークフローを止めるための道具なので、外れたら終了コード 1 を返す（ほかのジョブの「終了コードは 0」の例外）。

/**
 * 行を消さない表（設計で行を消さないと決めている表）。書き戻すときに取得したときより減っていたら止める。
 * candidates は docs/ai-ops.md 3-1 で作る表。DB に無いあいだは数えない
 */
export const KEEP_TABLES = ["streamers", "watch_events", "videos_seen", "ai_decisions", "unresolved", "work_public_keys", "candidates"];

/**
 * DB の gzip に付けるメタデータ。S3 のオブジェクトのメタデータにそのまま載せるので、名前は小文字とハイフン、値はすべて ASCII の文字列
 * （合計 2KB まで）。行数はカンマと = を使わずに1つの値にまとめる（`aws s3 cp --metadata` の短い書き方でも崩れない）
 */
export interface DbMeta {
  format: string;
  /** gzip したファイルの sha256（16進） */
  sha256: string;
  "user-version": string;
  /** 行を消さない表の行数。"streamers:282;watch_events:7700" */
  rows: string;
  "run-id": string;
  /** 書いたワークフロー（daily / publish / manual）。保険の cron（job:due）は daily だけを数える */
  writer: string;
  /** 書いた時刻（UTC の ISO 8601） */
  "written-at": string;
}

export interface CheckResult {
  ok: boolean;
  lines: string[];
}

export function encodeRows(rows: Record<string, number>): string {
  return Object.entries(rows).map(([t, n]) => `${t}:${n}`).join(";");
}

export function decodeRows(s: string | undefined): Record<string, number> | null {
  if (!s) return null;
  const out: Record<string, number> = {};
  for (const part of s.split(";")) {
    const m = /^([a-z_]+):(\d+)$/.exec(part);
    if (!m) return null;
    out[m[1]!] = Number(m[2]);
  }
  return out;
}

/** メタデータの JSON を読む。`aws s3api head-object` の出力そのもの（{"Metadata": {...}}）でも、Metadata の中身だけでもよい */
export function readMeta(path: string): Partial<DbMeta> {
  const j = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const m = (j.Metadata && typeof j.Metadata === "object" ? j.Metadata : j) as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(m)) if (typeof v === "string" || typeof v === "number") out[k.toLowerCase()] = String(v);
  return out as Partial<DbMeta>;
}

export async function sha256File(path: string): Promise<string> {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(path)) h.update(chunk as Buffer);
  return h.digest("hex");
}

/**
 * 既にある DB をマイグレーションせずに開く。無い・空なら null（openDb は無いと空の DB を作ってマイグレーションするので使わない）。
 * 読み取り専用では開かない（WAL の DB は -shm を作れないと開けないことがある。docs/workflows.md 12）
 */
export function openExisting(path: string): DatabaseSync | null {
  if (!existsSync(path) || statSync(path).size === 0) return null;
  const db = new DatabaseSync(path);
  db.exec("PRAGMA busy_timeout = 5000");
  return db;
}

function tableExists(db: DatabaseSync, name: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}

export function countKeepTables(db: DatabaseSync): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of KEEP_TABLES) {
    if (!tableExists(db, t)) continue;
    out[t] = (db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get() as { n: number }).n;
  }
  return out;
}

function userVersion(db: DatabaseSync): number {
  return (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
}

/** integrity_check / quick_check の結果。ok でなければ最初の数行を返す */
function sqliteCheck(db: DatabaseSync, pragma: "integrity_check" | "quick_check"): string | null {
  const rows = db.prepare(`PRAGMA ${pragma}`).all() as Record<string, string>[];
  const msgs = rows.map((r) => Object.values(r)[0]);
  return msgs.length === 1 && msgs[0] === "ok" ? null : msgs.slice(0, 5).join(" / ");
}

export interface CheckOptions {
  db: string;
  /** R2 から落とした gzip（sha256 を照合する） */
  gz?: string;
  /** R2 のオブジェクトのメタデータ（head-object の出力） */
  expect?: string;
  /** 手動の accept_db: sha256・行数の照合を飛ばし、ファイル・integrity_check・user_version だけを見る */
  accept?: boolean;
  /** 開いた DB の実際の値（行数など）を書く先。db:pack の --against に渡す */
  observed?: string;
}

/**
 * 取得した DB の検査（docs/workflows.md 2-3）。1つでも外れたら ok=false。
 * 外れても止まらずに残りも見て、全部の結果を lines に返す（どれで止まったかをログで分かるように）
 */
export async function dbCheck(o: CheckOptions): Promise<CheckResult> {
  const lines: string[] = [];
  let ok = true;
  const pass = (s: string) => lines.push(`ok   ${s}`);
  const fail = (s: string) => { ok = false; lines.push(`FAIL ${s}`); };

  let meta: Partial<DbMeta> | null = null;
  if (o.expect) {
    try {
      meta = readMeta(o.expect);
    } catch (e) {
      (o.accept ? (s: string) => lines.push(`skip ${s}`) : fail)(`メタデータを読めない（${o.expect}: ${(e as Error).message}）`);
    }
  } else if (!o.accept) {
    fail("--expect（メタデータ）が無い");
  }

  // gzip の sha256（accept のときは見ない）
  if (!o.accept) {
    if (!o.gz || !existsSync(o.gz)) fail(`gzip が無い（${o.gz ?? "--gz を指定していない"}）`);
    else if (meta) {
      const sha = await sha256File(o.gz);
      if (!meta.sha256) fail("メタデータに sha256 が無い");
      else if (sha !== meta.sha256) fail(`sha256 が合わない（メタデータ ${meta.sha256.slice(0, 12)}… / gzip ${sha.slice(0, 12)}…）`);
      else pass(`sha256 ${sha.slice(0, 12)}…`);
    }
  }

  let db: DatabaseSync | null = null;
  try {
    db = openExisting(o.db);
    if (!db) fail(`DB が無いか空（${o.db}）。作らない`);
  } catch (e) {
    fail(`DB を開けない（${(e as Error).message}）`);
  }
  if (!db) return { ok: false, lines };
  try {
    pass(`DB がある（${(statSync(o.db).size / 1048576).toFixed(1)}MB）`);
    let bad: string | null;
    try {
      bad = sqliteCheck(db, "integrity_check");
    } catch (e) {
      bad = (e as Error).message;
    }
    if (bad) {
      fail(`integrity_check: ${bad}`);
      return { ok: false, lines };
    }
    pass("integrity_check");

    const uv = userVersion(db);
    if (uv > schemaVersion()) fail(`user_version ${uv} がコードのマイグレーションの数 ${schemaVersion()} より大きい（新しいコードで作った DB）`);
    else pass(`user_version ${uv}（コード ${schemaVersion()}）`);

    const rows = countKeepTables(db);
    if (!o.accept && meta) {
      if (meta["user-version"] !== undefined && Number(meta["user-version"]) !== uv) fail(`user_version がメタデータ（${meta["user-version"]}）と違う（${uv}）`);
      const want = decodeRows(meta.rows);
      if (!want) fail(`メタデータの行数を読めない（${meta.rows ?? "無い"}）`);
      else {
        const diffs = Object.entries(want).filter(([t, n]) => rows[t] !== n).map(([t, n]) => `${t} ${n} → ${rows[t] ?? "表が無い"}`);
        if (diffs.length) fail(`行数がメタデータと違う: ${diffs.join("・")}`);
        else pass(`行数 ${encodeRows(rows)}`);
      }
    } else {
      lines.push(`skip sha256・行数の照合（--accept）。行数 ${encodeRows(rows)}`);
    }
    if (o.observed) {
      const obs: Partial<DbMeta> = { format: "1", "user-version": String(uv), rows: encodeRows(rows), ...(meta?.sha256 ? { sha256: meta.sha256 } : {}) };
      writeFileSync(o.observed, JSON.stringify(obs, null, 2) + "\n", "utf8");
    }
  } finally {
    db.close();
  }
  return { ok, lines };
}

export interface PackOptions {
  db: string;
  /** 取得したときの値（db:check の --observed か、R2 のメタデータ）。行を消さない表の行数をこれと比べる */
  against?: string;
  /** 1回目（R2 にまだ DB が無い）だけ。比べる相手なしで梱包する */
  initial?: boolean;
  out: string;
  runId: string;
  writer: string;
}

export interface PackResult extends CheckResult {
  meta?: DbMeta;
  gzPath?: string;
}

/**
 * 書き戻す前の後始末（docs/workflows.md 2-4）。WAL を本体に書き戻す → quick_check → 行を消さない表が減っていないか → gzip → メタデータ。
 * 外れたら out/ に何も残さない（壊れた DB で R2 の正を上書きしない）
 */
export async function dbPack(o: PackOptions): Promise<PackResult> {
  const lines: string[] = [];
  let ok = true;
  const pass = (s: string) => lines.push(`ok   ${s}`);
  const fail = (s: string) => { ok = false; lines.push(`FAIL ${s}`); };
  let against: Partial<DbMeta> | null = null;
  if (o.against) {
    try {
      against = readMeta(o.against);
    } catch (e) {
      fail(`比べる相手を読めない（${o.against}: ${(e as Error).message}）`);
      return { ok, lines };
    }
  } else if (!o.initial) {
    fail("--against（取得したときの値）も --initial も無い");
    return { ok, lines };
  }

  // 前の回の出力は消す（外れたときに古いファイルを書き戻さないように）。比べる相手が out/meta.json でもよいように、読んだあとで消す
  mkdirSync(o.out, { recursive: true });
  const gzPath = join(o.out, "db.sqlite.gz");
  const metaPath = join(o.out, "meta.json");
  for (const p of [gzPath, metaPath, `${gzPath}.tmp`]) rmSync(p, { force: true });

  let db: DatabaseSync | null;
  try {
    db = openExisting(o.db);
  } catch (e) {
    fail(`DB を開けない（${(e as Error).message}）`);
    return { ok, lines };
  }
  if (!db) {
    fail(`DB が無いか空（${o.db}）`);
    return { ok, lines };
  }
  let uv: number;
  let rows: Record<string, number>;
  try {
    // プロセスが殺されて WAL が残っていても、開き直したここで戻る
    const cp = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as { busy: number } | undefined;
    if (cp && cp.busy !== 0) {
      fail("checkpoint が終わらない（ほかに DB を開いているものがある）");
      return { ok, lines };
    }
    let bad: string | null;
    try {
      bad = sqliteCheck(db, "quick_check");
    } catch (e) {
      bad = (e as Error).message;
    }
    if (bad) {
      fail(`quick_check: ${bad}`);
      return { ok, lines };
    }
    pass("checkpoint・quick_check");
    uv = userVersion(db);
    if (uv > schemaVersion()) fail(`user_version ${uv} がコードのマイグレーションの数 ${schemaVersion()} より大きい`);
    rows = countKeepTables(db);
  } finally {
    db.close();
  }

  if (against) {
    const before = decodeRows(against.rows);
    if (!before) fail(`比べる相手の行数を読めない（${against.rows ?? "無い"}）`);
    else {
      const dec = Object.entries(before).filter(([t, n]) => (rows[t] ?? -1) < n).map(([t, n]) => `${t} ${n} → ${rows[t] ?? "表が無い"}`);
      if (dec.length) fail(`行を消さない表の行が減った: ${dec.join("・")}`);
      else pass(`行が減っていない（${encodeRows(rows)}）`);
    }
    if (against["user-version"] !== undefined && uv < Number(against["user-version"])) fail(`user_version が下がった（${against["user-version"]} → ${uv}）`);
  } else {
    lines.push(`skip 行数の比較（--initial）。行数 ${encodeRows(rows)}`);
  }

  // 開いた接続を閉じると -wal は消える。残っていれば中身が gzip に入らないので止める
  const wal = `${o.db}-wal`;
  if (existsSync(wal) && statSync(wal).size > 0) fail(`-wal が空でない（${statSync(wal).size} バイト）`);
  else pass("-wal が無いか空");
  if (!ok) return { ok, lines };

  // gzip しながら元の DB の sha256 を取り、gzip を展開した sha256 と比べる（梱包そのものの壊れを書き戻す前に見つける）
  const srcHash = createHash("sha256");
  const gzHash = createHash("sha256");
  const tap = (h: ReturnType<typeof createHash>) => new Transform({ transform(chunk, _e, cb) { h.update(chunk); cb(null, chunk); } });
  await pipeline(createReadStream(o.db), tap(srcHash), createGzip({ level: 6 }), tap(gzHash), createWriteStream(`${gzPath}.tmp`));
  const srcSha = srcHash.digest("hex");
  const sha = gzHash.digest("hex");
  const backHash = createHash("sha256");
  await pipeline(createReadStream(`${gzPath}.tmp`), createGunzip(), tap(backHash), async function* (src) { for await (const _ of src) { /* 読み捨てる */ } });
  if (backHash.digest("hex") !== srcSha) {
    rmSync(`${gzPath}.tmp`, { force: true });
    fail("gzip を展開した中身が元の DB と合わない");
    return { ok, lines };
  }
  renameSync(`${gzPath}.tmp`, gzPath);
  const meta: DbMeta = {
    format: "1", sha256: sha, "user-version": String(uv), rows: encodeRows(rows),
    "run-id": o.runId, writer: o.writer, "written-at": nowIso(),
  };
  writeFileSync(metaPath, JSON.stringify(meta, null, 2) + "\n", "utf8");
  pass(`gzip ${(statSync(gzPath).size / 1048576).toFixed(1)}MB sha256 ${sha.slice(0, 12)}… → ${gzPath}・${metaPath}`);
  return { ok, lines, meta, gzPath };
}
