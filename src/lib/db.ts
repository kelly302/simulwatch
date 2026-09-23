import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DB_PATH } from "./paths.ts";

export type DB = DatabaseSync;

// マイグレーション。PRAGMA user_version で適用済みの番号を持つ。
// 既存の番号の中身は書き換えず、変更は新しい番号として末尾に足す。
const MIGRATIONS: string[] = [
  // 1: 取得基盤（Phase 1）
  `
  CREATE TABLE streamers (
    id              INTEGER PRIMARY KEY,
    name            TEXT NOT NULL,
    affiliation     TEXT NOT NULL,
    channel_id      TEXT NOT NULL UNIQUE,
    platform        TEXT NOT NULL DEFAULT 'youtube',
    icon_url        TEXT,
    tier            INTEGER NOT NULL,
    is_active       INTEGER NOT NULL DEFAULT 1,
    source_key      TEXT UNIQUE,
    channel_title   TEXT,
    first_seen_at   TEXT NOT NULL,
    last_listed_at  TEXT,
    deactivated_at  TEXT,
    updated_at      TEXT NOT NULL
  );

  CREATE TABLE watch_events (
    id                    INTEGER PRIMARY KEY,
    streamer_id           INTEGER NOT NULL REFERENCES streamers(id),
    video_id              TEXT NOT NULL UNIQUE,
    title_raw             TEXT NOT NULL,
    description_raw       TEXT,
    thumbnail_url         TEXT,
    url                   TEXT NOT NULL,
    started_at            TEXT,
    scheduled_start_at    TEXT,
    ended_at              TEXT,
    status                TEXT NOT NULL CHECK (status IN ('upcoming', 'live', 'completed')),
    is_members_only       INTEGER NOT NULL DEFAULT 0,
    view_count            INTEGER,
    view_count_fetched_at TEXT,
    detected_at           TEXT NOT NULL,
    detect_source         TEXT NOT NULL,
    detect_keyword        TEXT NOT NULL,
    found_via             TEXT NOT NULL,
    archive_gone_at       TEXT,
    last_checked_at       TEXT,
    updated_at            TEXT NOT NULL
  );
  CREATE INDEX watch_events_streamer ON watch_events(streamer_id);
  CREATE INDEX watch_events_status ON watch_events(status);

  -- 巡回で見たすべての動画。RSS の差分検知と、語彙を変えたときの再判定に使う
  CREATE TABLE videos_seen (
    video_id          TEXT PRIMARY KEY,
    channel_id        TEXT NOT NULL,
    title             TEXT NOT NULL,
    published_at      TEXT,
    first_seen_at     TEXT NOT NULL,
    first_seen_via    TEXT NOT NULL,
    last_seen_at      TEXT NOT NULL,
    -- hit: 同時視聴枠 / miss: 語彙に当たらない / rejected: 語彙に当たったが除外条件に該当
    detect_result     TEXT NOT NULL,
    detect_note       TEXT,
    detect_version    TEXT NOT NULL,
    is_members_hint   INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX videos_seen_channel ON videos_seen(channel_id);
  CREATE INDEX videos_seen_result ON videos_seen(detect_result);

  -- チャンネルごとの巡回状態
  CREATE TABLE crawl_state (
    channel_id               TEXT PRIMARY KEY,
    rss_checked_at           TEXT,
    rss_error                TEXT,
    playlist_scanned_at      TEXT,
    playlist_error           TEXT,
    members_playlist_status  TEXT,
    backfill_page_token      TEXT,
    backfill_done            INTEGER NOT NULL DEFAULT 0,
    backfill_oldest_at       TEXT
  );

  -- API 呼び出しごとのクォータ消費。quota_day は太平洋時間の日付
  CREATE TABLE quota_usage (
    id         INTEGER PRIMARY KEY,
    quota_day  TEXT NOT NULL,
    at         TEXT NOT NULL,
    run_id     TEXT NOT NULL,
    job        TEXT NOT NULL,
    endpoint   TEXT NOT NULL,
    units      INTEGER NOT NULL
  );
  CREATE INDEX quota_usage_day ON quota_usage(quota_day);

  -- ジョブの実行記録。summary はステップごとの件数とエラー
  CREATE TABLE runs (
    id           TEXT PRIMARY KEY,
    job          TEXT NOT NULL,
    started_at   TEXT NOT NULL,
    finished_at  TEXT,
    status       TEXT NOT NULL,
    summary      TEXT
  );
  `,
  // 2: メン限プレイリストの遡り。同時視聴枠はメン限が大半なので uploads と別に過去分を追う
  `
  ALTER TABLE crawl_state ADD COLUMN members_backfill_page_token TEXT;
  ALTER TABLE crawl_state ADD COLUMN members_backfill_done INTEGER NOT NULL DEFAULT 0;
  `,
];

export function openDb(path: string = DB_PATH): DB {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  migrate(db);
  return db;
}

function migrate(db: DB): void {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  for (let v = row.user_version; v < MIGRATIONS.length; v++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[v]!);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
}

/** WAL を本体に書き戻す。R2 へアップロードする前に呼ぶ */
export function checkpoint(db: DB): void {
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
}

export function tx<T>(db: DB, fn: () => T): T {
  db.exec("BEGIN");
  try {
    const r = fn();
    db.exec("COMMIT");
    return r;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
