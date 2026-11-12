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
  // 3: ゲート1の判断
  //    - started_at にどの値を入れたか（ライブでない再アップは公開日時で代用する）
  //    - 判定ルールの変更で同時視聴枠でなくなった枠を、行を消さずに外す
  `
  ALTER TABLE watch_events ADD COLUMN started_at_source TEXT;
  ALTER TABLE watch_events ADD COLUMN excluded_at TEXT;
  ALTER TABLE watch_events ADD COLUMN excluded_reason TEXT;
  `,
  // 4: 名寄せ（Phase 2）
  `
  -- 作品。同定は外部DBのIDを正とする（Annict / AniList / Wikidata）。自前で作品マスタを育てない
  CREATE TABLE works (
    id              INTEGER PRIMARY KEY,
    annict_id       INTEGER UNIQUE,
    anilist_id      INTEGER UNIQUE,
    wikidata_id     TEXT UNIQUE,
    title           TEXT NOT NULL,
    title_kana      TEXT,
    media           TEXT,                -- tv / movie / ova / web（不明は NULL）
    season_name     TEXT,                -- "2022-autumn"（Annict・AniList）/ "2022"（Wikidata は年のみ）
    series_id       TEXT,                -- "annict:<id>" / "wikidata:<Qid>"
    episodes_count  INTEGER,
    image_url       TEXT,                -- AniList の画像URL（参照のみ。自前で保存しない）
    mal_id          INTEGER,
    release_year    INTEGER,
    source          TEXT NOT NULL,       -- 同定した照会先 annict / anilist / wikidata
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
  );

  -- 話。映画・単発は作らない
  CREATE TABLE episodes (
    id           INTEGER PRIMARY KEY,
    work_id      INTEGER NOT NULL REFERENCES works(id),
    number       REAL,
    number_text  TEXT NOT NULL,
    title        TEXT
  );
  CREATE UNIQUE INDEX episodes_work_number ON episodes(work_id, number);

  -- 枠と作品（と話）の多対多
  CREATE TABLE event_works (
    id              INTEGER PRIMARY KEY,
    watch_event_id  INTEGER NOT NULL REFERENCES watch_events(id),
    work_id         INTEGER NOT NULL REFERENCES works(id),
    episode_id      INTEGER REFERENCES episodes(id),
    confidence      REAL NOT NULL,
    match_method    TEXT NOT NULL,       -- 例 annict:exact / wikipedia:suffix
    extracted_text  TEXT NOT NULL,       -- 一致した区間
    rule_version    TEXT NOT NULL,
    created_at      TEXT NOT NULL
  );
  CREATE UNIQUE INDEX event_works_uniq ON event_works(watch_event_id, work_id, IFNULL(episode_id, 0));
  CREATE INDEX event_works_work ON event_works(work_id);

  -- 同定できなかった枠。1枠1行。あとで同定できたら resolved_at を立てる（行は残す）
  CREATE TABLE unresolved (
    id              INTEGER PRIMARY KEY,
    watch_event_id  INTEGER NOT NULL UNIQUE REFERENCES watch_events(id),
    extracted_text  TEXT,
    reason          TEXT NOT NULL,       -- no_candidate / not_found / ambiguous / not_a_work / error
    detail          TEXT,                -- JSON（試した区間・候補など）
    rule_version    TEXT NOT NULL,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    resolved_at     TEXT
  );
  CREATE INDEX unresolved_reason ON unresolved(reason);

  -- 枠ごとの名寄せの処理状態（どのルールで処理したか）
  CREATE TABLE event_resolution (
    watch_event_id  INTEGER PRIMARY KEY REFERENCES watch_events(id),
    status          TEXT NOT NULL,       -- resolved / unresolved
    rule_version    TEXT NOT NULL,
    processed_at    TEXT NOT NULL
  );

  -- 外部作品DBへの照会結果のキャッシュ。ルールを直して再処理するときに同じ照会を繰り返さない
  CREATE TABLE resolve_cache (
    source      TEXT NOT NULL,
    query       TEXT NOT NULL,
    response    TEXT NOT NULL,
    fetched_at  TEXT NOT NULL,
    PRIMARY KEY (source, query)
  );
  `,
  // 5: AI の判定。ルールで決まらなかった枠を、人が起動するコマンド（ai:apply）で判定して入れる。
  // resolve は上書きしない（確定）。取り消しは ai:revoke（revoked_at を立てる。行は残す）
  `
  CREATE TABLE ai_decisions (
    id              INTEGER PRIMARY KEY,
    watch_event_id  INTEGER NOT NULL REFERENCES watch_events(id),
    status          TEXT NOT NULL,       -- identified / not_a_work / unidentifiable / hold
    works           TEXT,                -- JSON。同定した作品（外部DBの候補をそのまま）と話数
    confidence      TEXT NOT NULL,       -- high / medium / low（low はサイトに出さない）
    evidence        TEXT NOT NULL,       -- JSON。見たもの（タイトル・概要欄・サムネイル・照会した語と結果）
    rationale       TEXT NOT NULL,       -- 判断の理由
    model           TEXT NOT NULL,       -- 判定したモデル
    batch           TEXT NOT NULL,       -- 判定のまとまり（ai:queue の名前）
    seconds         REAL,                -- 1枠にかかった時間
    decided_at      TEXT NOT NULL,
    revoked_at      TEXT
  );
  CREATE UNIQUE INDEX ai_decisions_active ON ai_decisions(watch_event_id) WHERE revoked_at IS NULL;
  `,
  // 6: AI の本番の判定（2026-10-01）。枠の型（同定の経路と危なさ。src/resolve/route.ts）を名寄せのたびに記録し、
  // AI に回す型（config/extract.yaml の ai_routes）の枠は AI が確かめるまでサイトに出さない。
  // AI の判定に「作品だが外部DBに無い」（not_in_db）の作品名と、複数作品のうち外部DBに無い作品の名前を持たせる
  `
  ALTER TABLE event_resolution ADD COLUMN route TEXT;       -- 型（series / redirect / not_a_work_rule など）
  ALTER TABLE event_resolution ADD COLUMN route_sub TEXT;   -- 型の中の区分（作品ではないの語の種類）
  ALTER TABLE event_resolution ADD COLUMN route_at TEXT;
  ALTER TABLE ai_decisions ADD COLUMN extra TEXT;           -- JSON。{ title（not_in_db の作品名）, missing（外部DBに無い作品の名前）}
  `,
  // 7: 作品の属性（2026-10-02。UI の絞り込み用）。映像の種類・制作国・シリーズの名前。外部DBから自動で埋める（src/resolve/enrich.ts）
  `
  ALTER TABLE works ADD COLUMN kind TEXT;           -- anime / tokusatsu / live_action
  ALTER TABLE works ADD COLUMN countries TEXT;      -- JSON。制作国の ISO 3166-1 alpha-2 の並び（["JP"]・["US","GB"]）。分からなければ NULL
  ALTER TABLE works ADD COLUMN series_title TEXT;   -- シリーズの名前（Annict のシリーズ・Wikidata の P179）。series_id と対
  ALTER TABLE works ADD COLUMN attrs_at TEXT;       -- 属性を埋めた時刻
  `,
  // 8: 作品名の BOM・ゼロ幅の文字を落とす（Wikidata のラベルの末尾に混じる。「エクステリトリアル」の末尾）。新しい作品は wikidataCandidate で落とす
  `
  UPDATE works SET title = replace(replace(title, char(65279), ''), char(8203), '') WHERE instr(title, char(65279)) > 0 OR instr(title, char(8203)) > 0;
  `,
  // 9: 所属の中の区分（2026-10-02。UI の所属の絞り込みで、事務所の下のチェックボックスに使う）。にじさんじの jp / kr（旧 NIJISANJI KR）/ id（旧 NIJISANJI ID）
  `
  ALTER TABLE streamers ADD COLUMN branch TEXT;
  `,
  // 10: 公開（Phase 3。2026-10-19 の決定 C）
  //    - 配信者の英語の名前（にじさんじは名簿の API の enName、ホロライブは英語版の一覧）。EN・KR・ID の配信者に併記する
  //    - 作品の URL の公開キー（annict-1234 / anilist-5678 / wikidata-Q123）。works の行は名寄せで作り直されるので、
  //      一度出したキーは work_public_keys に覚えておき、同じ作品には同じキーを付け直す。行がまとまったときの 301 もここから作る
  //    - ページごとの中身の指紋と、中身が変わった日（sitemap の lastmod）
  `
  ALTER TABLE streamers ADD COLUMN name_en TEXT;
  ALTER TABLE works ADD COLUMN public_key TEXT;

  CREATE TABLE work_public_keys (
    public_key          TEXT PRIMARY KEY,
    annict_id           INTEGER,
    anilist_id          INTEGER,
    wikidata_id         TEXT,
    first_published_at  TEXT NOT NULL,
    last_published_at   TEXT NOT NULL
  );

  CREATE TABLE site_pages (
    path         TEXT PRIMARY KEY,
    fingerprint  TEXT NOT NULL,
    changed_at   TEXT NOT NULL,
    built_at     TEXT NOT NULL
  );
  `,
  // 11: 分割クール（2026-10-21）。後半の作品（Annict の ID）→ まとめ先の前半の作品。名寄せのたびに作り直す（src/resolve/splitcour.ts）
  `
  CREATE TABLE split_cours (
    annict_id       INTEGER PRIMARY KEY,
    head_annict_id  INTEGER NOT NULL,
    checked_at      TEXT NOT NULL
  );
  `,
  // 12: 続きの回の候補（2026-11-13。docs/ai-ops.md 3章・決定 D-04）。題名に同時視聴の語が無い動画のうち、続きの回かもしれないもの。
  //     日次のジョブが選び（candidates:select）、videos.list で詳細を取り（candidates:fetch）、人が起動した AI の判定役が
  //     「同時視聴か・どの作品か」を答える。同時視聴と答えたら枠（watch_events。detect_source = 'ai_candidate'）を作る。
  //     行を消さない表（db:pack が行の減少で止める）。同じ動画は1回だけ候補にする
  `
  CREATE TABLE candidates (
    id                    INTEGER PRIMARY KEY,
    video_id              TEXT NOT NULL UNIQUE,
    streamer_id           INTEGER NOT NULL REFERENCES streamers(id),
    -- selected: 選んだ（詳細はまだ）/ waiting: 予定・配信中（次の日にもう一度詳細を取る）/ ready: 終わった（判定に回す）/
    -- unavailable: 詳細が取れない（削除・非公開・ライブでない）/ detected: 同時視聴の語で枠になった（判定に回さない）/
    -- framed: 答えで枠を作った / not_watchalong: 同時視聴ではない / hold: 答えが保留（--include-hold で回す）
    state                 TEXT NOT NULL CHECK (state IN ('selected', 'waiting', 'ready', 'unavailable', 'detected', 'framed', 'not_watchalong', 'hold')),
    state_at              TEXT NOT NULL,
    reasons               TEXT NOT NULL,       -- JSON。候補の理由（層）の並び ["same_work_members","continuation_word"]
    seeds                 TEXT NOT NULL,       -- JSON。種の枠 [{ reason, seed（watch_events.id）, key（作品名の区間）}]
    selected_at           TEXT NOT NULL,       -- 最初に選んだ時刻
    last_selected_at      TEXT NOT NULL,       -- 最後に選んだ時刻（選び方を変えて選ばれなくなっても行は残す）
    -- 詳細（videos.list）。watch_events と同じ列・同じ意味。枠にするときそのまま写す（もう一度 videos.list を引かない）。
    -- description_raw は判定のためだけに持ち、公開しない
    title_raw             TEXT,
    description_raw       TEXT,
    thumbnail_url         TEXT,
    started_at            TEXT,
    started_at_source     TEXT,
    scheduled_start_at    TEXT,
    ended_at              TEXT,
    status                TEXT CHECK (status IS NULL OR status IN ('upcoming', 'live', 'completed')),
    is_members_only       INTEGER NOT NULL DEFAULT 0,   -- videos_seen の is_members_hint（メン限プレイリスト）と題名のメン限の語
    view_count            INTEGER,
    view_count_fetched_at TEXT,
    fetched_at            TEXT,                -- 詳細を最後に取った時刻
    fetch_note            TEXT,                -- 取れなかった理由（missing_in_videos_list / privacy:private / not_live）
    -- 枠を作らない答え（not_watchalong・hold）。枠を作った答えは ai_decisions に入れる
    answer_status         TEXT,
    answer_batch          TEXT,
    answer_detail         TEXT,                -- JSON。{ model, confidence, rationale, evidence, seconds }
    answered_at           TEXT,                -- 答えの時刻（答えのファイルの finished_at。UTC）。これより古い答えは入れない
    answer_revoked_at     TEXT,
    watch_event_id        INTEGER REFERENCES watch_events(id)   -- 作った枠（detected は語で当たった枠）
  );
  CREATE INDEX candidates_state ON candidates(state);
  CREATE INDEX candidates_streamer ON candidates(streamer_id);
  `,
];

export function openDb(path: string = DB_PATH): DB {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  migrate(db);
  return db;
}

/** コードが知っているマイグレーションの数（DB の user_version の上限。db:check がこれより新しい DB を止める） */
export function schemaVersion(): number {
  return MIGRATIONS.length;
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
