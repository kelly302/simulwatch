# 配信同時視聴まとめ

## これは何か

配信者の「同時視聴（ミラー配信）」を作品起点で探せる公開Webサイト。

- 作品起点で「この作品を同時視聴した配信者」を引けない
- 配信者起点で「過去に何を観たか」の一覧がない
- 予定枠と過去アーカイブが同じ場所で見られない

## 最重要の設計原則

**データの最小単位は「配信者」ではなく「同時視聴イベント（配信枠 × 作品）」。**

1枠で複数話を観ることがあるため、枠と作品は多対多。
作品側は「シリーズ」「期」「話数」を分けて持つ。これを崩す変更はしないこと。

**作品の同定は外部作品DBのIDを正とする。**

枠タイトルからの抽出は自前、同定は外部DBに任せる。
アニメは Annict（主軸）→ AniList（補完）、実写・特撮・海外作品は日本語版 Wikipedia で検索して Wikidata の ID に解決する。
自前で作品マスタを育てようとしないこと。

## 確定している前提

| 項目 | 決定 |
| --- | --- |
| 公開範囲 | 一般公開する。リポジトリも公開 |
| 登録 | 全自動。手登録・手動キュレーションはしない |
| 作品同定 | アニメ: Annict（主軸）→ AniList（補完）。実写・特撮・海外作品: 日本語版 Wikipedia の検索APIで候補を探し Wikidata の ID に解決（Wikidata 単体は表記ゆれに弱いので検索は Wikipedia 側）。**TMDb は使わない**（広告を載せるため商用扱い。tmdb_id のような列も作らない） |
| 作品画像 | アニメは AniList の画像URLを参照する。**自前で保存しない**（規約のデータ溜め込み禁止）。実写・特撮・海外作品は画像を持たない（画像なしのカード表示を用意する） |
| 広告 | 掲載する。YouTube デベロッパーポリシー III.G により、YouTube API のデータを含むページで広告を出すには YouTube 由来でない独立した価値のある情報が同じページに必要。**サムネを並べただけのページを作らず、作品情報や集計値を必ず併せて表示する** |
| 有料API | 使わない。無料枠のみで完結させる |
| 取得方式 | チャンネルRSS（毎時・クォータ0）＋ YouTube Data API（毎時の状態取得・日次の全巡回）の併用。詳細は「取得パイプライン」 |
| 判定 | 枠タイトル・概要欄のキーワード判定 |
| 名寄せ失敗 | unresolved として保持し、**エラーとして修正する**。捨てない |
| 動画 | 再アップロード・埋め込み再生はしない。YouTubeへ送客する |
| アーカイブなし | アーカイブが残っていない枠は一覧から消す |
| 対象範囲 | Tier 1 = にじさんじ / ホロライブ / VSPO! の**日本の**所属チャンネル（約240人）。海外支部（NIJISANJI EN、hololive EN/ID、VSPO! EN）は含めない。複数タレントの共用チャンネル（holoAN の @holoANroom など）は1配信者ではないので対象外 |
| Tier 1 の取得元 | 各事務所の公式サイト。取得に失敗したら前回の一覧を保持する |
| 卒業・引退 | 公式一覧から外れたら巡回を止める（is_active=false）。取得済みの枠はアーカイブが残る限り表示する |
| シード拡張 | Tier 2 = 関心作品名からの逆引きでチャンネルを自動追加。**Phase 5（Phase 4 の公開後）に実装する** |
| ライブでない同時視聴動画 | 除外しない（Twitch での同時視聴の再アップなど）。actualStartTime が無いので started_at は publishedAt で代用し、started_at_source に記録する |
| 遠い先の予定枠 | 開始が30日以上先の予定枠は除外する（予定表代わりの枠）。行は残し、名寄せと公開の対象から外す |
| 作品ではない同時視聴 | Direct・スポーツ・公式番組・初配信などは unresolved の中で「作品ではない」という別の理由に分け、抽出エラーと混ぜない。サイトには出さない |
| 作品種別 | アニメ限定にしない。映画・実写・特撮も含める |
| 話数の粒度 | 持つが必須にしない。映画・単発は Episode を作らない |
| メン限枠 | 一覧に載せる。is_members_only でバッジ表示 |
| 主要指標 | 再生数。ランキングと並び順に使う |
| 作品ページ | 配信者単位に集約。1配信者＝1行、枠は展開 |
| 配信者ページ | 作品単位に集約。1作品＝1行、枠は展開 |

## 技術スタック

| 役割 | 採用 |
| --- | --- |
| 言語 | TypeScript。ジョブもフロントもそろえ、型定義を共有する |
| フロント | Astro の SSG。ソートとフィルターはブラウザ側で処理する |
| データの置き場 | SQLite。R2 の非公開領域に置き、ジョブの開始時に取得して終了時に書き戻す |
| 生レスポンス | R2 の非公開領域 |
| ホスティング | Cloudflare Pages。Actions からの直接アップロードでデプロイする（Pages のビルド機能は使わない） |
| 定期実行 | GitHub Actions の schedule |
| 秘密情報 | APIキー類は GitHub Actions の Secrets に置く。リポジトリにコミットしない |

- SQLite はリポジトリにコミットしない。
- 多重書き込みは Actions の concurrency で防ぐ。
- 再生数の取り直しと集計値の再生成は、毎時の巡回とは別の**日次ワークフロー**に分ける。

### クライアントに渡す JSON

- 画面ごとに分割する。**全データを1ファイルにまとめない**。1ファイル数十KBを目安にする。
- トップは3ブロックぶん生成する（ランキングは期間3種）。
- 各一覧は、一覧表示に必要な項目だけを入れる。
- 作品ページと配信者ページは、ページ単位で個別に生成する。

## 画面構成

画面は5つ。トップ / 作品一覧 / 配信者一覧 / 作品ページ / 配信者ページ。
トップに検索窓は置かない。検索と絞り込みは各一覧ページの中に置く。
モバイル前提。出口は YouTube（サムネをクリックで遷移。埋め込み再生はしない）。

トップは3ブロック。すべてグリッド表示で、並び順とフィルターはブロックごとに独立。

    1. ランキング        枠単位。期間内の再生数順。既定7日（7/30/全期間）
    2. これから始まる枠  upcoming と live。配信中は LIVE バッジで先頭固定
    3. 同時視聴した枠    completed のみ。既定は started_at 降順

行の表示項目は、並び替えのキーと開く判断に要る値だけに絞る。

    作品ページの配信者行   アイコン / 名前 / 所属 / メン限バッジ / views_max / 最終視聴日
    配信者ページの作品行   作品名 / 最終視聴日 / 枠数
    作品一覧の作品行     作品画像 / 作品名 / 観た配信者数 / 最終視聴日
    展開行               日付 / 再生数 / メン限バッジ / サムネ。日付の昇順

## ソートとフィルター

ソートは「キー」＋「共通の逆順トグル」。昇順・降順を別の選択肢にしない。

    作品ページ      既定 views_max。選択 latest_event_at
    配信者ページ    既定 latest_event_at 降順。選択 views_max
    作品一覧        既定 配信者数。選択 views_max / latest_event_at
    配信者一覧      既定 latest_event_at 降順。選択 枠数 / 作品数

views_total / events_count / first_event_at は表示専用。ソートキーにしない。
views_* のソートは実施済み枠のみを対象にする。

**views_max が空（NULL）の行の並び**（メン限枠の再生数は API 仕様上取得できないため）:

- views_max でのソート中、views_max が NULL の行は**逆順トグルに関係なく末尾**に置き、その中では latest_event_at の降順で並べる
- NULL を「0」として扱わない（0回再生の公開枠と区別する）
- トップのランキングは公開枠のみで決まる（意図どおり）

「同時視聴した枠」のフィルターは5軸。所属 / 作品種別 / 放送年・放送期 / 期間 / メン限。

## データモデル

    Streamer   id, name, affiliation, channel_id, platform, icon_url, tier,
               is_active, source_key, channel_title,
               first_seen_at, last_listed_at, deactivated_at, updated_at
    Work       id, annict_id, anilist_id, wikidata_id, title, title_kana,
               media (tv / movie / ova / web), season_name, series_id,
               episodes_count, image_url
    Episode    id, work_id, number, number_text, title
               ※ 映画・単発は作らない
    WatchEvent id, streamer_id, video_id, title_raw, thumbnail_url, url,
               started_at, status (upcoming / live / completed),
               is_members_only, view_count, view_count_fetched_at, detected_at,
               description_raw, scheduled_start_at, ended_at,
               detect_source (title / description), detect_keyword,
               found_via (rss / playlist / members_playlist / backfill),
               started_at_source (actual_start / scheduled_start / published_at),
               archive_gone_at, excluded_at, excluded_reason, last_checked_at, updated_at
    EventWork  watch_event_id, work_id, episode_id, confidence（多対多）
    Unresolved watch_event_id, extracted_text, reason, resolved_at

集計値（views_max / views_total / events_count / streamers_count /
first_event_at / latest_event_at）は日次バッチで作り直す。

### Phase 1 で足した列の意味

- `Streamer.is_active` 公式一覧に載っていて巡回する人。卒業・引退で 0（行と過去の枠は残す）
- `Streamer.source_key` 公式サイト上の識別子（例 `nijisanji:kuzuha`）。Tier 2 は NULL
- `WatchEvent.description_raw` extract と再判定のためだけに持つ。**公開しない**（メン限枠の本文を転載しない）
- `WatchEvent.started_at` 実開始時刻。未開始なら予定時刻（`scheduled_start_at` にも別に持つ）、ライブでない動画は公開日時
- `WatchEvent.started_at_source` started_at にどの値を入れたか（`actual_start` / `scheduled_start` / `published_at`）
- `WatchEvent.archive_gone_at` アーカイブが見られなくなった時刻。NULL でなければ一覧から消す。**行は消さない**
- `WatchEvent.excluded_at` / `excluded_reason` 判定ルールの変更で同時視聴枠でなくなった時刻と理由（`detect_rule:<語彙のバージョン>`）。
  NULL でなければ一覧から消す。**行は消さない**。ルールを戻して再び当たれば外れる
- `WatchEvent.detect_source` / `detect_keyword` どの語で判定したか。語彙の調整に使う

### 取得用の内部テーブル（公開しない）

    videos_seen   巡回で見たすべての動画（ID・タイトル・判定結果・語彙のバージョン）。
                  RSS の差分検知と、語彙を変えたときの再判定に使う。概要欄は持たない
    crawl_state   チャンネルごとの巡回状態（RSS・playlistItems の最終取得、遡りの続きのページ）
    quota_usage   API 呼び出しごとのクォータ消費（太平洋時間の日付で集計）
    runs          ジョブの実行記録（ステップごとの件数とエラー）

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

## 取得パイプライン

    1. discover  同時視聴キーワードで動画検索し、ヒットした
                 チャンネルを追跡対象に自動登録する
    2. crawl     追跡対象チャンネルを巡回（検索APIより低コスト）
    3. detect    タイトル・概要欄から同時視聴枠を判定
    4. extract   作品名・話数の候補文字列を切り出す
    5. resolve   Annict / AniList（アニメ）、Wikipedia → Wikidata（実写・特撮・海外作品）に照会して作品ID・話数を確定
    6. publish   解決済みのみ作品ページに反映
    7. refresh   再生数の取り直しと集計値の再生成、アーカイブ死活チェック

### crawl の分担（RSS と API の併用）

    毎時  チャンネルRSSで投稿済み動画の差分を検知する（クォータ0）
          予定枠と LIVE の状態は API で取得する
    日次  playlistItems で全チャンネルを巡回し、RSS の取りこぼしを回収する

- RSS は直近15件程度しか返さない。予定枠は RSS にも載る（2026-09-23 の実データで予定枠40件すべて）。
  当初の「RSS に予定枠が載らない」という前提はゲート1で撤回した。
- それでも**予定枠の鮮度は API 側でも担保する**。毎時の playlistItems 順繰りは各チャンネル12時間ごとに縮小して残す。
  浮いた予算（約1,500ユニット/日）は Tier 2（Phase 5）用に確保する。

実装上の分担（`config/crawl.yaml` で調整する）:

    毎時 crawl:hourly  1. 全チャンネルの RSS（クォータ0）
                       2. playlistItems をチャンネルの一部ずつ（各チャンネルを12時間ごと）
                       3. 判定 → ヒットだけ videos.list → WatchEvent
                       4. upcoming / live の枠を videos.list で取り直す（開始時刻・状態を上書き）
    日次 roster        公式サイトと Tier 1 を同期、channels.list でアイコン更新
    日次 crawl:daily   全チャンネルの uploads 先頭50件 ＋ メン限プレイリスト（UUMO…）
                       ＋ 詳細を取り損ねたヒットの回収 ＋ 過去分の遡り（予算内でページを進める）
    日次 refresh       全 WatchEvent の再生数・状態の取り直しとアーカイブ死活チェック

### detect の実装ルール

- 語彙・正規化は `config/detect.yaml`。語彙を変えると判定バージョンが変わり、次に見たときに再判定される。
  `detect:rerun` で保存済みタイトルを API なしで再判定できる（概要欄は保存していないのでタイトルのみ）
- 概要欄は行単位で見る。**その枠自体を指す語（今日・本日・今回・この配信 など、`line_require`）を含む行だけ**をヒットにする。
  否定語（ご遠慮・禁止・NG など）や二次利用ルール（ガイドライン・切り抜き など）を含む行は無視する
- 詳細を取って WatchEvent を作る時点で、取得したタイトル・概要欄を今の語彙で判定し直す（古いルールでヒットした保留分が入らないように）
- `detect:rerun` は既存の WatchEvent も判定し直し、当たらなくなった枠は `excluded_at` を立てて外す（行は消さない）
- 概要欄の**定型文**は無視する。同じチャンネルの動画のうち `template_min_repeats` 本以上に出る行
  （チャンネル紹介・メンバー特典の一覧など）。実データでは概要欄ヒットの大半がこれだった
- ライブ配信でない動画も同時視聴枠にする（`reject.require_live: false`）。Twitch での同時視聴の再アップがあるため。
  started_at は publishedAt で代用し、`started_at_source = published_at` と記録する
- is_members_only は「メン限プレイリスト（UUMO…）に載っている」か「タイトルにメン限の語がある」で立てる

### アーカイブ消失の判定

- videos.list に返ってこない、または privacyStatus が public 以外（限定公開・非公開）なら
  `archive_gone_at` を立てて一覧から消す。行は消さない
- 日次の refresh は消失済みの枠も見に行き、また見られるようになっていれば戻す
- 1バッチ（10件以上）の半分超が欠けたら API 側の異常とみなして消失判定を見送る
  （取得失敗時に既存データを消さない）

同定に失敗した枠は黙って捨てず、**修正対象のエラーとして一覧できるようにする**。
同時視聴が1件もない作品はページを作らない。

### unresolved の確認方法

- unresolved は R2 の JSON に出力し、**ローカルの CLI** で一覧・件数・頻出パターンを確認する。
- GitHub Issues への自動起票はしない。公開サイトにも出さない。

## ルール

- **壊れる前提で設計する。** 1ステップが失敗しても他を止めない
- **取得失敗時に既存データを消さない。** 古くても残す方がマシ
- API クォータを使い切らない。日次で使用量をログに残す
- 外部APIは逐次リクエスト。AniList は約90req/分を超えない
- YouTube API の表示要件を守る（帰属表示・サムネの扱い・再生数は30日ごとに更新）
- サムネに再生ボタン風のアイコンを置かない（押しても遷移するため）
- 取得した生レスポンスはデバッグ用に保存する
- **CLAUDE.md は実装と同じコミットで更新する。** 仕様が変わったらコードと一緒に直す

## やらないこと

- 動画の再アップロード・自前ホスティング・埋め込み再生
- 手動でのチャンネル登録・作品紐付け運用
- メン限枠の本文内容の転載
- 有料APIの利用
- 視聴に必要な配信サービスの取得・表示（スコープ外）

## 判定と正規化の方針

- detect のキーワードは**部分一致**。「同時視聴」で「同時視聴会」も拾えるので、
  派生語を列挙しない。
- コア語から始め、語彙の最終的な中身と正規化ルールの細部は**実装側で決めてよい**。
  ただし語彙はコードに埋めず設定ファイルに出し、後から足せるようにする。
- 語を広げるコストは処理量ではなく**誤検出**。「実況」のような語は
  ゲーム実況を大量に引っかけるので入れない。
- 誤検出と同定失敗は unresolved に溜まる。**その中身を見て語彙を調整する**。
- 関心作品リストの初期投入はしない。Tier 1 の巡回で実際に出てきた作品だけを
  Tier 2 の逆引きに使う（search は100ユニットと高いため、空振りを打たない）。

## 実行環境と巡回頻度

- 自宅PCの起動を前提にしない。GitHub Actions の schedule で回す
- 無料枠で完結させる
- 巡回は最短1時間ごとまで許容。YouTube の10,000ユニット/日に収める
  （playlistItems.list / videos.list は1ユニット、search は100ユニット）
- 再生数の取り直しと集計値の再生成は日次でよい
- 予定枠は開始時刻が変わるので、巡回ごとに上書きする

## 運用

### schedule の60日自動停止への対策

公開リポジトリでは、60日間コミットがないと GitHub Actions の schedule が自動で止まる。
データは R2 に置いてコミットしないため、このままだと止まる。

- まずは**月1回の軽いコミット**（keepalive ワークフロー）で様子を見る。
- それでも止まるようなら、Cloudflare Workers Cron から workflow_dispatch で
  起動する方式に切り替える。

### 外部APIの利用条件

- **AniList**: 月の収益が150ドル未満なら商用でも無料。**150ドルを超えたら商用ライセンスが必要**になる。
  広告収益を確認し、超えそうになったら対応すること
- **TMDb は使わない**（広告を載せるため商用扱いになる）
- **YouTube**: 広告を出すページには YouTube 由来でない独立した価値のある情報（作品情報・集計値）を必ず置く（デベロッパーポリシー III.G）。
  再生数は30日以内に取り直す（日次の refresh で満たす）

## 開発

### ファイル構成

    config/
      detect.yaml       判定の語彙と正規化ルール
      roster.yaml       Tier 1 の取得元（公式サイトのURL・日本の所属グループ・卒業の印）
      crawl.yaml        巡回頻度・クォータ上限・遡りの予算
    src/
      cli.ts            コマンドの入口
      shared/types.ts   ジョブとフロントで共有する型
      lib/              設定・DB（マイグレーション）・HTTP・生レスポンス・クォータ・実行コンテキスト
      youtube/          Data API のクライアントと RSS のパーサー
      roster/           公式サイトからの一覧取得と同期
      detect/           キーワード判定（純粋関数）
      crawl/            巡回ジョブ（取得元・判定と保存・状態の取り直し）
      report/           ローカル確認用のレポート
    test/               node --test のテスト
    data/               SQLite と生レスポンス（ローカル・コミットしない）

### 実行方法

Node.js 24 以上。TypeScript はビルドせず Node の型除去でそのまま実行する。
`.env.example` を `.env` にコピーして `YOUTUBE_API_KEY` を入れる（`.env.example` にはキーを書かない）。

    npm install
    npm run cli -- roster          # Tier 1 の同期
    npm run cli -- crawl:hourly    # 毎時の巡回
    npm run cli -- crawl:daily     # 日次の巡回と遡り
    npm run cli -- refresh         # 再生数・状態の取り直しとアーカイブ死活チェック
    npm run cli -- report:detect   # 判定結果、誤検出・取りこぼしの候補
    npm run cli -- report:quota    # クォータ使用量
    npm run cli -- detect:rerun    # 語彙を変えたあとの再判定（API なし）
    npm run cli -- detect:fetch    # 再判定で新たにヒットした動画の詳細取得
    npm test                       # テスト
    npm run typecheck              # 型チェック

- 各ジョブはステップ単位で失敗を記録して次へ進む。ジョブの終了コードは 0（後続のジョブを止めない）
- 生レスポンスは `data/raw/<日付>/<run_id>.jsonl.gz` に1ジョブ1ファイルで保存する（APIキーは伏せる）。
  日次ジョブは数百MBになるため、16MB ごとに gzip して追記する（メモリに溜めない）。
  生レスポンスの保存に失敗しても DB の書き戻しは必ず行う

## 未確定（実装前に確認すること）

- 現時点でなし。仕様に書いていない判断が必要になったら先に聞く

## フェーズ

    Phase 1  取得基盤（済）
    Phase 2  名寄せ（extract / resolve / EventWork / Unresolved）       ← ゲート2で止まる
    Phase 3  集計と UI（5画面、画面ごとの JSON）
    Phase 4  公開と定期実行（Actions・R2・Pages）
    Phase 5  Tier 2（作品名からの逆引きでチャンネルを追加する discover）。Phase 4 の公開後に着手

## 回答のルール

- 日本語で回答する
- 推測で実装しない。仕様が決まっていないところは先に聞く
- 設計上迷った点は報告に含める
