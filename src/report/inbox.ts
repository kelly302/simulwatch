import { spawnSync } from "node:child_process";
import {
  copyFileSync, createReadStream, createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, rmdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { dbCheck } from "../lib/dbfile.ts";
import { nowIso } from "../lib/time.ts";
import type { ApplyProblemKind, ApplyResult } from "./ai.ts";
import { aiCheck, batchAnswerFiles } from "./ai.ts";

// AI の判定の答えの受け箱（R2 の ai/inbox/）との出し入れ。docs/workflows.md の 6・docs/ai-ops.md の 2・2-1。
//
//   ai:ingest  （日次のジョブ）受け箱の batch を古い順に5つまで取り、aiApply で入れ、batch ごとの結果と「どこへ移すか」を JSON に書く。
//              移すのは DB の書き戻しが成功したあと（ai:ingest --settle。docs/workflows.md 3-1 の 11）
//   ai:pull    （ローカル）R2 の DB（db/db.sqlite.gz）を落として検査し、ローカルの写しにする（読むだけに使う）
//   ai:push    （ローカル）batch の答えのファイルを ai:check に通してから ai/inbox/<batch>/ に置く。書くのは ai/inbox/ だけ
//
// R2 との出し入れは薄い層（Remote）にし、ローカルのフォルダ（R2 を設定するまでの試し。docs/ai-ops.md の 2）と
// AWS CLI（`aws` を子プロセスで呼ぶ。S3 の SDK は依存に足さない。docs/workflows.md 2-2）を --remote で切り替える。
// ローカルのフォルダでは、キーをそのままフォルダの下のパスにし、オブジェクトのメタデータは `<キー>.meta.json` に置く（head-object の代わり）

export interface Remote {
  /** ログに出す名前（鍵は含めない） */
  readonly name: string;
  /** prefix（`/` で終わる）の直下の「フォルダ」（`/` を除いた名前）とファイル（名前） */
  list(prefix: string): Promise<{ dirs: string[]; files: string[] }>;
  get(key: string, dest: string): Promise<void>;
  put(src: string, key: string): Promise<void>;
  putText(key: string, text: string): Promise<void>;
  move(fromKey: string, toKey: string): Promise<void>;
  /** オブジェクトのメタデータ（無ければ null） */
  head(key: string): Promise<Record<string, string> | null>;
}

const KEY_RE = /^[A-Za-z0-9_.\-/]+$/;
function checkKey(key: string): string {
  if (!KEY_RE.test(key) || key.split("/").some((p) => p === ".." || p === ".") || key.startsWith("/")) throw new Error(`キーが不正: ${key}`);
  return key;
}

/** ローカルのフォルダを R2 に見立てる（docs/ai-ops.md の 2「R2 を設定するまで」） */
export class LocalRemote implements Remote {
  readonly name: string;
  private readonly root: string;
  constructor(root: string) {
    this.root = resolve(root);
    this.name = `フォルダ ${this.root}`;
  }
  private path(key: string): string {
    return join(this.root, ...checkKey(key).split("/").filter((x) => x));
  }
  async list(prefix: string): Promise<{ dirs: string[]; files: string[] }> {
    const p = this.path(prefix);
    if (!existsSync(p) || !statSync(p).isDirectory()) return { dirs: [], files: [] };
    const ents = readdirSync(p, { withFileTypes: true });
    // S3 と同じく、中にファイルの無いフォルダは無いものとして扱う
    const dirs = ents.filter((e) => e.isDirectory() && hasFile(join(p, e.name))).map((e) => e.name).sort();
    const files = ents.filter((e) => e.isFile() && !e.name.endsWith(".meta.json")).map((e) => e.name).sort();
    return { dirs, files };
  }
  async get(key: string, dest: string): Promise<void> {
    const p = this.path(key);
    if (!existsSync(p)) throw new Error(`${this.name} に ${key} が無い`);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(p, dest);
  }
  async put(src: string, key: string): Promise<void> {
    const p = this.path(key);
    mkdirSync(dirname(p), { recursive: true });
    copyFileSync(src, p);
  }
  async putText(key: string, text: string): Promise<void> {
    const p = this.path(key);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text, "utf8");
  }
  async move(fromKey: string, toKey: string): Promise<void> {
    const from = this.path(fromKey);
    const to = this.path(toKey);
    mkdirSync(dirname(to), { recursive: true });
    renameSync(from, to);
    // 空になったフォルダを消す（S3 にはフォルダが無いので、残すと一覧に出るぶんだけ食い違う）
    try {
      if (!readdirSync(dirname(from)).length) rmdirSync(dirname(from));
    } catch { /* 残っても困らない */ }
  }
  async head(key: string): Promise<Record<string, string> | null> {
    const p = this.path(key);
    if (!existsSync(p)) return null;
    if (!existsSync(`${p}.meta.json`)) return {};
    const j = JSON.parse(readFileSync(`${p}.meta.json`, "utf8")) as Record<string, unknown>;
    const m = (j.Metadata && typeof j.Metadata === "object" ? j.Metadata : j) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(m).map(([k, v]) => [k, String(v)]));
  }
}

function hasFile(dir: string): boolean {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isFile()) return true;
    if (e.isDirectory() && hasFile(join(dir, e.name))) return true;
  }
  return false;
}

export type AwsRunner = (args: string[], env: Record<string, string>) => { code: number; stdout: string; stderr: string };

/** 既定の実行: `aws` を子プロセスで呼ぶ。鍵は環境変数で渡し、コマンドの引数には出さない */
export const runAws: AwsRunner = (args, env) => {
  const r = spawnSync("aws", args, { env: { ...process.env, ...env }, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  if (r.error) throw new Error(`aws を起動できない（AWS CLI が入っていない？ docs/ai-ops.md 2-1）: ${r.error.message}`);
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};

/** R2 を AWS CLI で（S3 互換の API。接続先は https://<CLOUDFLARE_ACCOUNT_ID>.r2.cloudflarestorage.com、リージョンは auto） */
export class AwsRemote implements Remote {
  readonly name: string;
  private readonly bucket: string;
  private readonly endpoint: string;
  private readonly env: Record<string, string>;
  private readonly run: AwsRunner;
  constructor(o: { bucket: string; accountId: string; accessKeyId: string; secretAccessKey: string; run?: AwsRunner }) {
    this.bucket = o.bucket;
    this.endpoint = `https://${o.accountId}.r2.cloudflarestorage.com`;
    this.name = `R2 ${o.bucket}`;
    // チェックサムの設定（AWS_REQUEST_CHECKSUM_CALCULATION など）が要るかは段6で1回出し入れして確かめる（docs/workflows.md 2-2）。
    // 要るなら .env か Actions の env に置けば、process.env からそのまま渡る
    this.env = { AWS_ACCESS_KEY_ID: o.accessKeyId, AWS_SECRET_ACCESS_KEY: o.secretAccessKey, AWS_DEFAULT_REGION: "auto" };
    this.run = o.run ?? runAws;
  }
  private s3(key: string): string {
    return `s3://${this.bucket}/${checkKey(key)}`;
  }
  private common(): string[] {
    return ["--endpoint-url", this.endpoint, "--region", "auto"];
  }
  private exec(args: string[], okCodes = [0]): string {
    const r = this.run(args, this.env);
    if (!okCodes.includes(r.code)) throw new Error(`aws ${args.slice(0, 3).join(" ")} が失敗した（終了コード ${r.code}）: ${r.stderr.trim().slice(0, 300)}`);
    return r.stdout;
  }
  async list(prefix: string): Promise<{ dirs: string[]; files: string[] }> {
    // aws s3 ls は、何も無い prefix で終了コード 1・出力なしを返す
    const out = this.exec(["s3", "ls", this.s3(prefix), ...this.common()], [0, 1]);
    return parseS3Ls(out);
  }
  async get(key: string, dest: string): Promise<void> {
    mkdirSync(dirname(dest), { recursive: true });
    this.exec(["s3", "cp", this.s3(key), dest, "--only-show-errors", ...this.common()]);
  }
  async put(src: string, key: string): Promise<void> {
    this.exec(["s3", "cp", src, this.s3(key), "--only-show-errors", ...this.common()]);
  }
  async putText(key: string, text: string): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), "ai-put-"));
    try {
      const f = join(dir, basename(key));
      writeFileSync(f, text, "utf8");
      await this.put(f, key);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  async move(fromKey: string, toKey: string): Promise<void> {
    this.exec(["s3", "mv", this.s3(fromKey), this.s3(toKey), "--only-show-errors", ...this.common()]);
  }
  async head(key: string): Promise<Record<string, string> | null> {
    const r = this.run(["s3api", "head-object", "--bucket", this.bucket, "--key", checkKey(key), ...this.common()], this.env);
    if (r.code !== 0) {
      if (/\b(404|Not Found|NoSuchKey)\b/i.test(r.stderr)) return null;
      throw new Error(`aws s3api head-object が失敗した（終了コード ${r.code}）: ${r.stderr.trim().slice(0, 300)}`);
    }
    const j = JSON.parse(r.stdout) as { Metadata?: Record<string, string> };
    return j.Metadata ?? {};
  }
}

/** `aws s3 ls s3://b/prefix/` の出力（`PRE name/` と `日付 時刻 大きさ 名前`） */
export function parseS3Ls(out: string): { dirs: string[]; files: string[] } {
  const dirs: string[] = [];
  const files: string[] = [];
  for (const line of out.split(/\r?\n/)) {
    const pre = line.match(/^\s*PRE (.+)\/$/);
    if (pre) { dirs.push(pre[1]!); continue; }
    const f = line.match(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\s+\d+ (.+)$/);
    if (f) files.push(f[1]!);
  }
  return { dirs: dirs.sort(), files: files.sort() };
}

/**
 * --remote の値から層を選ぶ。`r2`（既定）は AWS CLI で R2（.env か Actions の Secrets・Variables の
 * R2_ACCESS_KEY_ID・R2_SECRET_ACCESS_KEY・CLOUDFLARE_ACCOUNT_ID・R2_BUCKET）。それ以外はローカルのフォルダ
 */
export function openRemote(spec: string | undefined, env: NodeJS.ProcessEnv = process.env, run?: AwsRunner): Remote {
  const s = spec ?? "r2";
  if (s !== "r2") return new LocalRemote(s);
  const names = ["R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "CLOUDFLARE_ACCOUNT_ID", "R2_BUCKET"] as const;
  const lack = names.filter((n) => !env[n]);
  if (lack.length) throw new Error(`R2 の設定が無い: ${lack.join("・")}（.env に書く。.env.example。R2 を設定する前はローカルのフォルダを --remote に渡す）`);
  return new AwsRemote({ bucket: env.R2_BUCKET!, accountId: env.CLOUDFLARE_ACCOUNT_ID!, accessKeyId: env.R2_ACCESS_KEY_ID!, secretAccessKey: env.R2_SECRET_ACCESS_KEY!, ...(run ? { run } : {}) });
}

// ─── ai:ingest（ジョブの側。docs/workflows.md 6） ───

export const INBOX = "ai/inbox/";
const BATCH_RE = /^[A-Za-z0-9_.-]+$/;
const FILE_RE = /^[A-Za-z0-9_.-]+\.json$/;

export type IngestOutcome = "applied" | "retry" | "failed";

export interface IngestBatch {
  batch: string;
  outcome: IngestOutcome;
  /** この回が何回目か（ai/results/<batch>/ の印の数。殺された回も数える） */
  attempt: number;
  reason: string;
  /** 取り込んだファイル（名前の順）。--settle はこのファイルだけを移す（取り込みのあとに置かれたファイルを移さない） */
  files: string[];
  /** 移す先（ai/applied/<batch>/ か ai/failed/<batch>/）。やり直しは null（受け箱に残す） */
  move_to: string | null;
  counts: Record<"applied" | "stale" | "already" | ApplyProblemKind, number>;
  /** 飛ばした動画（ID だけ。公開リポジトリのログに出してよい形） */
  videos: Partial<Record<"stale" | "already" | ApplyProblemKind, string[]>>;
  /** 問題の中身（R2 の ai/results/ にだけ置く。ログには出さない） */
  problems: { kind: ApplyProblemKind; file?: string; video_id?: string; message: string }[];
}

export interface IngestResult {
  run_id: string;
  remote: string;
  started_at: string;
  finished_at: string;
  batches: IngestBatch[];
  /** 1回の上限（5つ）を超えて次の回に回した batch */
  deferred: string[];
  /** 名前が不正で取り込まない batch（人が直す） */
  ignored: string[];
}

/** batch の結果を aiApply の結果から決める（docs/workflows.md 6-3） */
export function decideOutcome(r: Pick<ApplyResult, "problems">, attempt: number, maxAttempts: number): { outcome: IngestOutcome; reason: string } {
  const has = (k: ApplyProblemKind) => r.problems.some((p) => p.kind === k);
  if (has("file")) return { outcome: "failed", reason: "ファイル単位の問題（読めない・batch・model・finished_at が無いなど）。入れ直しても変わらない" };
  if (has("lookup")) {
    return attempt >= maxAttempts
      ? { outcome: "failed", reason: `外部DBで引けない答えが ${maxAttempts} 回続いた` }
      : { outcome: "retry", reason: "外部DBで引けない答えがある（照会のエラーなら次の日に入る見込み）。受け箱に残す" };
  }
  return { outcome: "applied", reason: "入れた（枠が無い・形が不正・属性の問題は結果に書いた）" };
}

/**
 * 受け箱の取り込み。受け箱から移すのは DB の書き戻しのあと（aiIngestSettle）なので、ここでは移さない。
 * apply は batch のフォルダを受けて aiApply を呼ぶ（CLI が確定した判定を保留に置き換えた枠の名寄せし直しまでする）。
 * 途中で殺された回（result が無い）は、印だけが残ってやり直しの1回に数える。入れ直しても古い答えの決まりで同じ結果になる
 */
export async function aiIngest(o: {
  remote: Remote; work: string; result: string; runId: string;
  apply: (dir: string) => Promise<ApplyResult>;
  maxBatches?: number; maxAttempts?: number;
  /** batch を1つ終えるたびに呼ぶ（テストで途中で殺すのに使う） */
  afterBatch?: (b: IngestBatch) => void | Promise<void>;
  log?: (line: string) => void;
}): Promise<IngestResult> {
  const maxBatches = o.maxBatches ?? 5;
  const maxAttempts = o.maxAttempts ?? 3;
  const log = o.log ?? ((s: string) => console.log(s));
  const started = nowIso();
  const listed = (await o.remote.list(INBOX)).dirs;
  const ignored = listed.filter((b) => !BATCH_RE.test(b));
  // 古い batch から（名前の順。batch の名前は日付を含む ai-YYYYMMDD の形にする。docs/workflows.md 6-1）
  const names = listed.filter((b) => BATCH_RE.test(b)).sort();
  const take = names.slice(0, maxBatches);
  const res: IngestResult = { run_id: o.runId, remote: o.remote.name, started_at: started, finished_at: "", batches: [], deferred: names.slice(maxBatches), ignored };
  mkdirSync(o.work, { recursive: true });
  for (const b of take) {
    const prev = (await o.remote.list(`ai/results/${b}/`)).files.length;
    const attempt = prev + 1;
    // 先に「始めた」の印を置く（殺された回もやり直しの1回に数える。docs/workflows.md 6-3）
    await o.remote.putText(`ai/results/${b}/${o.runId}.json`, JSON.stringify({ run_id: o.runId, batch: b, status: "started", attempt, at: nowIso() }, null, 2) + "\n");
    const files = (await o.remote.list(`${INBOX}${b}/`)).files.filter((f) => FILE_RE.test(f)).sort();
    const item: IngestBatch = {
      batch: b, outcome: "retry", attempt, reason: "", files, move_to: null,
      counts: { applied: 0, stale: 0, already: 0, file: 0, no_event: 0, invalid: 0, lookup: 0, enrich: 0 }, videos: {}, problems: [],
    };
    if (prev >= maxAttempts) {
      // 前の回が3回とも終わらなかった（殺された・やり直しが続いた）。入れずに failed にする
      Object.assign(item, { outcome: "failed", reason: `やり直しが ${prev} 回に達した（前の回が終わらなかったか、やり直しが続いた）` });
    } else if (!files.length) {
      Object.assign(item, { outcome: "failed", reason: "答えのファイル（*.json）が無い" });
    } else {
      const dir = join(o.work, b);
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      try {
        for (const f of files) await o.remote.get(`${INBOX}${b}/${f}`, join(dir, f));
        const r = await o.apply(dir);
        const d = decideOutcome(r, attempt, maxAttempts);
        item.outcome = d.outcome;
        item.reason = d.reason;
        item.counts.applied = r.applied.length;
        item.counts.stale = r.stale.length;
        item.counts.already = r.already.length;
        item.videos = { ...(r.stale.length ? { stale: r.stale } : {}), ...(r.already.length ? { already: r.already } : {}) };
        for (const p of r.problems) {
          item.counts[p.kind]++;
          if (p.video_id) (item.videos[p.kind] ??= []).push(p.video_id);
          item.problems.push({ kind: p.kind, ...(p.file ? { file: basename(p.file) } : {}), ...(p.video_id ? { video_id: p.video_id } : {}), message: p.message });
        }
      } catch (e) {
        // 落とせない・DB の例外など。答えの問題ではないので、殺された回と同じくやり直す
        const failed = attempt >= maxAttempts;
        Object.assign(item, {
          outcome: failed ? "failed" : "retry",
          reason: `取り込みの途中で失敗した${failed ? `（${maxAttempts} 回目）` : "（やり直す）"}: ${String((e as Error).message ?? e).slice(0, 200)}`,
        });
      }
    }
    if (item.outcome !== "retry") item.move_to = `ai/${item.outcome === "applied" ? "applied" : "failed"}/${b}/`;
    res.batches.push(item);
    log(`ai:ingest ${b}: ${item.outcome}（${attempt} 回目）入れた ${item.counts.applied}・古い答え ${item.counts.stale}・入れ済み ${item.counts.already}` +
      `・枠が無い ${item.counts.no_event}・形が不正 ${item.counts.invalid}・外部DBで引けない ${item.counts.lookup}・ファイル ${item.counts.file}` +
      `${item.move_to ? ` → ${item.move_to}（DB の書き戻しのあと）` : " → 受け箱に残す"}`);
    for (const k of ["no_event", "invalid", "lookup", "stale"] as const) {
      if (item.videos[k]?.length) log(`  ${k}: ${item.videos[k]!.join(" ")}`);
    }
    if (item.counts.file) log(`  file: ${item.problems.filter((p) => p.kind === "file").map((p) => p.file).join(" ")}`);
    await o.afterBatch?.(item);
  }
  if (res.deferred.length) log(`ai:ingest 次の回に回す batch ${res.deferred.length}: ${res.deferred.join(" ")}`);
  if (ignored.length) log(`ai:ingest 名前が不正で取り込まない batch: ${ignored.join(" ")}`);
  if (!take.length) log("ai:ingest 受け箱は空");
  res.finished_at = nowIso();
  mkdirSync(dirname(resolve(o.result)), { recursive: true });
  writeFileSync(o.result, JSON.stringify(res, null, 2) + "\n", "utf8");
  return res;
}

/**
 * 取り込んだ batch を受け箱から移し、ai/results/<batch>/<run_id>.json の印を結果で上書きする（docs/workflows.md 6-1 の 4・5）。
 * **DB の書き戻しが成功したあとにだけ呼ぶ**（書き戻せなかったのに受け箱から消すと答えが失われる）。移すのは取り込んだファイルだけ
 */
export async function aiIngestSettle(remote: Remote, resultFile: string, log: (line: string) => void = (s) => console.log(s)): Promise<{ moved: number; errors: string[] }> {
  const res = JSON.parse(readFileSync(resultFile, "utf8")) as IngestResult;
  let moved = 0;
  const errors: string[] = [];
  for (const b of res.batches) {
    try {
      if (b.move_to) {
        for (const f of b.files) {
          try {
            await remote.move(`${INBOX}${b.batch}/${f}`, `${b.move_to}${f}`);
            moved++;
          } catch (e) {
            // 前の回の --settle で移したあとに殺されたなど。残りは続ける
            errors.push(`${b.batch}/${f}: ${String((e as Error).message).slice(0, 200)}`);
          }
        }
      }
      await remote.putText(`ai/results/${b.batch}/${res.run_id}.json`, JSON.stringify({ ...b, run_id: res.run_id, status: b.outcome, settled_at: nowIso() }, null, 2) + "\n");
      log(`ai:ingest --settle ${b.batch}: ${b.outcome}${b.move_to ? ` → ${b.move_to}（${b.files.length} ファイル）` : "（受け箱に残す）"}`);
    } catch (e) {
      errors.push(`${b.batch}: ${String((e as Error).message).slice(0, 200)}`);
    }
  }
  for (const e of errors) log(`ai:ingest --settle ✖ ${e}`);
  return { moved, errors };
}

// ─── ai:pull・ai:push（ローカルの側。docs/ai-ops.md 2-1） ───

export const DB_KEY = "db/db.sqlite.gz";

/**
 * R2 の DB を落として検査し、ローカルの写しにする。写しの隣に `<db>.pulled.json`（落とした時刻とメタデータ）を置き、
 * それが無い DB は上書きしない（公開の前のローカルの正の DB を写しで消さない。段6 で正の DB の名前を変えてから使う）
 */
export async function aiPull(remote: Remote, dbPath: string, log: (line: string) => void = (s) => console.log(s)): Promise<{ ok: boolean; lines: string[] }> {
  const marker = `${dbPath}.pulled.json`;
  if (existsSync(dbPath) && !existsSync(marker)) {
    return { ok: false, lines: [`FAIL ${dbPath} は ai:pull で落とした写しではない（${basename(marker)} が無い）。正の DB を上書きしないので、名前を変えるか --db で別の場所を指す`] };
  }
  const meta = await remote.head(DB_KEY);
  if (!meta) return { ok: false, lines: [`FAIL ${remote.name} に ${DB_KEY} が無い`] };
  const tmp = mkdtempSync(join(tmpdir(), "ai-pull-"));
  const part = `${dbPath}.pull-tmp`;
  try {
    const gz = join(tmp, "db.sqlite.gz");
    await remote.get(DB_KEY, gz);
    writeFileSync(join(tmp, "head.json"), JSON.stringify({ Metadata: meta }), "utf8");
    mkdirSync(dirname(resolve(dbPath)), { recursive: true });
    for (const s of ["", "-wal", "-shm"]) rmSync(`${part}${s}`, { force: true });
    await pipeline(createReadStream(gz), createGunzip(), createWriteStream(part));
    const c = await dbCheck({ db: part, gz, expect: join(tmp, "head.json") });
    if (!c.ok) return { ok: false, lines: [...c.lines, "FAIL 検査に通らないので写しを置き換えない"] };
    for (const s of ["", "-wal", "-shm"]) rmSync(`${dbPath}${s}`, { force: true });
    for (const s of ["-wal", "-shm"]) rmSync(`${part}${s}`, { force: true });
    renameSync(part, dbPath);
    writeFileSync(marker, JSON.stringify({ pulled_at: nowIso(), remote: remote.name, key: DB_KEY, meta }, null, 2) + "\n", "utf8");
    const lines = [...c.lines, `ok   ${dbPath} に置いた（R2 の DB の写し。読むだけに使う。書いても R2 には戻らない）`];
    for (const l of lines) log(`ai:pull ${l}`);
    return { ok: true, lines };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    for (const s of ["", "-wal", "-shm"]) rmSync(`${part}${s}`, { force: true });
  }
}

/**
 * batch の答えのファイル（answers/*.json と batch の直下の fix-*.json）を ai:check に通し、ai/inbox/<batch>/ に置く。
 * 書く先は ai/inbox/ だけ（コードで決める。DB・ai/applied・ai/failed・ai/results はジョブだけが書く）。
 * 通らないファイルが1つでもあれば何も置かない（skipFailed なら通ったファイルだけ置く）
 */
export async function aiPush(remote: Remote, batch: string, opts: { skipFailed?: boolean; now?: number } = {}): Promise<{ ok: boolean; pushed: string[]; skipped: string[]; text: string }> {
  if (!BATCH_RE.test(batch)) throw new Error(`batch の名前は英数字と _ . - だけ: ${batch}`);
  const files = batchAnswerFiles(batch);
  if (!files.length) return { ok: false, pushed: [], skipped: [], text: `答えのファイルが無い（data/ai/${batch}/answers/）` };
  // answers/ と batch の直下の fix-*.json をまとめて、ファイルごとに見る
  const results = files.map((f) => aiCheck(f, opts.now !== undefined ? { now: opts.now } : {}).files[0]!);
  const bad = results.filter((r) => !r.ok);
  const lines = results.flatMap((r) => [`${r.ok ? "ok  " : "FAIL"} ${basename(r.file)}`, ...r.problems.map((p) => `       ✖ ${p}`)]);
  if (bad.length && !opts.skipFailed) {
    return { ok: false, pushed: [], skipped: bad.map((r) => basename(r.file)), text: [...lines, `ai:check に通らないファイルが ${bad.length} あるので何も置かない（--skip-failed で通ったファイルだけ置く）`].join("\n") };
  }
  const pushed: string[] = [];
  for (const r of results.filter((x) => x.ok)) {
    const name = basename(r.file);
    if (!FILE_RE.test(name)) throw new Error(`ファイルの名前は英数字と _ . - だけ: ${name}`);
    await remote.put(r.file, `${INBOX}${batch}/${name}`);
    pushed.push(name);
  }
  return {
    ok: bad.length === 0, pushed, skipped: bad.map((r) => basename(r.file)),
    text: [...lines, `${remote.name} の ${INBOX}${batch}/ に ${pushed.length} ファイルを置いた${bad.length ? `（通らない ${bad.length} ファイルは置かなかった）` : ""}。日次のジョブが取り込む（反映まで最大1日）`].join("\n"),
  };
}
