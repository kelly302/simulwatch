import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, statSync, createReadStream, createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { openDb, schemaVersion } from "../src/lib/db.ts";
import { dbCheck, dbPack, decodeRows, encodeRows, readMeta } from "../src/lib/dbfile.ts";
import { siteFingerprint, jobDue, runsSummary, numericLeaves } from "../src/lib/jobtools.ts";
import { redactUrl, HttpError } from "../src/lib/http.ts";
import { Quota, QuotaExhausted } from "../src/lib/quota.ts";
import { quotaDay } from "../src/lib/time.ts";
import { loadTargets } from "../src/resolve/resolve.ts";
import type { CrawlConfig } from "../src/lib/config.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "jobbase-"));
}

/** 小さな DB（マイグレーション済み・行を消さない表に数行）をファイルに作る */
function smallDb(dir: string): string {
  const path = join(dir, "db.sqlite");
  const db = openDb(path);
  db.exec(`INSERT INTO streamers (id, name, affiliation, channel_id, tier, first_seen_at, updated_at) VALUES (1, 's', 'nijisanji', 'UCa', 1, 'n', 'n'), (2, 't', 'hololive', 'UCb', 1, 'n', 'n');
    INSERT INTO watch_events (id, streamer_id, video_id, title_raw, url, status, detected_at, detect_source, detect_keyword, found_via, updated_at)
    VALUES (1, 1, 'v1', 't', 'u', 'completed', 'n', 'title', 'k', 'rss', 'n');`);
  db.close();
  return path;
}

async function gunzipTo(gz: string, out: string): Promise<void> {
  await pipeline(createReadStream(gz), createGunzip(), createWriteStream(out));
}

test("db:pack → 展開 → db:check の往復が通り、-wal は空。メタデータは S3 に載せられる形", async () => {
  const dir = tmp();
  const path = smallDb(dir);
  // 書いたまま閉じていない接続の WAL も、pack が開き直して本体に書き戻す
  const w = new DatabaseSync(path);
  w.exec("INSERT INTO streamers (id, name, affiliation, channel_id, tier, first_seen_at, updated_at) VALUES (3, 'u', 'vspo', 'UCc', 1, 'n', 'n')");
  w.close();
  const p = await dbPack({ db: path, initial: true, out: join(dir, "out"), runId: "r1", writer: "daily" });
  assert.ok(p.ok, p.lines.join("\n"));
  assert.ok(!existsSync(`${path}-wal`) || statSync(`${path}-wal`).size === 0);
  const meta = readMeta(join(dir, "out", "meta.json"));
  assert.deepEqual(decodeRows(meta.rows), { streamers: 3, watch_events: 1, videos_seen: 0, ai_decisions: 0, unresolved: 0, work_public_keys: 0, candidates: 0 });
  assert.equal(meta["user-version"], String(schemaVersion()));
  assert.equal(meta.writer, "daily");
  // ASCII だけ・2KB まで
  const raw = readFileSync(join(dir, "out", "meta.json"), "utf8");
  assert.match(raw, /^[\x00-\x7f]*$/);
  assert.ok(raw.length < 2048);
  // head-object の出力（{"Metadata": {...}}）の形でも読める
  writeFileSync(join(dir, "head.json"), JSON.stringify({ ContentLength: 1, Metadata: meta }));
  const extracted = join(dir, "pulled.sqlite");
  await gunzipTo(join(dir, "out", "db.sqlite.gz"), extracted);
  const c = await dbCheck({ db: extracted, gz: join(dir, "out", "db.sqlite.gz"), expect: join(dir, "head.json"), observed: join(dir, "observed.json") });
  assert.ok(c.ok, c.lines.join("\n"));
  // observed をそのまま次の pack の比べる相手にできる
  const p2 = await dbPack({ db: extracted, against: join(dir, "observed.json"), out: join(dir, "out2"), runId: "r2", writer: "daily" });
  assert.ok(p2.ok, p2.lines.join("\n"));
});

test("db:check: ファイル無し・壊れ・sha256 の不一致・user_version が上・行数の不一致で外れる。DB が無ければ作らない", async () => {
  const dir = tmp();
  const path = smallDb(dir);
  const p = await dbPack({ db: path, initial: true, out: join(dir, "out"), runId: "r", writer: "daily" });
  assert.ok(p.ok);
  const gz = join(dir, "out", "db.sqlite.gz");
  const metaPath = join(dir, "out", "meta.json");
  const meta = readMeta(metaPath);

  const missing = join(dir, "nothing.sqlite");
  const r1 = await dbCheck({ db: missing, gz, expect: metaPath });
  assert.equal(r1.ok, false);
  assert.equal(existsSync(missing), false);

  const broken = join(dir, "broken.sqlite");
  writeFileSync(broken, "これは SQLite ではない".repeat(500));
  assert.equal((await dbCheck({ db: broken, gz, expect: metaPath })).ok, false);
  // accept でも壊れた DB は通さない
  assert.equal((await dbCheck({ db: broken, accept: true })).ok, false);

  const pulled = join(dir, "pulled.sqlite");
  await gunzipTo(gz, pulled);
  writeFileSync(join(dir, "badsha.json"), JSON.stringify({ ...meta, sha256: "0".repeat(64) }));
  const r3 = await dbCheck({ db: pulled, gz, expect: join(dir, "badsha.json") });
  assert.equal(r3.ok, false);
  assert.ok(r3.lines.some((l) => l.startsWith("FAIL sha256")));

  writeFileSync(join(dir, "badrows.json"), JSON.stringify({ ...meta, rows: encodeRows({ ...decodeRows(meta.rows)!, streamers: 5 }) }));
  const r4 = await dbCheck({ db: pulled, gz, expect: join(dir, "badrows.json") });
  assert.equal(r4.ok, false);
  assert.ok(r4.lines.some((l) => l.includes("行数がメタデータと違う")));
  // accept_db なら sha256・行数の照合を飛ばして通す
  assert.ok((await dbCheck({ db: pulled, gz, expect: join(dir, "badrows.json"), accept: true })).ok);

  const newer = new DatabaseSync(pulled);
  newer.exec(`PRAGMA user_version = ${schemaVersion() + 1}`);
  newer.close();
  const r5 = await dbCheck({ db: pulled, accept: true });
  assert.equal(r5.ok, false);
  assert.ok(r5.lines.some((l) => l.includes("user_version")));

  // メタデータが無ければ（accept でなければ）外れる
  assert.equal((await dbCheck({ db: path, gz })).ok, false);
});

test("db:pack: 行を消さない表の行が減っていたら何も書かずに外れる。比べる相手が無くても外れる", async () => {
  const dir = tmp();
  const path = smallDb(dir);
  const first = await dbPack({ db: path, initial: true, out: join(dir, "out"), runId: "r", writer: "daily" });
  assert.ok(first.ok);
  const db = new DatabaseSync(path);
  db.exec("DELETE FROM watch_events");
  db.close();
  const r = await dbPack({ db: path, against: join(dir, "out", "meta.json"), out: join(dir, "out"), runId: "r2", writer: "daily" });
  assert.equal(r.ok, false);
  assert.ok(r.lines.some((l) => l.includes("watch_events 1 → 0")));
  assert.equal(existsSync(join(dir, "out", "db.sqlite.gz")), false, "前の回の出力も残さない");
  assert.equal(existsSync(join(dir, "out", "meta.json")), false);
  assert.equal((await dbPack({ db: path, out: join(dir, "o3"), runId: "r", writer: "daily" })).ok, false);
  assert.equal((await dbPack({ db: join(dir, "none.sqlite"), initial: true, out: join(dir, "o4"), runId: "r", writer: "daily" })).ok, false);
});

test("CLI: db:check・db:pack は外れたら終了コード 1", () => {
  const dir = tmp();
  const run = (...args: string[]) => spawnSync(process.execPath, ["src/cli.ts", ...args], { encoding: "utf8", env: { ...process.env, DATA_DIR: dir } });
  assert.equal(run("db:check", "--db", join(dir, "none.sqlite"), "--gz", join(dir, "x.gz"), "--expect", join(dir, "m.json")).status, 1);
  assert.equal(run("db:pack", "--db", join(dir, "none.sqlite"), "--initial", "--out", join(dir, "out")).status, 1);
  assert.equal(existsSync(join(dir, "none.sqlite")), false);
});

test("ログの URL はクエリの値を伏せ、名前だけ残す", () => {
  assert.equal(redactUrl("https://www.googleapis.com/youtube/v3/videos?part=snippet&id=abc&key=SECRET"), "https://www.googleapis.com/youtube/v3/videos?part=…&id=…&key=…");
  assert.equal(redactUrl("https://ja.wikipedia.org/w/api.php?action=query&srsearch=%E3%83%A1%E3%83%B3%E9%99%90"), "https://ja.wikipedia.org/w/api.php?action=…&srsearch=…");
  assert.equal(redactUrl("https://example.com/a?%E8%AA%9E#frag"), "https://example.com/a?…");
  assert.equal(redactUrl("https://example.com/a"), "https://example.com/a");
  const e = new HttpError(500, "https://www.wikidata.org/w/api.php?search=秘密の語&key=K", "body");
  assert.ok(!e.message.includes("秘密") && !e.message.includes("K&") && !e.message.endsWith("=K"));
  assert.match(e.message, /^HTTP 500 https:\/\/www\.wikidata\.org\/w\/api\.php\?search=…&key=…$/);
});

test("クォータ: 定期実行のジョブは stop_at から AI の取り分を引いた値で止め、人が起動するジョブは stop_at まで使う", () => {
  const db = openDb(":memory:");
  const cfg: CrawlConfig["quota"] = { daily_limit: 10000, stop_at: 9000, ai_reserve: 600, per_run: { hourly: 300, daily: 6000 } };
  db.prepare("INSERT INTO quota_usage (quota_day, at, run_id, job, endpoint, units) VALUES (?, 'n', 'r', 'daily', 'videos.list', ?)").run(quotaDay(), 8399);
  const daily = new Quota(db, cfg, "r1", "daily");
  assert.equal(daily.remaining(), 1);
  daily.reserve("videos.list");
  daily.record("videos.list");
  assert.equal(daily.remaining(), 0);
  assert.throws(() => daily.reserve("videos.list"), (e: unknown) => e instanceof QuotaExhausted && /8400/.test((e as Error).message));
  assert.throws(() => new Quota(db, cfg, "r2", "hourly").reserve("videos.list"), QuotaExhausted);
  const report = new Quota(db, cfg, "r3", "report");
  assert.equal(report.remaining(), 600);
  report.reserve("videos.list");
  // ai_reserve を書いていない設定は今までどおり stop_at で止める
  assert.equal(new Quota(db, { ...cfg, ai_reserve: undefined }, "r4", "daily").remaining(), 600);
});

test("resolve の対象: 未処理の枠を先・照会エラーの枠を後にし、処理済みの枠は入れない（--limit がエラーの枠で埋まらない）", () => {
  const db = openDb(":memory:");
  db.exec(`INSERT INTO streamers (id, name, affiliation, channel_id, tier, first_seen_at, updated_at) VALUES (1, 's', 'nijisanji', 'UCx', 1, 'n', 'n');
    INSERT INTO watch_events (id, streamer_id, video_id, title_raw, url, status, detected_at, detect_source, detect_keyword, found_via, updated_at) VALUES
      (1, 1, 'err1', 't', 'u', 'completed', 'n', 'title', 'k', 'rss', 'n'),
      (2, 1, 'done', 't', 'u', 'completed', 'n', 'title', 'k', 'rss', 'n'),
      (3, 1, 'new1', 't', 'u', 'completed', 'n', 'title', 'k', 'rss', 'n'),
      (4, 1, 'nf', 't', 'u', 'completed', 'n', 'title', 'k', 'rss', 'n'),
      (5, 1, 'err2', 't', 'u', 'completed', 'n', 'title', 'k', 'rss', 'n'),
      (6, 1, 'new2', 't', 'u', 'completed', 'n', 'title', 'k', 'rss', 'n');
    INSERT INTO event_resolution (watch_event_id, status, rule_version, processed_at) VALUES
      (1, 'unresolved', 'v', 'n'), (2, 'resolved', 'v', 'n'), (4, 'unresolved', 'v', 'n'), (5, 'unresolved', 'v', 'n');
    INSERT INTO unresolved (watch_event_id, reason, rule_version, created_at, updated_at) VALUES
      (1, 'error', 'v', 'n', 'n'), (4, 'not_found', 'v', 'n', 'n'), (5, 'error', 'v', 'n', 'n');`);
  const ctx = { db, crawlCfg: { upcoming: { max_days_ahead: 30 } } as CrawlConfig };
  const ids = (limit?: number) => loadTargets(ctx, { mode: "new", ...(limit ? { limit } : {}) }).map((t) => t.video_id);
  assert.deepEqual(ids(), ["new1", "new2", "err1", "err2"]);
  assert.deepEqual(ids(2), ["new1", "new2"]);
  assert.deepEqual(ids(3), ["new1", "new2", "err1"]);
});

test("site:fingerprint: generatedAt だけ違うなら同じ。中身・コミット・日付が違えば変わる", () => {
  const a = JSON.stringify({ generatedAt: "2026-11-08T00:00:00Z", events: [1, 2] });
  const b = JSON.stringify({ generatedAt: "2026-11-09T00:00:00Z", events: [1, 2] });
  const c = JSON.stringify({ generatedAt: "2026-11-08T00:00:00Z", events: [1, 3] });
  assert.equal(siteFingerprint(a).fingerprint, siteFingerprint(b).fingerprint);
  assert.notEqual(siteFingerprint(a).fingerprint, siteFingerprint(c).fingerprint);
  const x = siteFingerprint(a, { commit: "abc", date: "2026-11-08" });
  assert.equal(x.data, siteFingerprint(a).data);
  assert.notEqual(x.fingerprint, siteFingerprint(a, { commit: "abd", date: "2026-11-08" }).fingerprint);
  assert.notEqual(x.fingerprint, siteFingerprint(a, { commit: "abc", date: "2026-11-09" }).fingerprint);
});

test("job:due: 日次が20時間以内に書いていれば流さない。日次でない・古い・値が無い・未来なら流す", () => {
  const now = new Date("2026-11-08T02:23:00Z");
  assert.equal(jobDue({ writtenAt: "2026-11-07T20:50:00Z", writer: "daily" }, { now }).due, false);
  assert.equal(jobDue({ writtenAt: "2026-11-07T20:50:00Z", writer: "publish" }, { now }).due, true);
  assert.equal(jobDue({ writtenAt: "2026-11-07T06:00:00Z", writer: "daily" }, { now }).due, true);
  assert.equal(jobDue({}, { now }).due, true);
  assert.equal(jobDue({ writtenAt: "壊れた値", writer: "daily" }, { now }).due, true);
  assert.equal(jobDue({ writtenAt: "2026-11-09T00:00:00Z", writer: "daily" }, { now }).due, true);
});

test("runs:summary: 数・状態・エラーだけを出し、要約の文字列は出さない。partial と止まった回は ::warning::", () => {
  const db = openDb(":memory:");
  const ins = db.prepare("INSERT INTO runs (id, job, started_at, finished_at, status, summary) VALUES (?, ?, ?, ?, ?, ?)");
  ins.run("old", "daily", "2026-11-06T20:00:00.000Z", "2026-11-06T20:01:00.000Z", "ok", "{}");
  ins.run("r1", "daily", "2026-11-07T20:24:00.000Z", "2026-11-07T20:28:00.000Z", "partial", JSON.stringify({
    refresh_all: { targets: 7727, status_changed: { "upcoming->completed": 1 } },
    ai: { skipped: ["vid1", "vid2"], note: "メン限の概要欄の本文" },
    quota: { run_units: 155, today_units: 721 }, raw_path: "C:\\data\\raw", errors: [{ step: "crawl: uploads", error: "HttpError: HTTP 500 https://x/?id=…\n2行目|" }],
  }));
  ins.run("r2", "resolve", "2026-11-07T20:30:00.000Z", null, "running", null);
  const s = runsSummary(db, new Date("2026-11-07T20:23:00Z"));
  assert.match(s.markdown, /2 回/);
  assert.ok(!s.markdown.includes("old"));
  assert.match(s.markdown, /refresh_all: targets=7727, status_changed\.upcoming->completed=1/);
  assert.match(s.markdown, /ai: skipped=2件/);
  assert.ok(!s.markdown.includes("メン限の概要欄の本文"));
  assert.ok(!s.markdown.includes("C:\\data"));
  assert.match(s.markdown, /今日（太平洋時間）721/);
  assert.match(s.markdown, /HTTP 500 https:\/\/x\/\?id=… 2行目\\\|/);
  assert.equal(s.warnings.length, 2);
  assert.ok(s.warnings.every((w) => w.startsWith("::warning title=") && !w.includes("\n")));
  assert.deepEqual(numericLeaves({ a: "文字", b: [1], c: { d: 2 } }), ["b=1件", "c.d=2"]);
});
