import type { DB } from "../lib/db.ts";
import type { DetectConfig } from "../lib/config.ts";
import { detect, reviewHints } from "../detect/detect.ts";
import { tx } from "../lib/db.ts";
import { quotaDay } from "../lib/time.ts";

// ローカルで状況を確認するためのレポート。ゲートの報告にも使う。

function table(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "  (なし)";
  const cols = Object.keys(rows[0]!);
  const w = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? "").length)));
  const line = (vals: string[]) => "  " + vals.map((v, i) => v.padEnd(w[i]!)).join("  ");
  return [line(cols), line(w.map((n) => "-".repeat(n))), ...rows.map((r) => line(cols.map((c) => String(r[c] ?? ""))))].join("\n");
}

export function detectReport(db: DB, cfg: DetectConfig, limit: number): string {
  const out: string[] = [];
  const q = (sql: string, ...p: (string | number)[]) => db.prepare(sql).all(...p) as Record<string, unknown>[];

  out.push("■ 配信者（Tier 1）");
  out.push(table(q("SELECT affiliation, SUM(is_active) AS active, COUNT(*) AS total, SUM(icon_url IS NULL) AS no_icon FROM streamers GROUP BY affiliation")));

  out.push("\n■ 巡回で見た動画（videos_seen）");
  out.push(table(q("SELECT first_seen_via AS via, COUNT(*) AS videos, SUM(detect_result='hit') AS hit, SUM(detect_result='rejected') AS rejected, SUM(detect_result='miss') AS miss FROM videos_seen GROUP BY first_seen_via")));

  out.push("\n■ 除外の内訳（語彙に当たったが同時視聴枠にしなかったもの）");
  out.push(table(q(`SELECT CASE WHEN detect_note LIKE 'not_live%' THEN 'not_live（ライブ配信でない）' ELSE detect_note END AS reason,
    COUNT(*) AS n FROM videos_seen WHERE detect_result = 'rejected' GROUP BY reason ORDER BY n DESC`)));

  out.push("\n■ WatchEvent");
  out.push(table(q(`SELECT status, COUNT(*) AS n, SUM(is_members_only) AS members, SUM(archive_gone_at IS NOT NULL) AS gone,
    SUM(view_count IS NULL) AS views_null FROM watch_events GROUP BY status`)));
  out.push(table(q("SELECT detect_source, detect_keyword, COUNT(*) AS n FROM watch_events GROUP BY detect_source, detect_keyword ORDER BY n DESC")));
  out.push(table(q("SELECT found_via, COUNT(*) AS n, SUM(status='upcoming') AS upcoming FROM watch_events GROUP BY found_via")));
  out.push(table(q("SELECT s.affiliation, COUNT(*) AS events, COUNT(DISTINCT e.streamer_id) AS streamers FROM watch_events e JOIN streamers s ON s.id = e.streamer_id GROUP BY s.affiliation")));

  out.push(`\n■ 検出した枠（新しい順・最大${limit}件）`);
  out.push(table(q(`SELECT substr(COALESCE(e.started_at,''),1,10) AS date, e.status, e.detect_source AS src, s.name,
    substr(e.title_raw, 1, 60) AS title FROM watch_events e JOIN streamers s ON s.id = e.streamer_id
    ORDER BY e.started_at DESC LIMIT ?`, limit)));

  out.push(`\n■ 概要欄だけでヒットした枠（誤検出の疑いが強い・最大${limit}件）`);
  out.push(table(q(`SELECT e.video_id, s.name, substr(e.title_raw, 1, 60) AS title FROM watch_events e
    JOIN streamers s ON s.id = e.streamer_id WHERE e.detect_source = 'description' ORDER BY e.started_at DESC LIMIT ?`, limit)));

  out.push(`\n■ 除外した枠の例（最大${limit}件）`);
  out.push(table(q(`SELECT video_id, detect_note AS reason, substr(title, 1, 60) AS title FROM videos_seen
    WHERE detect_result = 'rejected' ORDER BY last_seen_at DESC LIMIT ?`, limit)));

  // 取りこぼし候補: 判定に当たらなかったが、ヒント語を含むタイトル
  const misses = db.prepare("SELECT video_id, channel_id, title FROM videos_seen WHERE detect_result = 'miss'").all() as { video_id: string; channel_id: string; title: string }[];
  const hintCount = new Map<string, number>();
  const samples: { video_id: string; hints: string; title: string }[] = [];
  for (const m of misses) {
    const hs = reviewHints(m.title, cfg);
    if (hs.length === 0) continue;
    for (const h of hs) hintCount.set(h, (hintCount.get(h) ?? 0) + 1);
    samples.push({ video_id: m.video_id, hints: hs.join(","), title: m.title.slice(0, 60) });
  }
  out.push("\n■ 取りこぼし候補（ヒットしなかったがヒント語を含むタイトル）の語別件数");
  out.push(table([...hintCount].sort((a, b) => b[1] - a[1]).map(([hint, n]) => ({ hint, n }))));
  out.push(`\n■ 取りこぼし候補の例（最大${limit * 3}件）`);
  out.push(table(samples.slice(0, limit * 3)));

  return out.join("\n");
}

export function quotaReport(db: DB, days: number): string {
  const out: string[] = [];
  const q = (sql: string, ...p: (string | number)[]) => db.prepare(sql).all(...p) as Record<string, unknown>[];
  out.push(`■ クォータ使用量（太平洋時間の日付。今日 = ${quotaDay()}）`);
  out.push(table(q("SELECT quota_day, SUM(units) AS units, COUNT(DISTINCT run_id) AS runs FROM quota_usage GROUP BY quota_day ORDER BY quota_day DESC LIMIT ?", days)));
  out.push("\n■ 今日の内訳");
  out.push(table(q("SELECT job, endpoint, SUM(units) AS units FROM quota_usage WHERE quota_day = ? GROUP BY job, endpoint ORDER BY units DESC", quotaDay())));
  out.push("\n■ 直近のジョブ");
  out.push(table(q(`SELECT id, status, substr(started_at, 12, 8) AS started, substr(finished_at, 12, 8) AS finished,
    json_extract(summary, '$.quota.run_units') AS units, json_array_length(json_extract(summary, '$.errors')) AS errors
    FROM runs ORDER BY started_at DESC LIMIT 10`)));
  return out.join("\n");
}

/**
 * 語彙を変えたあと、過去に見た動画のタイトルで再判定する（API を使わない）。
 * 概要欄は保存していないので、概要欄による判定はここでは再現しない。
 * 新たにヒットしたものは 'hit' にしておき、日次ジョブが詳細を取りに行く。
 * ヒットしなくなった既存の WatchEvent は消さずに件数だけ報告する。
 */
export function rerunDetect(db: DB, cfg: DetectConfig): Record<string, number> {
  const r = { checked: 0, new_hits: 0, still_miss: 0, new_title_excluded: 0, events_no_longer_hit: 0 };
  // ライブでない・非公開などの除外は語彙と無関係なので再判定しない
  const rows = db
    .prepare(`SELECT video_id, title, detect_result FROM videos_seen
      WHERE detect_version != ? AND (detect_result = 'miss' OR detect_note LIKE 'title_exclude:%')`)
    .all(cfg.version) as { video_id: string; title: string; detect_result: string }[];
  const upd = db.prepare("UPDATE videos_seen SET detect_result = ?, detect_note = ?, detect_version = ? WHERE video_id = ?");
  tx(db, () => {
    for (const row of rows) {
      r.checked++;
      const d = detect({ title: row.title, description: null }, cfg);
      if (d.hit) {
        r.new_hits++;
        upd.run("hit", `${d.source}:${d.keyword}`, cfg.version, row.video_id);
      } else if (d.excludedBy) {
        r.new_title_excluded++;
        upd.run("rejected", `title_exclude:${d.excludedBy}`, cfg.version, row.video_id);
      } else {
        r.still_miss++;
        upd.run("miss", null, cfg.version, row.video_id);
      }
    }
  });
  const evs = db.prepare("SELECT title_raw FROM watch_events WHERE detect_source = 'title'").all() as { title_raw: string }[];
  for (const e of evs) if (!detect({ title: e.title_raw, description: null }, cfg).hit) r.events_no_longer_hit++;
  return r;
}
