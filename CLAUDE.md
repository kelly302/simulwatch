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
| 規模 | 配信者282人（日本の所属240・EN 42）、一覧に出る同時視聴枠 約7,300（作品を付けて出す4,929・枠として出す118・作品ではない2,216・保留32）、作品 約1,600（2026-10-11 時点。AI の判定待ちを消化し、巡回を流したあと）。**作品は千件〜数千件の規模**（当初の想定「100〜300件」から改めた）。企業勢の同時視聴は単発の映画が中心で、作品の種類はロングテールになる（2026-09 の初回名寄せで、重複を除いた作品名の候補4,351のうち3,380が1回しか出てこない） |
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
| 対象範囲 | Tier 1 = にじさんじ / ホロライブ / VSPO! の日本の所属チャンネルと、**NIJISANJI EN・hololive EN**（2026-10-02 決定で追加。API は無料の範囲で）。**hololive ID・VSPO! EN は入れない**（2026-10-09 決定。将来は入れるかもしれない）。にじさんじの公式の一覧に入っている統合した旧 NIJISANJI KR（11人）・旧 NIJISANJI ID（6人）は外さない。どれも所属の中の区分（branch: jp / kr / id / en）で絞れるようにする。EN・旧 KR・旧 ID の枠もサイトに全部出す（日本人向けの枠だけに絞らない。2026-10-03 決定）。1つのチャンネルで配信する組は1配信者にまとめ、名前はチャンネル名から取る（**FUWAMOCO**。2026-10-09 決定。チャンネル名から取れなければタレントの名前を「＆」でつなぐ）。holoAN は公式アナウンサーで holoAN room は番組「昼ホロ」のチャンネルなので、名簿の対象のグループから外す（2026-10-03 決定） |
| Tier 1 の取得元 | 各事務所の公式サイト。取得に失敗したら前回の一覧を保持する |
| 卒業・引退 | 公式一覧から外れたら巡回を止める（is_active=false）。取得済みの枠はアーカイブが残る限り表示する |
| シード拡張 | Tier 2 = 関心作品名からの逆引きでチャンネルを自動追加。**Phase 5（Phase 4 の公開後）に実装する** |
| ライブでない同時視聴動画 | 除外しない（Twitch での同時視聴の再アップなど）。actualStartTime が無いので started_at は publishedAt で代用し、started_at_source に記録する |
| 遠い先の予定枠 | 開始が30日以上先の予定枠は除外する（予定表代わりの枠）。行は残し、名寄せと公開の対象から外す |
| 作品ではない同時視聴 | Direct・スポーツ・公式番組・初配信・バラエティ・テレビのドキュメンタリーなどは unresolved の中で「作品ではない」（not_a_work）という別の理由に分け、抽出エラーと混ぜない。サイトには出さない。何が作品で何が作品でないかは下の「作品かどうかの境目」 |
| 作品だが外部DBに無いもの | 映画・ドラマ・アニメ・舞台やミュージカルの映像・事務所のアニメやドラマ（ホロぐら）は、外部DBに無くても作品ではない扱いにしない。**枠として出す**（作品ページは作らない）（2026-09-28 決定） |
| 作品種別 | アニメ限定にしない。映画・実写・特撮も含める |
| 作品の属性（UI の絞り込み） | 映像の種類（アニメ / 特撮 / 実写）・映画かどうか（media が movie）・制作国・シリーズのまとめ。**ジャンルは持たない**。外部DBから自動で埋める（2026-10-02 決定。詳細は「作品の属性」） |
| 話数の粒度 | 持つが必須にしない。映画・単発は Episode を作らない |
| メン限枠 | 一覧に載せる。is_members_only でバッジ表示 |
| 主要指標 | 再生数。ランキングと並び順に使う |
| 作品ページ | 配信者単位に集約。1配信者＝1行、枠は展開 |
| 配信者ページ | 作品単位に集約。1作品＝1行、枠は展開 |

## 作品かどうかの境目

「作品ではない」枠はサイトに出さない（未同定の理由 not_a_work）。誤ると枠がサイトから消えるので、同定と同じ重さで扱う。
AI の判定役に渡す GUIDE（src/report/blind.ts）と同じ内容にそろえる。**境目を足したら両方を直し、過去の判定で当てはまる枠も直す。**

作品ではない:

- Direct・スポーツ・公式番組・初配信
- ライブ・コンサートの映像、事務所の番組（歌謡祭・にじバラ・ラジオ）、MV、テレビのバラエティ（水曜どうでしょう）、M-1（2026-09-28）
- 配信者本人の生誕祭の映像（ミュージカル仕立てでも）、配信者本人の周年記念配信の本編、同僚の周年記念のミュージカル・映像（2026-10-01・10-09）
- 配信者自身・同僚のボイス商品・ASMR、自分の MV のプレミア公開、同時視聴の枠の切り抜き（#shorts）（2026-10-01）
- ゲーム会社の番組（中でショートアニメ・PV・ファン制作のアニメが流れても。HoYoFair）、ほかの配信者の企画配信（にじさんじ甲子園・ミリしら杯）（2026-10-01）
- テレビの特番（本編の総復習ダイジェストなど。「水星の魔女 Season1 総復習ダイジェスト」）（2026-10-03）
- リアリティ番組（バチェラー・ジャパン）、オーディション番組（No No Girls）（2026-10-03・10-09。テレビのバラエティと同じ）
- **テレビのドキュメンタリー**（メーデー！：航空機事故の真実と真相、自然・歴史のドキュメンタリー番組。2026-10-09 決定）。
  配信サービスのドキュメンタリーのシリーズも同じに扱う。題名が書かれていなくても、ドキュメンタリー番組を観る枠だと分かれば作品ではない

作品:

- 映画・ドラマ・アニメ・舞台やミュージカルの映像・事務所のアニメやドラマ（ホロぐら）。**外部DBに無くても作品ではない扱いにしない**（枠として出す。作品ページは作らない。2026-09-28）
- 劇場総集編（外部DBにある）
- 歌の映像でできたアニメーションの作品（ALIEN STAGE。2026-10-03）、歌だけで物語を通すミュージカルのアルバムに付けた映像を通して観る枠（EPIC: The Musical。2026-10-09）
- フェイクドキュメンタリー（作りものの映像作品。TXQ FICTION・フェイクドキュメンタリー「Q」・このテープもってないですか？。2026-10-09）
- 劇場公開のドキュメンタリー映画（作品ではないのは「テレビの」ドキュメンタリー。映画は作品のまま。2026-10-09 確認）
- #shorts でもライブ配信（縦型配信）は普通の枠。作品ではないのは同時視聴の枠の切り抜きの動画だけ（2026-10-03）

作品を観ているが作品名が書かれていないだけの枠（「映画同時視聴！」、企画名だけの枠）は「作品を特定できない」（unidentifiable）で、作品ではない枠に混ぜない（枠として出す）。

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

- 画面ごとに分割する。**全データを1ファイルにまとめない**。1ファイル数十KBを目安にする（絞り込み用の全件の索引（ID だけ）と辞書は例外）。
- トップは3ブロックぶん生成する（ランキングは期間3種）。
- 各一覧は、一覧表示に必要な項目だけを入れる。
- 作品ページと配信者ページの本文は HTML に持たせ、ページごとの JSON は作らない（2026-10-03 決定。下の「Phase 3 の UI・SEO の決定」）。
- **作品一覧は並び順ごとに300件ずつのページ JSON に分ける**（作品は数千件になり、一覧の項目だけでも1ファイルの目安を超えるため）。
  検索は作品名だけの軽い索引を別に作り、検索欄を触ったときに読む（ゲート2で決定）。

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

### Phase 3 の UI・SEO の決定（2026-10-02〜03。実装はこれから）

UI を作る別の会話で、モックアップを見ながら決めた（2026-10-03 に SEO のレビューを受け、推奨をすべて採用）。2026-10-09 の整理でその会話の記録から写し、ユーザーが確認した。

画面:

- 作品種別は「アニメ / 特撮 / 実写」（「海外」はやめた）。種類と映画は1軸にまとめない
- 作品ページ: 所属の内訳は出さない。「同じシリーズの作品」（series_id。放送順）を置く。パンくず（トップ › 作品 › 種類 › 作品名）
- 配信者ページ: 全行を HTML に出す（「さらに表示」なし）。読みがなは Annict にしかないので、漢字の作品名は名前順で末尾に寄る。
  Annict のシリーズは区切りが一定でない（Fate の UBW の1期と2期が別のシリーズ）ので、シリーズ名で並べる案は使わない
- 1枠に複数作品が付く枠は作品名を並べる（3行で切る）。行・カードに「種別形式 · 時期（または話数）」。サムネには何も重ねない
- 所属の表記: 一覧の行は「にじさんじ EN」（日本は区分を書かない）。枠カードは日本以外の区分だけ名前の後ろに小さく。EN・KR・ID の配信者は英語の名前を併記
- 一覧: 作品一覧の種類のタブ・配信者一覧の所属のタブはリンク（/works/anime/、/streamers/nijisanji/ のような静的な一覧ページ。画面の使い回し）。
  作品一覧の既定の並びはページ送りのリンク（300件ずつ）。配信者一覧は全員を1ページに、区分はページの中のチェック
- h1 は「同時視聴された作品」「同時視聴した配信者」。トップにも h1。Web フォントはやめて端末のフォント

SEO・実装:

- **本文はビルド時の HTML、JSON は操作のあとだけ**。トップは HTML にランキング3期間・これから始まる枠・新しい順24枠 → 「さらに表示」で新しい順300枠の JSON →
  絞り込み・並べ替え・300枠より先で全件の索引（ID だけ）と辞書。件数は索引を読んだあとに出す
- URL: 作品は外部DB の ID（annict > anilist > wikidata）を**一度決めたら変えない公開キーの列**にする（works.id は名寄せで消して作り直されるので使えない）。
  行をまとめて変わったら Cloudflare の _redirects で 301（固定の転送は2,000件まで）。配信者は channel_id。絞り込み・並び順は URL に出さない。末尾スラッシュ・自己参照の canonical
- インデックス: 配信者1人の作品ページも noindex にしない（中身を厚くする）。枠0のページは作らず 404。JSON は X-Robots-Tag: noindex（robots.txt で塞がない）。
  sitemap の lastmod はデータが変わった日
- title の例「コマンドー（1985年の映画）の同時視聴 配信者10人・15枠 | 同時視聴まとめ」。構造化データは BreadcrumbList・WebSite・作品の Movie/TVSeries と sameAs（Wikidata・Annict など）。VideoObject は使わない
- og:image はビルドで作る自作の画像（作品ページ・配信者ページごと。YouTube・AniList の画像を使わない）。ほかのページはサイト共通の1枚
- 英語の名前: にじさんじは名簿で読んでいる API の応答の enName（追加の取得なし）。ホロライブは /en/talents?gp=<group>（今の parseHololiveGroup のまま読める。
  取得が17回増える。[Affiliate]・[Alum] を外す）。Streamer に列を足す（列の名前は未定）
- Cloudflare Pages の無料プランは1サイト20,000ファイルまで。**作品ページごとの JSON は作らず、HTML に持たせる**
- 公開の手順の下書きと未決事項（Pages か Workers か・独自ドメイン・生レスポンスの保存期間など）は docs/deploy.md
- 公開後: Search Console で、配信者1人の作品ページとそれ以外のインデックス状況を分けて見る

## ソートとフィルター

ソートは「キー」＋「共通の逆順トグル」。昇順・降順を別の選択肢にしない。

    作品ページ      既定 views_max。選択 latest_event_at
    配信者ページ    既定 名前順（読みがな、無ければ作品名。2026-10-03 決定）。選択 latest_event_at / views_max
    作品一覧        既定 配信者数。選択 views_max / latest_event_at
    配信者一覧      既定 latest_event_at 降順。選択 枠数 / 作品数

作品一覧の既定（配信者数）で同じ配信者数の作品は、latest_event_at の降順で並べる
（作品の約3分の2は配信者数1で同順位になるため。ゲート2で決定）。

views_total / events_count / first_event_at は表示専用。ソートキーにしない。
views_* のソートは実施済み枠のみを対象にする。

**views_max が空（NULL）の行の並び**（メン限枠の再生数は API 仕様上取得できないため）:

- views_max でのソート中、views_max が NULL の行は**逆順トグルに関係なく末尾**に置き、その中では latest_event_at の降順で並べる
- NULL を「0」として扱わない（0回再生の公開枠と区別する）
- トップのランキングは公開枠のみで決まる（意図どおり）

「同時視聴した枠」のフィルターは4軸（2026-10-03 決定。期間は外した）。所属 / 作品（種類・映画かどうか（すべて / 映画 / 映画以外）・制作国（すべて / 日本 / 海外。合作は両方に入り、不明はどちらにも入らない））/ 放送年・放送期 / メン限。
所属の絞り込みは、事務所の下に区分（`Streamer.branch`）のチェックボックスを置く（にじさんじ: 日本 / KR / ID / EN、ホロライブ: 日本 / EN。2026-10-02 決定。親は一部選択の表示）。データにある区分だけを出す。

## データモデル

    Streamer   id, name, affiliation, branch, channel_id, platform, icon_url, tier,
               is_active, source_key, channel_title,
               first_seen_at, last_listed_at, deactivated_at, updated_at
    Work       id, annict_id, anilist_id, wikidata_id, title, title_kana,
               media (tv / movie / ova / web), season_name, series_id,
               episodes_count, image_url, mal_id, release_year, source,
               kind (anime / tokusatsu / live_action), countries, series_title, attrs_at,
               created_at, updated_at
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
first_event_at / latest_event_at）は日次バッチで作り直す。

### Phase 1 で足した列の意味

- `Streamer.is_active` 公式一覧に載っていて巡回する人。卒業・引退で 0（行と過去の枠は残す）
- `Streamer.source_key` 公式サイト上の識別子（例 `nijisanji:kuzuha`）。Tier 2 は NULL
- `Streamer.branch` 所属の中の区分（2026-10-02 に追加）。にじさんじは公式の一覧のプロフィールの項目名で決める（「생일」なら kr、「Ulang Tahun」なら id、ほかは jp。
  config/roster.yaml の `branch_markers`）。ホロライブ・ぶいすぽっ！は jp。ラベルは `BRANCH_LABEL`（src/shared/types.ts）
- `WatchEvent.description_raw` extract と再判定のためだけに持つ。**公開しない**（メン限枠の本文を転載しない）
- `WatchEvent.started_at` 実開始時刻。未開始なら予定時刻（`scheduled_start_at` にも別に持つ）、ライブでない動画は公開日時
- `WatchEvent.started_at_source` started_at にどの値を入れたか（`actual_start` / `scheduled_start` / `published_at`）
- `WatchEvent.archive_gone_at` アーカイブが見られなくなった時刻。NULL でなければ一覧から消す。**行は消さない**
- `WatchEvent.excluded_at` / `excluded_reason` 判定ルールの変更で同時視聴枠でなくなった時刻と理由（`detect_rule:<語彙のバージョン>`）。
  NULL でなければ一覧から消す。**行は消さない**。ルールを戻して再び当たれば外れる
- `WatchEvent.detect_source` / `detect_keyword` どの語で判定したか。語彙の調整に使う

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
    resolve_cache     外部作品DBへの照会結果のキャッシュ（30日）。ルールを直して再処理するときに同じ照会を繰り返さない
    ai_decisions      AI の判定（確定）。1枠に取り消されていない判定は1つ。取り消しても行は残す

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
- **「同時視聴前」を含むタイトルは同時視聴枠にしない**（「同時視聴前に待ち合わせ！」などの前座・待機枠。ゲート2で17枠を外した）
- **英語のタイトル**（2026-10-02。NIJISANJI EN・hololive EN を足したとき、保存済みの全タイトル（約29万本）で当たり方を確かめた）: 「watchalong」に加えて
  「watching party」（大空スバルの枠など16本。すべて同時視聴）・「movie night」（EN の9本。すべて同時視聴）・タイトルの先頭か括弧の直後の「watching」
  （25本中24本が同時視聴。外れは「Watching My Own Stream」）。文中の watching（「BIG ROCO IS WATCHING YOU」）は拾わない。
  「watch party」は eスポーツの観戦が大半（59本中、作品は姫森ルーナの4本）なので入れない。メン限の語に「member's only」「MEMBERS STREAM」なども足した
- `line_require` に「を見ます」「を観ます」を入れている（概要欄の「A、B、Cを見ます」を名寄せで作品名の列挙として使うため）。
  2026-09-24 に生レスポンスに残っている全動画（142,152本）で比べ、概要欄での検出は20本のまま増えなかった

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

### 名寄せ（extract / resolve）

**方針: 取りこぼしより誤同定のほうが害が大きい。** ルールは `config/extract.yaml`。変えたら `resolve --all` で再処理する。

**細かい決まり（区間の切り方・足切り・期の取り違えの規則・Wikidata のラベル・視聴系列・作品の属性）は docs/resolve-rules.md にある。
src/resolve/ と config/extract.yaml を変えるときは先に読み、同じコミットで直す。** ここには骨子だけを書く。

- extract（照会しない純粋関数）: タイトルを括弧・ノイズ語・区切り記号で**区間**に分ける。『』「」の中身は優先の区間。話数とハッシュタグは位置も残す。
  `not_a_work` の語があれば「作品ではない」にする。その枠の区間が作品にも当たれば（完全一致・ほぼ同じ作品名）、理由は not_a_work のまま型を not_a_work_conflict にして AI に回す
- resolve: 枠ごとの候補を段に分ける（括弧の中身 → 括弧の外の区間 → 小区間 → 概要欄 → ハッシュタグ）。**前の段で作品が決まれば、後の段は照会も採用もしない**
- 1つの区間の照会の順: Annict → AniList → 日本語版 Wikipedia の記事名 → Wikipedia の全文検索 → Wikidata のラベル。前で決まらなかったときだけ次へ
- **区間の照合キーが作品名（原題・英題・ローマ字）と完全一致したときだけ採用する**。部分一致・別名（AniList の synonyms・Wikidata の alias）・別名の辞書・誤字の吸収は使わない
- 期は外部DBの区切りのまま別作品として扱う。**作品の単位も話の番号も Annict に従う**（分割クールか本当の2期かはこちらで決めない。2026-09-30）
- **実写は Wikidata のシリーズ全体の項目にそろえる**（シーズンの項目に当たったら P179 のシリーズに付け替え、話数を付けない。src/resolve/lift.ts。2026-10-02）。
  アニメでもサウスパークは、Annict がシーズンごとに作品を分けているが、全体の項目（wikidata:Q16538）にまとめる（2026-10-03 のユーザーの決定。AI の判定で付ける）
- 同じ配信者が同じ区間で2枠以上観ている**視聴系列**で、期を割り当てる（src/resolve/series.ts）
- Wikidata で引いたアニメは、MyAnimeList・AniList の ID でアニメのDBの行にまとめる（src/resolve/link.ts）。同じ MyAnimeList の ID を持つ別作品があるので、
  ID を持つ作品が複数あるときはまとめない
- 名寄せの最後に、DB 全体で作品の属性（enrich）と枠の型（routing）を付け直す
- **どの枠にも付いていない作品は消す**（外部DBから作り直せる派生データ）。works.id は変わりうるので、公開の URL には使わない
- 照会エラーは `error` として残し、次の `resolve` で再試行する
- 照会結果は resolve_cache に30日持つ。キャッシュが効いていれば `resolve --all` は数秒〜数分。新しい照会は1区間あたり約2.5秒
  （5つの照会先を逐次・間隔を空けて引く。2026-10-03 の EN 1,264枠の初回は83分）。キャッシュが切れたあとの `resolve --all` は全部を聞き直す
- **英語のタイトルの枠（EN）は AI の判定に任せる**（2026-10-03 決定）。照会先が日本語版 Wikipedia で、英題だけの一致は足切りで採用しないので、ルールではほぼ決まらない。ルールに英語の照会は足さない

## 同定の型と AI の判定（ゲート2の決定）

**目的はサイトに出る同定の正しさ。** ルールで誤って同定するくらいなら AI の確認に回す。同定できた割合は参考値にする。
経緯・検証（audit-1〜3）・回ごとの結果と採点は docs/ai-runs.md。

### 型と、サイトでの出し方

- 枠ごとに、同定の経路と危なさで**型**を1つ付ける（`ROUTE_ORDER` の先に当たった目印。src/resolve/route.ts）。名寄せのたびに DB 全体で
  `event_resolution.route`・`route_sub` に記録する（src/resolve/routing.ts）
  - 同定済み: series（視聴系列）→ multi（複数作品）→ tiebreak（手がかりで選んだ）→ season_variant → sub_desc_tag（小区間・概要欄・ハッシュタグ）→ search（全文検索）→
    label（Wikidata のラベル）→ disambiguation（同名の曖昧さ回避ページ）→ prefix_sibling（区間の名前がほかの期・劇場版の作品名の頭と同じ）→ suffix（「(映画)」など）→
    redirect → live_action_tv（Wikidata だけで引いた実写のテレビ作品）→ unique_exact。どれでもなければ other_identified
  - 未同定: not_a_work_rule（語の種類まで分ける）・not_a_work_conflict（作品ではない語に当たったが、区間が作品にも当たる）・unidentifiable_rule・unresolved
  - 確定の AI の判定: ai_*
- **型ごとの抽出で1件でも誤りが見つかった型は、ルールで決めずに AI に回す**（許容値は数字で決めない）。AI に回す型は config/extract.yaml の `ai_routes`:
  series・tiebreak・sub_desc_tag・disambiguation・prefix_sibling・redirect・live_action_tv・not_a_work_conflict・unidentifiable_rule・unresolved。
  ルールのまま出す型は multi・season_variant・search・label・suffix・unique_exact・not_a_work_rule
- **AI に回す型の枠は、AI が確かめるまでサイトに出さない**（2026-10-01 の決定 (a)）。AI が保留にした枠も出さない
- サイトでの出し方は `publishState`（src/resolve/route.ts）。Phase 3 の publish はこれに従う。件数は `ai:status`

      work        作品を付けて出す
      frame       枠として出す（作品だが外部DBに無い・作品を特定できない・確度 low の同定）。作品ページは作らない
      hidden      出さない（作品ではない）
      pending_ai  AI の判定待ち（出さない）

- 取りこぼし（ルールの答えが AI の答えの一部。サイトに出ないだけ）は型の「誤り」に数えない。件数は記録して改善の材料にする
- 公開後も、型ごとの AI との一致率で確定・AI 行きを上げ下げする（足切りを手で足し続けない。`ai_routes` を変える）
- 新しい枠の5〜6割は AI の判定待ちで始まる（2026-10-09 の DB で日本の所属の57%、EN の90%。未同定が約3割、ルールが同定したが誤りの出た型が約4分の1）

### AI の判定のしかた（src/resolve/ai.ts・src/report/ai.ts・blind.ts・neighbors.ts・answer.ts）

- **人が起動するコマンドでだけ入れる**（定期実行のジョブからは呼ばない。有料APIを使わない）。Claude Code のセッションから、サブエージェントに判定させる
- 手順: `ai:queue --seed <batch> --n N --include-hold` → サブエージェント（1ファイル50件。5本ずつ並行）→ `ai:apply data/ai/<batch>/answers` → `ai:report <batch>`。
  判定役に渡す指示文は `ai:queue` が data/ai/<batch>/PROMPT.md に書き出す（<NN> を待ち行列の番号に置き換えて、そのまま渡す）
- 判定のあと、同じ配信者・同じ作品の枠を DB で並べ、判定役のあいだで答えが割れていないか確かめてそろえる（期・編で分かれた作品、版でずれる話数、Annict と Wikidata の両方にある作品で割れやすい）
- **CLAUDE.md を直した会話のままサブエージェントを起動すると、古い CLAUDE.md が渡る**（会話が始まったときに読み込んだ写しが渡る。2026-10-09 に確かめた）。
  直した直後に判定を回すときは、会話を開き直してから起動する
- **判定役は候補を見ずに自分で答える**（候補を見せると同意に引っ張られる）。渡すのは data/ai/<batch>/GUIDE.md と queue/NN.md だけ。
  使えるのは thumbs/ のサムネイル（画像を直接見る）と `lookup`。sealed/・DB・src/・config/・ほかのバッチ・data/review・data/audit・docs/ は開かせない。
  照会の出力は `work/<番号>/` に分ける（共用の一時ファイルで照会結果が混ざったため）
- 判定役に見せるもの: 配信者・日時・タイトル・概要欄（定型文を除く）・サムネイル・同じ配信者の同じ作品名の枠（近い10枠まで）・前後の枠（各3枠）・
  概要欄のリンク先の題名／公開年／あらすじの冒頭（1枠3件まで。設定は config/extract.yaml の `ai_context`）。型・区間・候補・ルールの答え・ほかの枠の答えは見せない。
  ルールの答えは `sealed/answers.json` に固定し、判定が終わるまで開かない
- 答えの区分: identified / not_a_work / not_in_db（作品だが外部DBに無い）/ unidentifiable / hold。確度は high / medium / low（**low はサイトに作品を出さない**）。
  not_a_work・not_in_db は lookup の記録が無ければ受け付けない。not_in_db は作品名・kind・movie を ai_decisions.extra に持つ
- **迷ったら hold**（埋めることが目的ではない）。ただし手がかり（同じ配信者のほかの枠・リンク先）まで見て決められるなら決める。
  期・編で作品が分かれていて通し番号や回数しか無い枠は、どの数え方でも確かに含まれる作品だけを答える。
  **英語のタイトルの枠は無理に同定しない**（はっきり分かるときだけ答える。保留でよい）
- **確定**: 判定は `ai_decisions` に1枠1行（取り消しは `revoked_at`。行は残す）。取り消されていない判定（hold 以外）の枠は resolve の対象から外し、最後に判定を入れ直す。
  ルールを直して `resolve --all` しても上書きしない。hold の枠は `--include-hold` を付けたときだけ次の待ち行列に出す
- AI が選んだ Wikidata の項目は、ルールの作品クラスに加えて `wikipedia.ai_extra_work_classes` も受け付ける（ルールの照合には使わない）
- 採点: `ai:report` の表（report.html）は**確度 high 以外・保留・特定できない・`--video` の枠を全部**出す（2026-10-03 決定。AI の判定はある程度任せる）。
  `--sample N` は high からの抜き取り、`--include-high` で全部。採点は scores.md に書き出す。回をカンマでつなぐと複数の回を1つの表にまとめる（`ai:report ai-run-3,ai-run-4`）
- 採点・境目の決定で答えを直すときは、data/ai/<batch>/fix-*.json に答えを書いて `ai:apply` する（前の判定は取り消しになり、行は残る）
- 同じ誤りを AI が繰り返し直しているなら、ルールにする
- サムネイルは判定のためだけにローカルへ落とす（サイトには使わない）。判定のファイルと採点の表はメン限枠の概要欄を含みうるので公開しない（data/ はコミットしない）
- **回ごとの結果・採点・直した枠は docs/ai-runs.md に書き、CLAUDE.md には書かない**。判定役は起動時に CLAUDE.md を読むので、ここに書いた過去の答えが目に入る
  （ai-run-3 の判定役の報告で分かった）

## ルール

- **壊れる前提で設計する。** 1ステップが失敗しても他を止めない
- **取得失敗時に既存データを消さない。** 古くても残す方がマシ
- API クォータを使い切らない。日次で使用量をログに残す
- 外部APIは逐次リクエスト。AniList は約90req/分を超えない
- YouTube API の表示要件を守る（帰属表示・サムネの扱い・再生数は30日ごとに更新）
- サムネに再生ボタン風のアイコンを置かない（押しても遷移するため）
- 取得した生レスポンスはデバッグ用に保存する
- **CLAUDE.md と docs/resolve-rules.md は実装と同じコミットで更新する。** 仕様が変わったらコードと一緒に直す。AI の判定の回ごとの記録は docs/ai-runs.md に書く

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
      roster.yaml       Tier 1 の取得元（公式サイトのURL・日本の所属グループ・卒業の印・所属の中の区分の印）
      crawl.yaml        巡回頻度・クォータ上限・遡りの予算・HTTP（User-Agent と照会先ごとの間隔）
      extract.yaml      名寄せのルール（作品ではない語・ノイズ語・前後の語・Wikidata の作品クラス）
    src/
      cli.ts            コマンドの入口
      shared/types.ts   ジョブとフロントで共有する型
      lib/              設定・DB（マイグレーション）・HTTP・生レスポンス・クォータ・実行コンテキスト
      youtube/          Data API のクライアントと RSS のパーサー
      roster/           公式サイトからの一覧取得と同期
      detect/           キーワード判定（純粋関数）
      crawl/            巡回ジョブ（取得元・判定と保存・状態の取り直し）
      resolve/          名寄せ（extract・照合・期と部の表記（markers）・視聴系列の期（series）・AI の判定の反映（ai）・同定の型（route）・型の記録と出し方（routing）・
                        作品の属性（enrich）・Wikidata のアニメのまとめ（link）・Annict / AniList / Wikipedia のクライアント・保存）
      report/           ローカル確認用のレポート・同定の検証用の抽出・外部DBの照会（lookup）・AI の判定の道具（ai）・
                        型ごとの抽出と AI との突き合わせ（audit）・候補を見せない待ち行列（blind）・判定役に見せる手がかり（neighbors）・AI の答えの形式（answer）・裁定と採点の HTML（review）
    test/               node --test のテスト
    data/               SQLite と生レスポンス（ローカル・コミットしない）
    docs/
      resolve-rules.md  名寄せの細かい決まり（src/resolve/・config/extract.yaml を変えるときに読み、同じコミットで直す）
      ai-runs.md        ゲート2の検証と AI の判定の回ごとの記録（AI の判定役は開かない）
      deploy.md         公開（アップロード）の手順の下書きと未決事項

### 実行方法

Node.js 24 以上。TypeScript はビルドせず Node の型除去でそのまま実行する。
`.env.example` を `.env` にコピーして `YOUTUBE_API_KEY` と `ANNICT_TOKEN` を入れる（`.env.example` にはキーを書かない）。
`ANNICT_TOKEN` が無ければ AniList と Wikipedia だけで名寄せする。

    npm install
    npm run cli -- roster          # Tier 1 の同期
    npm run cli -- crawl:hourly    # 毎時の巡回
    npm run cli -- crawl:daily     # 日次の巡回と遡り
    npm run cli -- refresh         # 再生数・状態の取り直しとアーカイブ死活チェック
    npm run cli -- report:detect   # 判定結果、誤検出・取りこぼしの候補
    npm run cli -- report:quota    # クォータ使用量
    npm run cli -- detect:rerun    # 語彙を変えたあとの再判定（API なし）
    npm run cli -- detect:fetch    # 再判定で新たにヒットした動画の詳細取得
    npm run cli -- resolve         # 名寄せ（未処理と照会エラーの枠）
    npm run cli -- resolve --all   # ルールを直したあとの再処理（照会はキャッシュを使う）
    npm run cli -- resolve --reason not_found   # 理由を絞って再処理
    npm run cli -- extract:test "【同時視聴】…"  # 切り出しの確認（照会しない）
    npm run cli -- resolve:summary   # 件数・成功率・理由別
    npm run cli -- unresolved:stats  # 理由別の頻出パターン
    npm run cli -- unresolved:list --reason not_found
    npm run cli -- unresolved:export # data/unresolved.json（R2 に置くファイル）
    npm run cli -- resolve:audit     # 誤同定の疑い
    npm run cli -- resolve:sample --n 60 --seed season-1   # 期の取り違えの検証用の抽出と確認表（data/review/）
    npm run cli -- unresolved:sample --reason not_found --n 100 --seed nf-1   # 未同定の抽出と分類用の確認表
    npm run cli -- resolve:series    # 視聴系列による期の割り当ての一覧（data/review/series-assign.md。DB は変えない）
    npm run cli -- lookup "来る" "亜人"   # 外部作品DBの照会結果を並べる（判断の確認用）
    npm run cli -- ai:queue --seed ai-run-1 --n 300 --include-hold          # AI に回す型の枠の待ち行列（候補を見せない。data/ai/<batch>/。--video で動画を指定）
    npm run cli -- ai:queue --reason not_found --n 100 --seed ai-trial-1   # 未同定の理由で選ぶ待ち行列（ai-trial-1 の形）
    npm run cli -- ai:apply data/ai/ai-run-1/answers                     # 判定を入れる（確定。ファイルかフォルダ）
    npm run cli -- ai:report ai-trial-1                                 # 判定の根拠の一覧（report.md）と採点用の report.html
    npm run cli -- ai:report ai-run-1 --exclude-scored data/ai/ai-run-1/scores-sample150.md   # 採点済みを除いた残り（保留・特定できない・外部DBに無いは全部）
    npm run cli -- ai:revoke --batch ai-trial-1                         # 判定の取り消しとルールでの名寄せし直し
    npm run cli -- ai:status                                            # サイトでの出し方ごとの件数と、AI の判定待ちの型の内訳
    npm run cli -- works:enrich [--all]                                 # 作品の属性（映像の種類・制作国・シリーズの名前）を外部DBから埋める
    npm run cli -- audit:types                     # 同定の型ごとの件数と目印の重なり（data/audit/types.md。DB は変えない）
    npm run cli -- audit:sample --seed audit-1     # 型ごとの抽出。AI に見せる待ち行列と封をしたルールの答え（data/audit/<batch>/）
    npm run cli -- audit:sample --seed audit-2 --exclude audit-1 --n 50 --type "unique_exact,not_a_work_rule:スポーツ"   # 層を絞った測り直し
    npm run cli -- audit:compare audit-1           # AI の答えとルールの答えの突き合わせ（mismatches.md・summary.md・裁定用の review.html）
    npm test                       # テスト
    npm run typecheck              # 型チェック

- 各ジョブはステップ単位で失敗を記録して次へ進む。ジョブの終了コードは 0（後続のジョブを止めない）
- 生レスポンスは `data/raw/<日付>/<run_id>.jsonl.gz` に1ジョブ1ファイルで保存する（APIキーは伏せる）。
  日次ジョブは数百MBになるため、16MB ごとに gzip して追記する（メモリに溜めない）。
  生レスポンスの保存に失敗しても DB の書き戻しは必ず行う

## 残る課題と未確定（実装前に確認すること）

未確定（ユーザーの判断待ち）:

- **予定枠・配信中の枠と AI の判定待ち**: 新しい枠の5〜6割は AI の判定待ちで始まり、判定するまでサイトに出ない。予定枠は開始までの数日しか無いので、
  判定の間隔が空くと「これから始まる枠」に間に合わない。判定の頻度を上げるか、予定枠・配信中の枠だけ出し方を変えるかは未決
- **AI の判定の公開後の運用**: 頻度と、誰がいつ起動するか。DB は R2 にあり毎時のジョブが書くので、ローカルで判定した答えを R2 の非公開領域に置き、
  resolve のジョブが取り込む案（ai:apply は同じファイルを何度入れても同じ結果）
- 公開まわりの未決事項（Pages か Workers か・独自ドメイン・生レスポンスの保存期間など）は docs/deploy.md
- 仕様に書いていない判断が必要になったら先に聞く

残る課題:

- 巡回は手で流している（最後は 2026-10-11。定期実行は Phase 4）。流すたびに新しい枠の5〜6割が AI の判定待ちになる（10/11 は43枠中24枠）
- 開始予定が過ぎたまま upcoming の枠がある（2020-08 の予定枠が1つ）。「これから始まる枠」に出し続けないよう、Phase 3 で扱いを決める
- resolve_cache の30日は Phase 2 で置いた既定値で、決定や外部の条件から来た数字ではない（AniList の規約は期間を定めず、溜め込み・大量収集を禁じている）。
  切れたあとに `resolve --all` をすると全部を聞き直す（見積もり約5時間。AniList の照会だけで約17,500回・90回/分）。最初の照会ぶんは 2026-10-24 にまとめて切れる。
  期限の扱いを変えるか（やり直しでは期限切れも使う、など）は未決
- 同じ作品群でも照会先でシリーズが分かれる（Annict の「劇場版 名探偵コナン」と Wikidata の「Detective Conan」、「劇場版ポケットモンスター」と「ポケットモンスター (劇場版)」）。Phase 3 の表示で寄せるか決める
- Wikidata に特撮の手がかりが無い作品は実写になる（仮面ライダーは作品名で拾う。戦隊・ウルトラマンは今は取りこぼしが無いので足していない）
- Wikidata のラベルが崩れている作品がある（「麻雀放浪記#映画 麻雀放浪記」）。Thunderbolt Fantasy（人形劇）は Annict にあるのでアニメになる
- Annict・AniList の検索はひらがなとカタカナを区別するので、「ゆるきゃんΔ」では劇場版が候補に出てこない

## フェーズ

    Phase 1  取得基盤（済。ゲート1を 2026-09-23 に通過）
    Phase 2  名寄せ（済。ゲート2を 2026-10-09 に通過）
    Phase 3  集計と UI（5画面、画面ごとの JSON）                        ← 次
    Phase 4  公開と定期実行（Actions・R2・Pages）
    Phase 5  Tier 2（作品名からの逆引きでチャンネルを追加する discover）。Phase 4 の公開後に着手

- Phase 3 → 4 は続けて進めてよい
- AI の判定待ちは 2026-10-11 に消化した（残りは保留の30枠）。巡回を再開すると新しい枠の判定待ちが出るので、Phase 3 と並行して判定を続ける。今の件数は `ai:status`、経過は docs/ai-runs.md

## 回答のルール

- 日本語で回答する
- 推測で実装しない。仕様が決まっていないところは先に聞く
- 設計上迷った点は報告に含める
- **検証の結果には、必ず手順を一緒に書く**。母集団（何を除いたかも）・抽出のしかた（シードなど再現できる形）・DB のどの状態か・
  1件ごとに並べた項目・判定の基準（抽出の前に決める）・1件ごとの判定と理由。手順の分からない検証結果は判断に使えない
- 抽出の件数から言える範囲も書く（例: 60件で0件なら、誤りの割合の95%上限は約5%）。その手順で検出できない誤りの種類があれば、そう書く
- **指示は最低限であって上限ではない**。目的に対して足りないと思ったら、指示になくてもやる。やったことと、やらなかったことは報告する
- **「分からない」「判断がつかない」と書く前に、自分で確かめられる手段があるなら使う**（Annict・AniList・Wikipedia への照会、サムネイルを見る など）。
  使ったうえで分からなかったなら、何をどう調べて分からなかったかを書く
- **検証を報告するときは、その手順では検出できない誤りの種類を自分で挙げる**
