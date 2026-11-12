# 開発（ファイル構成・実行方法）

CLAUDE.md から移した（2026-11-04。文言は変えずにそのまま移した）。CLAUDE.md と同じく**実装と同じコミットで直す**。未実装の決定は docs/decisions.md が優先する（印「→ D-xx」の付いた文）。

## 開発

### ファイル構成

    config/
      detect.yaml       判定の語彙と正規化ルール
      roster.yaml       Tier 1 の取得元（公式サイトのURL・日本の所属グループ・卒業の印・所属の中の区分の印）
      crawl.yaml        巡回頻度・クォータ上限・遡りの予算・HTTP（User-Agent と照会先ごとの間隔）
      extract.yaml      名寄せのルール（作品ではない語・ノイズ語・前後の語・Wikidata の作品クラス）
      candidates.yaml   続きの回の候補の層と続きの語（docs/ai-ops.md 3-1）
      site.yaml         サイトの設定（仮のサイトの URL・予定枠を出すかの切り替えと出すときの時間・ランキングの枠数・ページの件数）
    src/
      cli.ts            コマンドの入口
      shared/types.ts   ジョブとフロントで共有する型
      shared/site.ts    サイト用のデータの形と、ジョブ・ビルド・ブラウザで共有する表示の決まり（種別形式・時期・話数・再生数・並べ替え）
      lib/              設定・DB（マイグレーション）・HTTP・生レスポンス・クォータ・実行コンテキスト
      youtube/          Data API のクライアントと RSS のパーサー
      roster/           公式サイトからの一覧取得と同期
      detect/           キーワード判定（純粋関数）
      crawl/            巡回ジョブ（取得元・判定と保存・状態の取り直し）
      candidates/       続きの回の候補（D-04）。選び方（select）・表への保存と videos.list（store）・候補から枠を作る・AI が足した枠を外す（frames）
      resolve/          名寄せ（extract・照合・期と部の表記（markers）・視聴系列の期（series）・分割クールのまとめ（splitcour）・AI の判定の反映（ai）・同定の型（route）・型の記録と出し方（routing）・
                        作品の属性（enrich）・Wikidata のアニメのまとめ（link）・Annict / AniList / Wikipedia のクライアント・保存）
      report/           ローカル確認用のレポート・同定の検証用の抽出・外部DBの照会（lookup）・AI の判定の道具（ai）・
                        型ごとの抽出と AI との突き合わせ（audit）・候補を見せない待ち行列（blind）・判定役に見せる手がかり（neighbors）・AI の答えの形式（answer）・裁定と採点の HTML（review）・
                        AI の答えの受け箱との出し入れ（inbox。ai:ingest・ai:pull・ai:push。ローカルのフォルダと AWS CLI の R2 を --remote で切り替える）
      publish/          サイト用のデータの書き出し（出す枠・集計値（snapshot）・作品の公開キー（keys）・書き出し（export））
    site/               Astro のサイト（srcDir）。pages/（6画面・一覧のタブとページ・JSON（pages/data/）・og:image・sitemap）・layouts/・components/・
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
`ai:pull`・`ai:push`（と `--remote r2` の `ai:ingest`）は AWS CLI（`aws`）で R2 に出し入れするので、`.env` に `R2_ACCESS_KEY_ID`・`R2_SECRET_ACCESS_KEY`・`CLOUDFLARE_ACCOUNT_ID`・`R2_BUCKET`（ローカル用の R2 トークン。docs/ai-ops.md 2-1）を入れる。
R2 を設定する前は `--remote <フォルダ>` でローカルのフォルダを R2 に見立てる（キーをそのままフォルダの下のパスにし、オブジェクトのメタデータは `<キー>.meta.json`）。

    npm install
    npm run cli -- roster          # Tier 1 の同期
    npm run cli -- crawl:hourly    # こまめな巡回（定期実行では流さない。D-01。戻すときのために残す。名前は毎時のころのまま）
    npm run cli -- crawl:daily     # 日次の巡回と遡り
    npm run cli -- refresh         # 再生数・状態の取り直しとアーカイブ死活チェック
    npm run cli -- report:detect   # 判定結果、誤検出・取りこぼしの候補
    npm run cli -- report:quota    # クォータ使用量
    npm run cli -- detect:rerun    # 語彙を変えたあとの再判定（API なし）
    npm run cli -- detect:fetch    # 再判定で新たにヒットした動画の詳細取得
    npm run cli -- resolve         # 名寄せ（未処理と照会エラーの枠。未処理の枠を先・照会エラーの枠を後に処理する）
    npm run cli -- resolve --all   # ルールを直したあとの再処理（照会はキャッシュを使う）
    npm run cli -- resolve --reason not_found   # 理由を絞って再処理
    npm run cli -- extract:test "【同時視聴】…"  # 切り出しの確認（照会しない）
    npm run cli -- resolve:summary   # 件数・成功率・理由別
    npm run cli -- unresolved:stats  # 理由別の頻出パターン
    npm run cli -- unresolved:list --reason not_found
    npm run cli -- unresolved:export # data/unresolved.json（R2 に置くファイル）（→ D-08 で R2 に置かない予定・未実装）
    npm run cli -- resolve:audit     # 誤同定の疑い
    npm run cli -- resolve:sample --n 60 --seed season-1   # 期の取り違えの検証用の抽出と確認表（data/review/）
    npm run cli -- unresolved:sample --reason not_found --n 100 --seed nf-1   # 未同定の抽出と分類用の確認表
    npm run cli -- resolve:series    # 視聴系列による期の割り当ての一覧（data/review/series-assign.md。DB は変えない）
    npm run cli -- lookup "来る" "亜人"   # 外部作品DBの照会結果を並べる（判断の確認用）
    npm run cli -- ai:queue --seed ai-run-1 --n 300 --include-hold          # AI に回す型の枠の待ち行列（候補を見せない。data/ai/<batch>/。--video で動画を指定。判定済みの枠も入る）
    npm run cli -- ai:queue --seed ai-20261113 --max-files 10 --include-hold   # 1回の上限 10ファイル＝500件。同じシードの2回目は前の待ち行列を使い、答えのそろったファイルを飛ばす。
                                                                        # YouTube はローカルの取り分（data/ai/quota.json。1日 600）で止める。最後の行に {batch, files, remaining, quotaStopped, units, reused}
    npm run cli -- ai:queue --reason not_found --n 100 --seed ai-trial-1   # 未同定の理由で選ぶ待ち行列（ai-trial-1 の形）
    npm run cli -- ai:check ai-run-1                                    # 答えのファイルの検査（形・finished_at・待ち行列を全部答えたか。ファイル・フォルダ・batch の名前）
    npm run cli -- ai:apply data/ai/ai-run-1/answers                     # 判定を入れる（確定。ファイルかフォルダ）。すでにある判定より古い答えは入れない。batch・model・finished_at の無いファイルは入れない（ai:ingest と同じ aiApply。D-09）
    npm run cli -- ai:pull [--remote r2|<フォルダ>] [--db F]             # R2 の DB を落として検査し、ローカルの写しにする（ai:pull で落としたのでない DB は上書きしない）
    npm run cli -- ai:push ai-run-1 [--remote r2|<フォルダ>]             # ai:check に通った答え（answers/*.json と直下の fix-*.json）を受け箱 ai/inbox/<batch>/ に置く
    npm run cli -- ai:ingest [--remote r2|<フォルダ>] [--result F]       # 受け箱の batch を5つまで取り込み、結果（入れた・やり直し・failed）と移す先を JSON に書く（日次のジョブ。docs/workflows.md 6）
    npm run cli -- ai:ingest --settle F [--remote r2|<フォルダ>]         # DB の書き戻しのあと、F のとおり受け箱から ai/applied/・ai/failed/ へ移し、ai/results/ の印を上書きする
    npm run cli -- ai:report ai-trial-1                                 # 判定の根拠の一覧（report.md）と採点用の report.html
    npm run cli -- ai:report ai-run-1 --exclude-scored data/ai/ai-run-1/scores-sample150.md   # 採点済みを除いた残り（保留・特定できない・外部DBに無いは全部）
    npm run cli -- ai:revoke --batch ai-trial-1                         # 判定の取り消しとルールでの名寄せし直し
    npm run cli -- ai:status                                            # サイトでの出し方ごとの件数と、AI の判定待ちの型の内訳
    npm run cli -- candidates:select                                    # 続きの回の候補（docs/ai-ops.md 3-1）を選んで候補の表（candidates）に入れる（日次。API なし）
    npm run cli -- candidates:select --dry-run                          # 表に入れず、層ごとの件数と一覧だけ（data/review/candidates-select.{json,md}。DB は読むだけ）
    npm run cli -- candidates:fetch                                     # 詳細がまだの候補と予定・配信中だった候補の videos.list（日次。50本で1ユニット。終わった動画だけ判定に回す）
    npm run cli -- works:enrich [--all]                                 # 作品の属性（映像の種類・制作国・シリーズの名前）を外部DBから埋める
    npm run cli -- audit:types                     # 同定の型ごとの件数と目印の重なり（data/audit/types.md。DB は変えない）
    npm run cli -- audit:sample --seed audit-1     # 型ごとの抽出。AI に見せる待ち行列と封をしたルールの答え（data/audit/<batch>/）
    npm run cli -- audit:sample --seed audit-2 --exclude audit-1 --n 50 --type "unique_exact,not_a_work_rule:スポーツ"   # 層を絞った測り直し
    npm run cli -- audit:compare audit-1           # AI の答えとルールの答えの突き合わせ（mismatches.md・summary.md・裁定用の review.html）
    npm run cli -- site:data       # サイト用のデータを data/site/site-data.json に書き出す（公開キー・lastmod の表も更新する）
    npm run site:build             # サイトのビルド（dist/）。先に site:data
    npm run site:preview           # dist/ を http://localhost:4321 で見る（site:dev は開発用のサーバー）
    npm run cli -- db:check --gz pulled.sqlite.gz --expect head.json --observed observed.json   # 取得した DB の検査（日次の 2-3。外れたら終了コード 1）
    npm run cli -- db:pack --against observed.json --out out/ --run-id R --writer daily      # 書き戻す前の後始末と gzip・メタデータ（日次の 2-4。外れたら終了コード 1）
    npm run -s cli -- site:fingerprint --commit <sha>   # サイトの中身の指紋（fingerprint=…。site-data.json が無ければ終了コード 1）
    npm run -s cli -- job:due --meta head.json          # 保険の cron で日次を流すか（due=true|false）
    npm run cli -- runs:summary --since <ISO> --out "$GITHUB_STEP_SUMMARY"   # この回の実行記録の要約（数・状態・エラーだけ）
    npm test                       # テスト
    npm run typecheck              # 型チェック（src・test と site）

- 各ジョブはステップ単位で失敗を記録して次へ進む。ジョブの終了コードは 0（後続のジョブを止めない）。
  **例外**: `db:check`・`db:pack` はワークフローを止めるための道具なので、外れたら終了コード 1 を返す（取得した DB が壊れている・行を消さない表の行が減ったときに、巡回・書き戻しをさせない。docs/workflows.md 2-3・2-4）。
  `site:fingerprint` も site-data.json が無ければ 1（site:data が失敗した回にビルドとアップロードをさせない。docs/workflows.md 3-1 の 13）。
  `ai:check`・`ai:pull`・`ai:push` も、通らない・落とせない・置けないときは 1（判定のワークフローが次へ進まないように。docs/ai-ops.md 4-2）。`ai:ingest` は 0（結果は JSON。docs/workflows.md 6）
- YouTube のクォータ: 定期実行のジョブ（hourly・daily）は `stop_at` から AI の判定の取り分 `ai_reserve` を引いた値（9,000 − 600 = 8,400）で止める（config/crawl.yaml）
- ログと実行記録（runs）に出す URL は、クエリの値を伏せてパラメータの名前だけ残す（`src/lib/http.ts` の redactUrl。公開リポジトリの Actions のログは誰でも見られる）。生レスポンスは伏せない
- 生レスポンスは `data/raw/<日付>/<run_id>.jsonl.gz` に1ジョブ1ファイルで保存する（APIキーは伏せる）。
  日次ジョブは数百MBになるため、16MB ごとに gzip して追記する（メモリに溜めない）。
  生レスポンスの保存に失敗しても DB の書き戻しは必ず行う
