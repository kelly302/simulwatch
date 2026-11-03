# 開発（ファイル構成・実行方法）

CLAUDE.md から移した（2026-11-04。文言は変えずにそのまま移した）。CLAUDE.md と同じく**実装と同じコミットで直す**。未実装の決定は CLAUDE.md の冒頭の「決定済み・まだ実装していない変更」が優先する。

## 開発

### ファイル構成

    config/
      detect.yaml       判定の語彙と正規化ルール
      roster.yaml       Tier 1 の取得元（公式サイトのURL・日本の所属グループ・卒業の印・所属の中の区分の印）
      crawl.yaml        巡回頻度・クォータ上限・遡りの予算・HTTP（User-Agent と照会先ごとの間隔）
      extract.yaml      名寄せのルール（作品ではない語・ノイズ語・前後の語・Wikidata の作品クラス）
      site.yaml         サイトの設定（仮のサイトの URL・予定枠を出さなくなる時間・ランキングの枠数・ページの件数）
    src/
      cli.ts            コマンドの入口
      shared/types.ts   ジョブとフロントで共有する型
      shared/site.ts    サイト用のデータの形と、ジョブ・ビルド・ブラウザで共有する表示の決まり（種別形式・時期・話数・再生数・並べ替え）
      lib/              設定・DB（マイグレーション）・HTTP・生レスポンス・クォータ・実行コンテキスト
      youtube/          Data API のクライアントと RSS のパーサー
      roster/           公式サイトからの一覧取得と同期
      detect/           キーワード判定（純粋関数）
      crawl/            巡回ジョブ（取得元・判定と保存・状態の取り直し）
      resolve/          名寄せ（extract・照合・期と部の表記（markers）・視聴系列の期（series）・分割クールのまとめ（splitcour）・AI の判定の反映（ai）・同定の型（route）・型の記録と出し方（routing）・
                        作品の属性（enrich）・Wikidata のアニメのまとめ（link）・Annict / AniList / Wikipedia のクライアント・保存）
      report/           ローカル確認用のレポート・同定の検証用の抽出・外部DBの照会（lookup）・AI の判定の道具（ai）・
                        型ごとの抽出と AI との突き合わせ（audit）・候補を見せない待ち行列（blind）・判定役に見せる手がかり（neighbors）・AI の答えの形式（answer）・裁定と採点の HTML（review）
      publish/          サイト用のデータの書き出し（出す枠・集計値（snapshot）・作品の公開キー（keys）・書き出し（export））
    site/               Astro のサイト（srcDir）。pages/（5画面・一覧のタブとページ・JSON（pages/data/）・og:image・sitemap）・layouts/・components/・
                        lib/（ビルド時のデータ（data）・カードと行の HTML（views）・JSON の形（encode）・og:image（og））・scripts/（ブラウザの動き）・styles/・public/
    astro.config.mjs    Astro の設定（_headers・_redirects も書く）。scripts/astro.mjs は telemetry を止めて Astro を動かす
    test/               node --test のテスト
    data/               SQLite と生レスポンス・サイト用のデータ（data/site/）・og:image のキャッシュ（ローカル・コミットしない）
    dist/               ビルドしたサイト（コミットしない）
    docs/
      resolve-rules.md  名寄せの細かい決まり（src/resolve/・config/extract.yaml を変えるときに読み、同じコミットで直す）
      ai-runs.md        ゲート2の検証と AI の判定の回ごとの記録（AI の判定役は開かない）
      deploy.md         公開（アップロード）の手順と、公開の基盤の決定（Workers・R2・Secrets）
      workflows.md      Phase 4 の GitHub Actions のワークフロー（日次・手動・keepalive）・R2 の置き場所・AI の答えの取り込みの約束事・クォータ
      ai-ops.md         公開後の AI の判定の運用と、続きの回の候補の仕組み

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
    npm run cli -- ai:queue --seed ai-run-1 --n 300 --include-hold          # AI に回す型の枠の待ち行列（候補を見せない。data/ai/<batch>/。--video で動画を指定。判定済みの枠も入る）
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
    npm run cli -- site:data       # サイト用のデータを data/site/site-data.json に書き出す（公開キー・lastmod の表も更新する）
    npm run site:build             # サイトのビルド（dist/）。先に site:data
    npm run site:preview           # dist/ を http://localhost:4321 で見る（site:dev は開発用のサーバー）
    npm test                       # テスト
    npm run typecheck              # 型チェック（src・test と site）

- 各ジョブはステップ単位で失敗を記録して次へ進む。ジョブの終了コードは 0（後続のジョブを止めない）
- 生レスポンスは `data/raw/<日付>/<run_id>.jsonl.gz` に1ジョブ1ファイルで保存する（APIキーは伏せる）。
  日次ジョブは数百MBになるため、16MB ごとに gzip して追記する（メモリに溜めない）。
  生レスポンスの保存に失敗しても DB の書き戻しは必ず行う
