# データモデル

CLAUDE.md から移した（2026-11-04。文言は変えずにそのまま移した）。CLAUDE.md と同じく**実装と同じコミットで直す**。未実装の決定は docs/decisions.md が優先する（印「→ D-xx」の付いた文）。

## データモデル

    Streamer   id, name, name_en, affiliation, branch, channel_id, platform, icon_url, tier,
               is_active, source_key, channel_title,
               first_seen_at, last_listed_at, deactivated_at, updated_at
    Work       id, annict_id, anilist_id, wikidata_id, title, title_kana,
               media (tv / movie / ova / web), season_name, series_id,
               episodes_count, image_url, mal_id, release_year, source,
               kind (anime / tokusatsu / live_action), countries, series_title, attrs_at,
               public_key, created_at, updated_at
    Episode    id, work_id, number, number_text, title
               ※ 映画・単発は作らない
    WatchEvent id, streamer_id, video_id, title_raw, thumbnail_url, url,
               started_at, status (upcoming / live / completed),
               is_members_only, view_count, view_count_fetched_at, detected_at,
               description_raw, scheduled_start_at, ended_at,
               detect_source (title / description / ai_candidate), detect_keyword,
               found_via (rss / playlist / members_playlist / backfill),
               started_at_source (actual_start / scheduled_start / published_at),
               archive_gone_at, excluded_at, excluded_reason, last_checked_at, updated_at
    EventWork  watch_event_id, work_id, episode_id, confidence（多対多）,
               id, match_method, extracted_text, rule_version, created_at
    Unresolved watch_event_id, extracted_text, reason, resolved_at,
               id, detail, rule_version, created_at, updated_at
               reason = no_candidate（作品名を切り出せない）/ unidentifiable（同時視聴だが作品を特定できない）/
                        not_found（照会でヒットしない）/ ambiguous（候補が複数）/
                        not_a_work（作品ではない）/ not_in_db（作品だが外部DBに無い。AI の判定だけが付ける）/ error（照会エラー・次回再試行）
               not_a_work は「サイトに出さない」意味を持つ（Direct・スポーツ・公式番組・初配信など）。
               作品を観ているが作品名が書かれていないだけの枠（「映画同時視聴！」、企画名だけの枠）は unidentifiable にして、not_a_work に混ぜない

集計値（views_max / views_total / events_count / streamers_count /
first_event_at / latest_event_at）は DB に持たず、サイト用のデータを書き出すたび（site:data）に作り直す（2026-10-19。再生数そのものは日次の refresh で取り直す）。

### Phase 3 で足した列の意味

- `Streamer.name_en` 英語の名前。にじさんじは名簿の API の enName、ホロライブは英語版の一覧（先頭の [Affiliate]・[Alum] を外す）。ぶいすぽっ！は無い。
  取れなかったら前回の値を残す。日本以外の区分の配信者に、名前と違うときだけ併記する。1つのチャンネルにまとめた配信者はチャンネル名（FUWAMOCO）
- `Work.public_key` 作品の URL の公開キー（annict-1234 / anilist-5678 / wikidata-Q123）。work_public_keys の写し（works の行は作り直されるので、正は表のほう）

### Phase 1 で足した列の意味

- `Streamer.is_active` 公式一覧に載っていて巡回する人。卒業・引退で 0（行と過去の枠は残す）
- `Streamer.source_key` 公式サイト上の識別子（例 `nijisanji:kuzuha`）。Tier 2 は NULL
- `Streamer.branch` 所属の中の区分（2026-10-02 に追加）。にじさんじは公式の一覧のプロフィールの項目名で決める（「생일」なら kr、「Ulang Tahun」なら id、ほかは jp。
  config/roster.yaml の `branch_markers`）。ホロライブ・ぶいすぽっ！は jp。ラベルは `BRANCH_LABEL`（src/shared/types.ts。jp は「JP」）
- `WatchEvent.description_raw` extract と再判定のためだけに持つ。**公開しない**（メン限枠の本文を転載しない）
- `WatchEvent.started_at` 実開始時刻。未開始なら予定時刻（`scheduled_start_at` にも別に持つ）、ライブでない動画は公開日時
- `WatchEvent.started_at_source` started_at にどの値を入れたか（`actual_start` / `scheduled_start` / `published_at`）
- `WatchEvent.archive_gone_at` アーカイブが見られなくなった時刻。NULL でなければ一覧から消す。**行は消さない**
- `WatchEvent.excluded_at` / `excluded_reason` 判定ルールの変更で同時視聴枠でなくなった時刻と理由（`detect_rule:<語彙のバージョン>`）。
  NULL でなければ一覧から消す。**行は消さない**。ルールを戻して再び当たれば外れる
- `WatchEvent.detect_source` / `detect_keyword` どの語で判定したか。語彙の調整に使う
- `WatchEvent.detect_source = 'ai_candidate'`（2026-11-13。D-04）題名に同時視聴の語が無い候補（下の candidates）を、AI の判定役が同時視聴と答えて作った枠。
  `detect_keyword` は候補の理由（層を + でつなぐ。`same_work_members+continuation_word`）。**語彙で判定し直さない**（巡回の fetchAndUpsert・detect:rerun）。
  外すのは取り消し（`excluded_reason = 'ai_revoked'`。行は消さない）だけ。列は候補の表の詳細を写す（is_members_only は候補の表の値と videos_seen の is_members_hint の大きいほう）。
  語彙の変更で外れていた行（`detect_rule`）の動画が候補になって同時視聴と答えられたら、その行を ai_candidate の枠として戻す（video_id は1行だけ）

### Phase 2 で足した列の意味

- `Work.source` 同定した照会先（annict / anilist / wikidata）。`image_url` は AniList の画像URLで、参照するだけで保存しない
- `Work.mal_id` MyAnimeList の ID。Annict と AniList の同じ作品を1行にまとめるのに使う
- `Work.season_name` Annict・AniList は `2022-autumn`、Wikidata は年だけ（`2022`）。`series_id` は `annict:<id>` / `wikidata:<Qid>`
- `EventWork.match_method` 同定のしかた（`annict:exact`、`wikipedia:suffix` など）。`extracted_text` は一致した区間。誤同定の調査に使う
- `Unresolved` は1枠1行。あとで同定できたら `resolved_at` を立てる（行は残す）。`detail` に試した区間と候補を JSON で持つ

### 作品の属性（UI の絞り込み用。2026-10-02 決定）

外部DBから自動で埋める（手で分類しない。src/resolve/enrich.ts）。名寄せ（resolve）の最後と ai:apply のあとに、まだ埋めていない作品（attrs_at が NULL）だけを埋める。
`works:enrich --all` で全部を埋め直す。決め方の細部は docs/resolve-rules.md の「作品の属性」。

- `Work.kind` 映像の種類（anime / tokusatsu / live_action）。Annict・AniList の作品はアニメ。Wikidata の作品はジャンル・分類・シリーズから決め、どれでもなければ実写
  （実写と CG の合成を含む）。**怪獣映画（ゴジラ・ガメラ）は実写**、**仮面ライダーは作品名で特撮**、特撮は日本の作品に限る
- 映画かどうかは `Work.media`（movie）で見る（列を足さない）
- `Work.countries` 制作国（ISO 3166-1 alpha-2 の JSON の並び。順序に意味は持たせない）。分からなければ NULL（表示は「不明」）
- `Work.series_title` シリーズの名前。**シリーズのまとめ（UI）は series_title のある作品を series_id でまとめる**
  （Wikidata の P179 には一覧記事やスタジオの作品一覧も入るので、そういう項目は series_title を NULL にしてある）
- `Work.episodes_count` は Annict を正にする（Annict の ID のある作品は Annict の話数にそろえる。2026-10-09）
- 作品だが外部DBに無いもの（not_in_db）は作品の行が無いので、`kind`・`movie` を ai_decisions.extra に持つ（舞台・ミュージカルの映像は実写・映画でない）
- **ジャンルは持たない**

### 取得用の内部テーブル（公開しない）

    videos_seen   巡回で見たすべての動画（ID・タイトル・判定結果・語彙のバージョン）。
                  RSS の差分検知と、語彙を変えたときの再判定に使う。概要欄は持たない
    crawl_state   チャンネルごとの巡回状態（RSS・playlistItems の最終取得、遡りの続きのページ）
    quota_usage   API 呼び出しごとのクォータ消費（太平洋時間の日付で集計）
    runs          ジョブの実行記録（ステップごとの件数とエラー）
    event_resolution  枠ごとの名寄せの処理状態（どのルールのバージョンで処理したか）と枠の型（route・route_sub）
    resolve_cache     外部作品DBへの照会結果のキャッシュ。新しい枠の照会は30日で取り直し、ルールを直したあとのやり直しでは期限切れも使う
    ai_decisions      AI の判定（確定）。1枠に取り消されていない判定は1つ。取り消しても行は残す
    split_cours       分割クールでまとめた後半の作品（Annict の ID）と、まとめ先の前半の作品。名寄せのたびに作り直す（公開キーの転送に使う）
    work_public_keys  一度出した作品の公開キーと、そのときの外部DBの ID。同じ作品には同じキーを付け直し、行がまとまったら古いキーから 301
    candidates        題名に同時視聴の語が無い続きの回の候補（2026-11-13。D-04・docs/ai-ops.md 3章）。1動画1行で、**行を消さない**（db:pack が行の減少で止める）。
                      列: 候補の理由（reasons。層の並び）・種の枠（seeds。[{ reason, seed（watch_events.id）, key（作品名の区間）}]）・最初と最後に選んだ時刻・
                      状態（state と state_at）・詳細（videos.list。watch_events と同じ列・同じ意味。description_raw は公開しない）と取った時刻・取れなかった理由（fetch_note）・
                      枠を作らない答え（answer_status = not_watchalong / hold・answer_batch・answer_detail・答えの時刻 answered_at・answer_revoked_at）・作った枠（watch_event_id）
                      state = selected（選んだ。詳細はまだ）/ waiting（予定・配信中。次の日にもう一度詳細を取る）/ ready（終わった。判定に回す）/
                              unavailable（削除・非公開・ライブでない）/ detected（題名が変わり同時視聴の語で枠になった）/ framed（答えで枠を作った）/
                              not_watchalong（同時視聴ではない）/ hold（答えが保留）
                      選び直しでは、答える前（selected・waiting・ready）の候補だけ理由と種の枠を新しくする。枠を作った答えは ai_decisions に入る（答えの時刻はそちらの decided_at）
    site_pages        作品ページ・配信者ページの中身の指紋（再生数を除く）と、中身が変わった日（sitemap の lastmod）

### 間違えやすい点

- 企業勢は権利許諾ベースなので劇場版・単発が中心。**TVシリーズの通し視聴はほぼない**。
  エピソード進捗マップは作らない。
- 作品と枠は **EventWork 経由の多対多**。WatchEvent に work_id を
  直接持たせない。1枠で3話まとめて観る枠が普通にある。
- title_raw は原文のまま保持する。正規化した文字列で上書きしない。
- number は数値が入らない作品がある（第1羽、第壱話 など）。
  number_text を必ず併せて持つ。
- is_members_only は除外条件ではなく表示属性。バッジで示す。
- 予定枠（upcoming）は開始時刻が変わる。上書き更新前提で持つ。
- view_count は**時間とともに伸びるスナップショット**。view_count_fetched_at
  と対で扱い、日次で取り直す。ランキングは期間を区切って出す。
- 予定枠と取得不可なメン限枠は再生数が欠損。NULL と 0 を区別し、
  views_* ソートの対象外にする。
- 行の代表値は **views_max**。合計ではない（枠数の多さで有利になるため）。
- **同時視聴枠の大半はメン限枠**（権利の都合）。Phase 1 の実データでは初回に見つかった枠の約8割がメン限だった。
  メン限の動画は uploads プレイリストではなくメン限プレイリスト（`UUMO` + チャンネルIDの3文字目以降）に載るので、
  そちらも巡回・遡りする。メン限枠の再生数は API でほぼ取れない（NULL）。
- 予定枠の段階のメン限枠は uploads 側に載り、メン限プレイリストには載らない。タイトルの語（メン限・Membership Only など）で拾う。
