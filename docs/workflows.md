# GitHub Actions のワークフロー（Phase 4 の仕様の下書き）

2026-10-23 の下書き。2026-10-27 に**日次だけ**に作り直し、Fable のレビューの指摘を直した。**2026-11-13 に実装した**（塊 F。`.github/workflows/` の3本・`scripts/ci/`・`wrangler.jsonc`。ファイルとローカルで通す方法は 13）。
GitHub での起動・R2 との往復・Workers へのアップロードはまだ（リポジトリと Secrets の用意と push のあと。段6）。決めることは末尾の「11. 決めること」。

- 出発点は docs/deploy.md の「2. Claude が作るもの」と「守ること」。公開の基盤は docs/deploy.md 6章の決定（2026-10-26: **Workers の静的アセット**・独自ドメインなし・生レスポンス30日・R2 を使う）に合わせた
- AI の判定の答えの作り方（ローカルの側）は docs/ai-ops.md。**ジョブが取り込む側の約束事は、この文書の 6 が正**（別のファイルには置かない）
- 見積もりの元にした DB は 2026-10-22 22:03 の data/db.sqlite の写し（`VACUUM INTO` で取った。338MB → 332MB）。API を呼ぶジョブは流していない

## 0. 2026-10-27 のユーザーの決定と、この文書への影響

- トップの「これから始まる枠」（予定枠・配信中の枠・LIVE バッジ）をやめる。CLAUDE.md の「これは何か」の3つめ（予定枠と過去アーカイブを同じ場所で）も目的から外す
- **2時間ごとの巡回・ワークフローはやめ、日次だけにする**。予定枠のデータは今までどおり DB に取る（終わってから判定されて出る）。需要があれば表示と頻度を戻せる形にしておく（→ 付録）
- 日次のジョブの時刻は**日本時間 05:23（UTC 20:23）**（2026-10-30 ユーザー決定。→ 5-2）

この文書で変えたこと: 2時間ごとのワークフローを消した／`crawl:hourly` は日次で流さない（3-1）／クォータの表から2時間ごとのぶんを外した（7）／アップロードは月に約30回（2-6）。
コード（`crawl:hourly`・`config/crawl.yaml` の hourly の設定・`site.yaml` の `upcoming_stale_hours`）は消さない（戻すときに使う。UI の側の直しは別の会話）。

## 1. 全体像

### ワークフローは3本

| ワークフロー | ファイル | 起動 | 中身 | DB を書くか |
| --- | --- | --- | --- | --- |
| 日次 | `daily.yml` | schedule（1日1回）＋保険の cron（5-2）＋ボタン | DB を取得 → `roster` → `crawl:daily` → `refresh` → 候補 → AI の答えの取り込み → `resolve` → `site:data` → DB を書き戻す → ビルド → アップロード | 書く |
| 手動（publish） | `publish.yml` | `workflow_dispatch` | DB を取得 →（入力しだいで `resolve --all`）→ `site:data` → DB を書き戻す → ビルド → アップロード（本番かプレビュー） | 書く（下の注意） |
| keepalive | `keepalive.yml` | schedule（月1回）＋ボタン | 軽いコミットを1つ push する | 書かない |

- **手動も DB を書く**。`site:data` は作品の公開キーの表（work_public_keys）と lastmod の表（site_pages）を DB に書くので（docs/ui.md「Phase 3 の実装」）、書き戻さないと R2 の DB とずれる。
  そのため日次と同じ concurrency の組に入れる（→ 5-1）

### R2 の置き場所（非公開のバケット1つ）

| キー | 中身 | 書くもの | 消す |
| --- | --- | --- | --- |
| `db/db.sqlite.gz` | 正の DB（gzip。2026-10-22 の写しで 332MB → 57MB）。**検査用の値（sha256・行数・user_version・run_id・書いた時刻）はこのオブジェクトのメタデータに持つ**（2-3） | 日次・手動 | 上書き |
| `db/backup/<日付>.sqlite.gz` | その日の最初の書き戻しの前の DB（→ 11-4） | 日次 | ライフサイクルで14日 |
| `raw/<日付>/<run_id>.jsonl.gz` | 生レスポンス（今の `data/raw/` と同じ形） | 日次・手動 | ライフサイクルで30日（docs/deploy.md 6-4 の決定） |
| `ai/inbox/<batch>/*.json` | AI の判定の答え（ローカルの `ai:push` が置く） | ローカル | 取り込んだら移す |
| `ai/applied/<batch>/*.json` | 取り込み済みの答え | ジョブ | 消さない（小さい） |
| `ai/failed/<batch>/*.json` | 取り込めなかった答え（6-3） | ジョブ | 人が見て直す |
| `ai/results/<batch>/<run_id>.json` | 取り込みのたびの記録（始めた印 → 結果） | ジョブ | 消さない |
| `site/last-deploy.json` | 最後に本番へアップロードした中身の指紋・コミット・時刻（→ 2-6） | 日次・手動 | 上書き |

og:image のキャッシュは R2 ではなく Actions のキャッシュに置く（→ 2-5）。

**試しの置き場所**（2026-11-13。塊 F）: Variable の `R2_PREFIX`（例 `test/`）があれば、上のすべてのキーの先頭に付ける（`test/db/db.sqlite.gz` など。ワークフローのシェルも CLI の `--remote` の層も同じ）。
本物の DB を置く前に、写しをここに置いて日次を1周する（13）。`R2_PREFIX` がある回は**本番にアップロードしない**（日次・手動の最初のステップ `start` が、target が production なら赤で止める。schedule の回も止まる）。試しが済んだら Variable を消し、バケットの `test/` も消す

## 2. 共通の部品

### 2-1. 準備

    actions/checkout（既定のブランチ）
    actions/setup-node（Node 24。cache: npm）
    npm ci
    環境変数: YOUTUBE_API_KEY・ANNICT_TOKEN（Secrets）。DATA_DIR は既定の ./data のまま

`.env` は無いが、`npm run cli` は `--env-file-if-exists` なので環境変数だけで動く。

### 2-2. R2 との出し入れの道具

**推奨: GitHub のランナーに入っている AWS CLI（S3 互換の API）。** wrangler は Workers へのアップロードだけに使う。

| | AWS CLI（S3 互換） | wrangler の `r2 object get/put` |
| --- | --- | --- |
| 1ファイルの上限 | 無し（大きいファイルは分割アップロード） | 315MB（DB は gzip しないと超える） |
| 一覧（受け箱の中身を見る） | `aws s3 ls`・`aws s3 mv` | **一覧のコマンドが無い**（受け箱の取り込みが組めない） |
| オブジェクトのメタデータ | `--metadata` で付け、`aws s3api head-object` で読む | — |
| 認証 | R2 の API トークン（`R2_ACCESS_KEY_ID`・`R2_SECRET_ACCESS_KEY`。Object Read & Write、バケット限定） | Cloudflare の API トークン（R2 の権限を足す） |

- 接続先は `https://<CLOUDFLARE_ACCOUNT_ID>.r2.cloudflarestorage.com`、リージョンは `auto`（R2 の文書の AWS CLI の例。2026-10-27 に読んだ）
- **確かめること**: 新しい AWS CLI が既定で付けるチェックサムが R2 と合わないことがあると言われる（`AWS_REQUEST_CHECKSUM_CALCULATION=when_required`・`AWS_RESPONSE_CHECKSUM_VALIDATION=when_required`）。
  R2 の文書の AWS CLI の例には書かれていない（2026-10-27。2026-11-13 に読み直しても書かれていない）。**ワークフローでは付けた**（2026-11-13。daily.yml・publish.yml の env。
  2025 年より前の AWS CLI の既定の動きなので、付けて困ることは無い見込み）。段6 の往復で、外しても通るかを確かめる（外せるなら外す）。ローカルの `.env` には付けていない
- **AWS CLI の版**: ランナーに入っている版は画像の更新で変わるので、`scripts/ci/install-aws.sh` で 2.39.1（2026-10-28 のタグ）を入れる（`AWS_CLI_VERSION`。awscli.amazonaws.com から HTTPS で落とす。署名（PGP）の照合はしていない）
- **ローカルの道具**（2026-10-30 ユーザー決定。詳細は docs/ai-ops.md の 2-1）:
  - ローカルにも AWS CLI を入れる（`winget install Amazon.AWSCLI`）。S3 の SDK は依存に足さない（ジョブとローカルで道具がそろう）
  - `ai:pull`・`ai:push` は CLI のコマンドにし、中から `aws` を子プロセスで呼ぶ。ローカルは一覧を使わない。**`ai:push` が書くのは `ai/inbox/` だけ**（DB・`ai/applied/`・`ai/failed/`・`ai/results/` はジョブだけが書く）
  - 鍵は Actions とは**別の、ローカル用の R2 トークン**（Object Read & Write・このバケットだけ）を `.env` に置く。`.env.example` に足す名前は
    `R2_ACCESS_KEY_ID`・`R2_SECRET_ACCESS_KEY`・`CLOUDFLARE_ACCOUNT_ID`・`R2_BUCKET`（Actions の Secrets・Variables と同じ名前。8）
  - チェックサムの設定（上）が要ると分かったら、ジョブとローカルの両方に付ける

### 2-3. DB の取得と検査（止める側）

    1. aws s3api head-object で db/db.sqlite.gz のメタデータ（sha256・行数・user_version・run_id・written_at）を読む
    2. aws s3 cp で db/db.sqlite.gz を落とす → gzip -t → 展開して data/db.sqlite に置く
    3. npm run cli -- db:check --expect meta.json      ← 新しいコマンド（→ 9）

**DB と検査用の値は1つのオブジェクトにまとめる**（Fable の高-2）。別のファイル（db.meta.json）にすると、片方だけ書けたときに対が崩れ、以後の全ジョブが検査で止まって戻す手順が無い。
S3 互換の PUT は1回で中身とメタデータを一緒に置き換えるので、対は崩れない。メタデータは数百バイト（S3 の上限は 2KB）。

`db:check` が見ること（**どれか1つでも外れたら終了コード 1 で、ワークフローをそこで止める**。巡回もアップロードもしない）:

- ファイルがある・空でない（**DB が無ければ作らない**。`openDb` は無いと空の DB を作ってマイグレーションするので使わない。ファイルの有無を先に見てから、マイグレーションをしない開き方で開く）
- `PRAGMA quick_check` が ok（332MB で 0.3秒。日次は `integrity_check`（1.3秒）にしてもよい）
- メタデータの sha256 と、落とした gzip の sha256 が同じ
- `user_version` がコードのマイグレーションの数以下（新しいコードで作った DB を古いコードで開かない）
- 行を消さない表（2-4）の行数がメタデータの行数と同じ

**R2 に DB が無い・落とせない・検査に通らない**ときは止める。空の DB を作って始めない。1回目（R2 に置く前）だけは docs/deploy.md の 1-D の手で置く。
1-D で手で置くときも、同じメタデータを付ける（`db:pack` を手で動かして作る）。

**メタデータの形**（2026-11-08 実装。`src/lib/dbfile.ts`）: 名前は小文字とハイフン、値は ASCII の文字列だけ（S3 のメタデータにそのまま載せる）。
`db:pack` が `out/meta.json` に書き、`db:check --expect` は `aws s3api head-object` の出力（`{"Metadata": {...}}`）でも中身だけでも読む。

| 名前 | 中身 |
| --- | --- |
| `format` | `1` |
| `sha256` | gzip したファイルの sha256（16進） |
| `user-version` | DB の user_version |
| `rows` | 行を消さない表の行数。`streamers:282;watch_events:7727;…`（カンマと = を使わない。`--metadata` の短い書き方でも崩れない）。DB に無い表（candidates ができる前）は入れない |
| `run-id` | 書いた回（`--run-id`。無ければ `GITHUB_RUN_ID`） |
| `writer` | 書いたワークフロー（daily / publish / manual）。`job:due` は daily だけを数える |
| `written-at` | 書いた時刻（UTC の ISO 8601） |

2026-11-04 の DB の写し（320MB）で 333 バイト。`db:check --observed observed.json` は、開いた DB の実際の行数と user_version を同じ形で書く。
これを `db:pack --against` に渡すと、`accept_db` で通した回（メタデータが合わない回）でも取得したときの実際の行数と比べられる。
`db:check` は `integrity_check`（写しで約1秒）を使う。`db:pack` は checkpoint のあと `quick_check`、gzip を展開した中身の sha256 を元の DB と比べてから書く。外れたら `out/` に何も残さない（前の回の出力も消す）

**直す手段**（検査で止まり続けたとき）: 手動のワークフローに入力 `accept_db: true` を置く。sha256 と行数の照合を飛ばし、
ファイルがあること・`integrity_check`・user_version だけを見て通し、書き戻すときに新しいメタデータを付け直す。
それでもだめなら `db/backup/` の前の日の DB を `db/db.sqlite.gz` に写す（手順は実装のときにこの文書に書く）。

### 2-4. DB の書き戻し（必ず行う側）

ジョブのステップが途中で失敗しても、**2-3 が通っていれば**書き戻す（`if: always() && steps.pull.outcome == 'success'`）。

    1. npm run cli -- db:pack --against meta.json --out out/      ← 新しいコマンド（→ 9）
         WAL を本体に書き戻す（checkpoint(TRUNCATE)）→ quick_check → 行数を数える
         → 行を消さない表の行数が取得したときより減っていないか（下）→ gzip → 新しいメタデータ（JSON）
    2. aws s3 cp out/db.sqlite.gz s3://…/db/db.sqlite.gz --metadata <新しいメタデータ>

- **行を消さない表**（設計で行を消さないと決めている表）: streamers・watch_events・videos_seen・ai_decisions・unresolved・work_public_keys、
  それと docs/ai-ops.md 3-1 で新しく作る **candidates**（同じ動画は1回だけ候補にし、状態を変えるだけ）。
  1つでも減っていたら**書き戻さず**、ワークフローを失敗にする（壊れた DB で R2 の正を上書きしない）。works・event_works・resolve_cache などは減ってよい（作り直す派生データ）
- `-wal` ファイルを残したまま gzip しない（WAL の中身が落ちる）。`db:pack` が checkpoint のあとに `-wal` が空なのを確かめる
- CLI のプロセスがステップのタイムアウトで殺されても、SQLite は次に開いたときに WAL から戻す。`db:pack` は DB を開き直すので、そのまま書き戻せる
- 日次の最初の書き戻しの前（その日に `db/backup/<日付>.sqlite.gz` がまだ無いとき）に、R2 の今の `db/db.sqlite.gz` を `db/backup/<日付>.sqlite.gz` に写す（`aws s3 cp` の R2 の中での写し）
- 生レスポンス（`data/raw/` の下）は別のステップで `aws s3 cp --recursive`（`if: always()`）。ランナーは毎回まっさらなので、`data/raw/` にあるのはその回のファイルだけ。
  生レスポンスの保存に失敗しても DB の書き戻しとビルドは止めない（今の `finishCtx` と同じ考え）

### 2-5. og:image のキャッシュ（`data/site/og-cache/`）

**推奨: Actions のキャッシュ（actions/cache の restore と save を分けて使う）。**

    restore: key = og-${{ github.run_id }}（restore-keys: og-）→ いちばん新しいキャッシュを戻す
    ビルド（使った画像は og.ts が更新日時を今にし、astro.config.mjs がビルドの始まりより古い画像を消す）
    save:    key = og-${{ hashFiles('data/site/og-cache/**') }}。同じキーがもうあれば保存しない（中身が変わったときだけ）

- 2026-10-27 で 1,843枚・65MB（作品ページ・配信者ページの数＋1。ビルドで使わなかった画像は astro.config.mjs の 40〜52行が消す。2026-10-26 に入った）。
  リポジトリのキャッシュは合計 10GB まで、7日使わないと消える。65MB が日に1つ増えても、古いものから消える
- **確かめること**: 掃除は更新日時で見ている。actions/cache の展開が更新日時を保つか（tar なので保つ見込み）、og.ts が「使った画像」の更新日時を今にするので、保たなくても消えすぎはしない（使わなかった画像が残るだけ）
- R2 に置く案は、PNG はもう圧縮されているので固めても小さくならず、毎回出し入れする。キャッシュが無くても約3分のびるだけなので、消えても困らない Actions のキャッシュでよい

### 2-6. 「中身が変わったときだけアップロード」の判定

ビルドの前に**このサイトの中身の指紋**を作り、R2 の `site/last-deploy.json` の指紋と同じならビルドもアップロードも飛ばす。

    指紋 = sha256( site-data.json から generatedAt を除いたもの
                 ＋ リポジトリのコミット（github.sha。コード・設定・ページの作りが変わったら作り直す）
                 ＋ 日本時間の日付 )

- `generatedAt` は毎回変わる（トップのページに入る）ので除く
- 日付を入れる理由: ビルドの時刻（`site.generatedAt`）でランキングの期間（7日・30日）と配信日の絞り込み（30日以内・1年以内）を切っているので（site/lib/data.ts の `now`）、データが変わらなくても1日1回は作り直す
- 日次だけにしたので、再生数の取り直し（refresh）で `viewsFetchedAt` も中身もほぼ毎日変わり、**ふつうは毎日アップロードする（月に約30回）**。
  指紋が効くのは、同じ日にもう一度流したとき（保険の cron・手で流し直したとき）。`viewsFetchedAt` を「終わった枠だけの最大」にするかは、2時間ごとに戻すときに考える（付録）
- 本番へのアップロードが成功したあとに `site/last-deploy.json` を書く。失敗したら書かないので、次の回にやり直す
- 手動のワークフローは入力 `force`（既定 true）で指紋に関係なくアップロードする。プレビューへのアップロードでは `site/last-deploy.json` を書かない

指紋は `jq -S 'del(.generatedAt)' | sha256sum` でも作れる（jq はランナーに入っている）が、site-data.json は大きいので CLI の `site:fingerprint` にする案（→ 9）。

### 2-7. ビルドと、dist/ の確認

    npm run site:build                  （site:data が失敗して site-data.json が無ければ、ここで失敗する。アップロードしない）
    find dist -type f | wc -l           15,000 で警告・18,000 で失敗にする（上限 20,000。2026-10-27 の dist/ は 3,807）
    find dist -size +25M                1ファイル 25MiB を超えるものがあれば失敗
    wc -l dist/_redirects               1,600 行で警告（上限 2,000 行を超えるとビルドが失敗する。2026-10-27 は 16 行）

- `_redirects` は1つの転送につき2行（末尾スラッシュあり・なし）なので、転送 800件で警告、1,000件でビルドが失敗する（astro.config.mjs が止める）。
  失敗すると毎日アップロードが止まるので、警告が出たら古い転送の整理を考える（作品の公開キーが変わってから長く経った転送を外すなど。決め方は今は無い → 11-6）
- ビルドの失敗・数の超過のときは**アップロードしない**。前の版が公開され続ける。DB はもう書き戻してある（2-4 はビルドの前）

### 2-8. アップロード（Workers の静的アセット）

    cloudflare/wrangler-action（版を固定する。下）
      本番:       deploy                                   （wrangler.jsonc の name が Worker 名、assets.directory = ./dist）
      プレビュー: versions upload --preview-alias preview  （→ preview-<Worker名>.<アカウントのサブドメイン>.workers.dev）

- `wrangler versions upload` は版を作って版の URL を返すだけで、本番は変えない（Cloudflare の文書の Previews。2026-10-27 に読んだ）。`--preview-alias` で読みやすい固定の URL になる。
  版の URL は workers.dev でだけ出る（独自ドメインは使わないので問題ない）（→ D-11 で変更予定・未実装）。URL を知っていれば誰でも見られる（docs/deploy.md 4）
- 版の固定（2026-11-13 実装。どれも公開から2週間以上たった版をコミットの SHA で）: `cloudflare/wrangler-action@953926a…`（v4.1.3。2026-09-24。最新のまま）・入力 `wranglerVersion: "4.155.0"`（2026-10-28。4.34.0 以上が要る）、
  `actions/checkout@3d3c42e…`（v7.0.1）・`actions/setup-node@949feb2…`（v7.1.0）・`actions/cache/restore`・`save@55cc834…`（v6.1.0）、ランナーは `ubuntu-24.04`
- wrangler-action v4.1.3 の README には、PR ごとの「Workers Previews」（`wrangler preview`。wrangler 4.136.3 以上）も書かれている。こちらは採らず、決めたとおり `versions upload --preview-alias preview` にした（版の URL は本番と同じ設定で動く）
- プレビューの URL は wrangler-action の出力 `deployment-url` を step summary に書く（`versions upload` で出るかは未確認。出なければログの「Version Preview URL」を見る）。
  **Worker がまだ無いときに `versions upload` が通るかは文書に書かれていない**（未確認）。最初のプレビューで失敗したら、ユーザーに聞いてから本番の `deploy` で Worker を作る（13）
- API トークンの権限（Workers のスクリプトの編集）で足りるかは docs/deploy.md 1-B-6 のとおり未確認

### 2-9. 結果の書き出し

最後に `npm run cli -- runs:summary --since <ワークフローの開始時刻>`（→ 9）で、この回の runs の行（ステップごとの件数・エラー・クォータ）を `$GITHUB_STEP_SUMMARY` に書く。
CLI はステップの失敗を partial として記録して終了コード 0 を返すので、そのままだと**ワークフローは緑のまま失敗に気づけない**。partial の回は `::warning::` を出す（ワークフローは失敗にしない）。

- **公開リポジトリの Actions のログと step summary は誰でも見られる**。書き出すのは件数・動画の ID・エラーの文だけにし、**概要欄（description_raw）・AI の判定の根拠（rationale・evidence）は出さない**
  （メン限枠の本文を転載しない。CLAUDE.md「やらないこと」）。今の CLI のログ（`resolve`・`ai:apply` の出力）も、実装のときに概要欄を出していないか確かめる

## 3. ワークフローごとの手順

`[必ず]` は前のステップが失敗しても動く（`if: always()` と 2-3 の成功）。`[続ける]` はそのステップが失敗しても次へ進む（`continue-on-error: true`）。
CLI のステップにはステップごとの `timeout-minutes` を付け、**その合計をジョブ全体の `timeout-minutes` より短くする**（Fable の高-3。ジョブ全体のタイムアウトで殺されると後始末のステップの動きが当てにならない。ステップのタイムアウトなら失敗として次へ進む）。

### 3-1. 日次

| # | ステップ | 失敗したら | タイムアウト |
| --- | --- | --- | --- |
| 1 | 準備（2-1） | 止める（何も書かない） | 10分 |
| 2 | DB の取得と検査（2-3） | **止める**（何も書かない） | 5分 |
| 3 | `roster` `[続ける]` | 次へ（取得に失敗したら前回の一覧を保持する。CLAUDE.md） | 10分 |
| 4 | `crawl:daily` `[続ける]` | 次へ | 40分 |
| 5 | `refresh` `[続ける]` | 次へ | 10分 |
| 6 | 候補の選定と詳細（`candidates:select` → `candidates:fetch`。docs/ai-ops.md 3-1・3-2）`[続ける]` | 次へ（次の日に続き） | 10分 |
| 6b | 30日の決まり（`retention`。D-12・docs/crawl.md の「30日の決まり」）`[続ける]` | 次へ（取れたぶんは書く。残りは次の日） | 20分 |
| 7 | AI の答えの取り込み（6 の 1〜3。受け箱から移すのは 11 のあと）`[続ける]` | 受け箱に残す。次の日にやり直す | 20分 |
| 8 | `resolve --limit 400` `[続ける]` | 次へ（残りは次の日） | 45分 |
| 9 | `site:data` `[続ける]` | 次へ（site-data.json が無いので 13 が失敗する） | 5分 |
| 10 | DB の書き戻し（2-4。その日の最初なら先に `db/backup/`）`[必ず]` | ワークフローを失敗にする。11・13〜15 もしない | 5分 |
| 11 | 取り込んだ答えを受け箱から移す（6 の 4〜5。10 が成功したときだけ）`[続ける]` | 受け箱に残る（次の日に入れ直す。6-2 の決まりで結果は同じ） | 5分 |
| 12 | 生レスポンスを R2 へ `[必ず]` `[続ける]` | 次へ | 5分 |
| 13 | 指紋（2-6）→ 同じならここで 16 へ | — | 2分 |
| 14 | og のキャッシュを戻す → ビルド → dist/ の確認（2-7） | アップロードしない | 20分 |
| 15 | アップロード（本番。2-8）→ `site/last-deploy.json` | ワークフローを失敗にする（次の回にやり直す） | 10分 |
| 16 | og のキャッシュを保存（2-5）`[続ける]` | 次へ | 5分 |
| 17 | 結果の書き出し（2-9）`[必ず]` | — | 2分 |

- ステップのタイムアウトの合計は 229分（6b の 20分を足した。2026-11-13）。**ジョブ全体の `timeout-minutes` は 240**（GitHub の上限は 360）
- `crawl:hourly` は流さない。`crawl:daily` が全チャンネルの uploads の先頭50件とメン限の再生リストを見るので、RSS（直近15件ほど）と playlistItems の順繰りで拾えるものは日次で拾える。
  `refresh` が予定枠・配信中を含む全枠の状態を取り直すので、予定枠のデータも今までどおり DB に入る（終わってから名寄せ・判定されて出る）
- `resolve --limit 400`: 2026-10-11 の実績は 43枠で 198秒（固定の後処理約30秒を除くと1枠約4秒）。400枠で約27分＋後処理で、45分に収まる。
  roster で新しい配信者が入った直後・巡回が長く止まったあとに枠がたまったら、数日に分けて進む（`mode: new` は未処理の枠を拾うので、次の日が続きをやる）。急ぐときは手動の `resolve_all` ではなく日次を手で流し直す
- **`resolve` の対象の並び**（Fable の中-6。2026-11-08 実装）: 前は `ORDER BY e.id` で、照会エラーの枠（古い枠ほど id が小さい）が先頭に固まり、照会先が落ち続けると `--limit` の枠がエラーの枠で埋まって新しい枠が進まなかった。
  未処理の枠を先・照会エラーの枠を後にした（`ORDER BY (u.reason = 'error'), e.id`。すべての mode で同じ並び）
- 6 の候補は docs/ai-ops.md の 3-1（選び方。API なし）と 3-2（videos.list）。終わった動画だけを判定に回すので、配信中の候補は次の日にもう一度見る
- **6b の retention**（2026-11-13。D-12）: videos_seen の題名を古いものから videos.list で取り直す（ふだん 約285ユニット）・終わった候補の詳細と、アーカイブが消えて25日たった枠の中身を消す（API なし）。
  巡回（3〜6）のあとに置く（巡回で同じ題名を見た動画・refresh で取り直した枠の動画は確かめた時刻が進み、取り直さずに済む）。手で起動して `crawl: false` の回も流すが、
  YouTube のキーを渡さないので取り直しは飛ばし、消すほうだけ動く。1回は20分あれば足りる見込み（1,500ユニットで videos.list 1,500回。写しで 15ユニット 2.8秒）
- **実装**（2026-11-13）: 表の 1 の前に `start`（入力の組み合わせの確かめ・この回の始まりの時刻）と `due`（保険の cron の回だけ 5-2 の判定。ほかは due=true）を置いた。2 以降は due=true のときだけ動く。
  手で起動するときの入力は `target`（production / preview）と `crawl`（false で 3〜6 を飛ばす。YouTube を呼ばずに1周する試し）。保険の判定はジョブの中（concurrency の中）でするので、日次が動いている間に来た保険の回は待ってから判定する
- 11（settle）は 10 が成功したときだけ、12（生レスポンス）は 2 が通っていれば必ず、13 からあとは 10 が赤なら動かない（GitHub の既定の success()）。og のキャッシュの保存は、ビルドした回なら失敗しても動く

### 3-2. 手動（ビルドとアップロード）

入力: `target`（production / preview。既定 production）・`force`（既定 true）・`resolve_all`（既定 false）・`accept_db`（既定 false。2-3）。

    準備 → DB の取得と検査 →（resolve_all なら resolve --all）→ site:data → DB の書き戻し [必ず] → 指紋（force なら飛ばさない）
      → ビルド → dist/ の確認 → アップロード（target） → 結果

- 巡回・AI の答えの取り込みはしない。`resolve_all` が false なら外部の API を呼ばないので、YouTube・Annict の Secrets は渡さない（`resolve_all` のときは Annict だけ渡す）
- `resolve_all`: ルールを直して push したあと、本番の DB で名寄せし直す手段（docs/deploy.md 6-7 の「ローカルの `resolve --all` を本番にどう入れるか」の答え。ローカルから R2 の DB を書かない形を守る）。
  照会のキャッシュが効けば数秒〜数分。タイムアウト 60分
- preview は `site/last-deploy.json` を書かない（本番の指紋と混ぜない）
- 使いどころ: 最初の公開の前の確認（docs/deploy.md 6-8: プレビュー → 確認 → 本番 → schedule を有効にする）、ルールの変更の反映、検査で止まったときの直し（`accept_db`）
- ジョブ全体の `timeout-minutes` は 90

### 3-3. keepalive

    schedule: 月1回（例 毎月3日 03:41 UTC）＋ workflow_dispatch
    permissions: contents: write
    1. checkout
    2. .github/keepalive に日付を1行書く（上書き。ファイル1つだけ）
    3. github-actions[bot] の名前でコミットして push

- 公開リポジトリは60日コミットが無いと schedule が止まる（docs/deploy.md の出典）。月1回なら余裕がある
- GITHUB_TOKEN で push したコミットはワークフローを起動しない
- 作者は `github-actions[bot]` の noreply のアドレス。個人のメールアドレスは出ない（docs/deploy.md 6-6 の noreply への書き換えとは別）
- **ローカルの main が遅れる**。ローカルで push する前に `git pull --rebase` が要る。ファイル1つしか触らないので衝突はしない
- **keepalive は `SCHEDULE_ENABLED` を見ない**（2026-11-13 実装）。公開の前でも、既定のブランチに置いた時点から毎月3日に動き、リモートの main が進む。公開の前も後も、ローカルから push する前に pull する
- 同じ日に手で2回押しても、ファイルが変わらなければコミットしない
- それでも止まったら docs/crawl.md「schedule の60日自動停止への対策」の次の手（Cloudflare Workers の Cron から workflow_dispatch で起動する）

## 4. 失敗のときの動き（まとめ）

| 何が失敗したか | DB | 生レスポンス | サイト | ワークフローの色 |
| --- | --- | --- | --- | --- |
| R2 から DB を取れない・壊れている・メタデータと合わない | 書かない | 上げない（まだ何もしていない） | 前の版のまま | 赤（手動の `accept_db` で直す。2-3） |
| 巡回・名寄せ・roster・refresh・候補・30日の決まり（retention）のどれか（CLI のステップの中の失敗） | 書き戻す | 上げる | 作り直す（取れたぶんで） | 緑（`::warning::`） |
| CLI のプロセスが落ちた・ステップのタイムアウト | 書き戻す（WAL から戻して） | 上げる | 作り直す | 緑（`::warning::`） |
| AI の答えの取り込み | 書き戻す（入ったぶんは入る。6-2 の決まりで入れ直しても同じ） | 上げる | 作り直す | 緑（`::warning::`） |
| `site:data` | 書き戻す | 上げる | **ビルドが失敗して前の版のまま** | 赤 |
| 書き戻しの前の検査（行を消さない表の行が減った・quick_check） | **書かない**（R2 の正を守る） | 上げる | 作り直さない | 赤 |
| R2 への書き戻し | 書けていない（次の回は前の DB から。その回の巡回は次の回にもう一度取る） | — | 作り直さない | 赤 |
| ビルド・dist/ の確認 | 書き戻し済み | 上げる | 前の版のまま | 赤 |
| アップロード | 書き戻し済み | 上げる | 前の版のまま（次の回にやり直す） | 赤 |
| YouTube のクォータ切れ | 書き戻す | 上げる | 作り直す | 緑（`::warning::`） |

- 書き戻しが失敗したまま次の回が R2 の前の DB から始めると、その回の巡回の結果は失われるが、uploads の先頭50件・メン限の再生リストは次の日にもう一度拾う。
  videos.list のクォータの記録（quota_usage）も失われるので、その日はクォータを少なめに数える。`stop_at` の余白（1,000）で吸収する
- 取り込んだ AI の答えは、書き戻しが成功するまで受け箱から移さない（3-1 の 11）。書き戻しが失敗しても答えは失われない
- 赤の回は GitHub がメールで知らせる（schedule のワークフローは、cron を最後に書き換えた人に届く）

## 5. concurrency と schedule

### 5-1. concurrency

    concurrency:
      group: simulwatch-db
      cancel-in-progress: false

- **DB を書く2本（日次・手動）は同じ組**。keepalive は DB を触らないので入れない
- GitHub の concurrency は「動いているもの1つ＋待っているもの1つ」まで。**待っているところに新しい回が来ると、待っていた回は取り消される**。
  日次が1日1回になったので重なりはまれ。重なりうるのは、日次が動いている間に手動を2回押したとき（先の手動が取り消される）と、保険の cron（5-2）が動く時刻に日次がまだ動いているとき（保険の回は待ち、日次が終わったあとに動いて、もう済んでいれば何もせずに終わる）
- ローカルから R2 の DB を書くことはしない（docs/ai-ops.md の流れでも、ローカルは DB の写しを読むだけで、答えは受け箱に置く）。この組の外で DB を書くものを作らない

### 5-2. schedule の時刻

**決定: 日本時間 05:23（UTC 20:23）**（2026-10-30 ユーザー決定。下の案 B）。夜の配信が終わったあとの日本時間の早朝を前提にした案から選んだ:

| 案 | UTC | 日本時間 | 太平洋時間（夏／冬） |
| --- | --- | --- | --- |
| A | 19:23 | 04:23 | 12:23／11:23 |
| **B（決定）** | **20:23** | **05:23** | 13:23／12:23 |
| C | 21:23 | 06:23 | 14:23／13:23 |

- B にした理由: 深夜の配信（日本の配信者は 2〜3時台まで）が終わって再生数がひと晩伸びたあと、朝の配信の前。ジョブは長くて1時間ほどなので、朝のうちにサイトが更新される
- 正時を避けて23分（混雑で遅れる・落ちるのは毎時0分が多い。公式の注意）。5 の倍数・15・30・45 も混みやすいと言われるので半端な数にする
- 太平洋時間の0時（クォータの戻る時刻）とはずれるが、1日の使用量は 800 ユニット前後（→ 7）なので合わせなくてよい
- cron の書き方: 日次 `23 20 * * *`、保険 `23 2 * * *`（どちらも UTC）
- **保険の cron**: schedule は混雑で遅れたり、まれに動かなかったりする。日次の6時間後（UTC 02:23 = 日本時間 11:23）にもう1つ cron を置き、
  最初に `aws s3api head-object` で `db/db.sqlite.gz` のメタデータの `written_at` を見て、**20時間以内に日次が書いていれば DB も落とさずに終わる**（1分ほど。メタデータに「書いたのが日次か」も持つ）。
  書いていなければその回を日次として流す（新しいコマンド `job:due`。→ 9）
- **schedule は既定のブランチにファイルを置いた時点で動き出す**。最初の公開の前に動かないよう、リポジトリの変数 `SCHEDULE_ENABLED` が `true` のときだけジョブを動かす
  （`if: vars.SCHEDULE_ENABLED == 'true' || github.event_name == 'workflow_dispatch'`）。docs/deploy.md 6-8 の「本番にアップロード → schedule を有効にする」をこの変数で行う

## 6. AI の判定の答えの取り込み（ジョブの側の約束事）

docs/ai-ops.md「2. 全体の流れ」の右の列（GitHub Actions）。ローカルの `ai:push` が `ai/inbox/<batch>/*.json` に置いた答えを、日次の回の**名寄せの前に**取り込む。
**ローカルの側（ai:check・ai:push）とジョブの側の約束事はこの 6 が正**。ai-ops のセッションにも同じ決め方を伝えている。

### 6-1. 流れ

    1. aws s3 ls s3://<bucket>/ai/inbox/ で batch の一覧 → 0件なら飛ばす
    2. 古い batch から順に、**1回に5つまで**（6-4）data/ai-inbox/<batch>/ に落とす。
       落とす前に ai/results/<batch>/<run_id>.json に「始めた」の印を置く（6-3）
    3. npm run cli -- ai:ingest data/ai-inbox --result data/ai-inbox/result.json     ← 新しいコマンド（→ 9）
         batch ごと・ファイルの名前の順に今の ai:apply と同じ処理をし（6-2 の決まりを足す）、batch ごとの結果を JSON に書く
    4. 結果が「入れた」の batch: ai/inbox/<batch>/ → ai/applied/<batch>/ に移す（aws s3 mv --recursive）
       結果が「やり直し」の batch: 受け箱に残す。やり直しの回数が3回に達したら ai/failed/<batch>/ に移す
       結果が「failed」の batch: すぐ ai/failed/<batch>/ に移す
    5. ai/results/<batch>/<run_id>.json の「始めた」の印を結果で上書きする

**4・5 は DB の書き戻し（2-4）が成功したあとに動かす**（3-1 の 11）。取り込んだ DB を書き戻せなかったのに受け箱から消すと、答えが失われる。

**実装（2026-11-13。塊 C。src/report/inbox.ts）**: 1〜3 は `npm run cli -- ai:ingest --remote r2 --result <file>` が1つでする（一覧・印・落とす・取り込む・結果の JSON。どの batch を取りどこへ移すかを CLI が決めて結果に書く）。
4〜5 は `npm run cli -- ai:ingest --settle <file> --remote r2`（3-1 の 11）。R2 との出し入れは CLI の中から AWS CLI を呼ぶ（`--remote <フォルダ>` ならローカルのフォルダで同じ手順を試せる）。
- 「古い batch から」は batch の名前の順（`aws s3 ls` の PRE の行には日付が無い）。batch の名前は日付を含める（`ai-YYYYMMDD` など）。名前に英数字と `_ . -` 以外がある batch は取り込まず結果の `ignored` に書く
- 印のファイルの名前は run_id（`--run-id`。無ければ `${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}`。同じ回をやり直したときも別の印になる）
- `--settle` は**取り込んだファイルだけ**を1つずつ移す（`aws s3 mv`。取り込みのあとに `ai:push` で同じ batch に置かれたファイルは受け箱に残り、次の回に入る）
- 結果の JSON（`ai/results/` にも置く）には問題の中身（ファイル名・動画の ID・理由）を書く。ログには件数と動画の ID だけを出す（答えの根拠・概要欄は出さない。2-9）

### 6-2. 古い答えで新しい答えを上書きしない（Fable の高-1）

今の `aiApply`（src/report/ai.ts）は、入れる答えの時刻を見ずに、その枠の取り消されていない判定を取り消して入れ直す。
「やり直し」の batch を丸ごと入れ直すと、そのあいだに入った新しい答え（fix）を古い答えで上書きしてしまう。決め方:

- **`ai:ingest` は、その枠にすでにある取り消されていない判定の `decided_at` が今の答えの時刻（答えのファイルの `finished_at`）より新しければ飛ばし、「古い答え」と記録する**
- 同じ時刻なら同じ答えなので飛ばし、「入れ済み」と記録する（何度入れても同じ。入れ直しの途中で落ちても困らない）
- 古ければ今と同じく前の判定を取り消して入れる（行は残る）
- **比べる時刻は、その枠の取り消した行も含めた全部の判定の `decided_at` の最大**（瞬間で比べる。2026-11-13 親セッションの指摘で決めた）。取り消されていない判定だけを見ると、`ai:revoke` のあとに受け箱に残った取り消した答え・それより古い答えがまた入る。
  `revoked_at` は使わない（置き換えで立つ `revoked_at` は取り込んだ時刻なので、あとの正しい答えまで古い答えになる）。取り消したあとに作った答え（finished_at があと）だけが入る
- `decided_at` は今も答えのファイルの `finished_at` から入る（無いと取り込んだ時刻になる）。そのため**受け箱に置く答えのファイルには `finished_at` を必ず書く**（`ai:check` が確かめる。無いファイルは `ai:ingest` が failed にする）
- **直しの答え（fix）のファイルの名前は `fix-` で始める**。`ai:ingest` は batch の中のファイルを名前の順に入れるので（`readdirSync` の並びを sort。数字の `01.json` 〜 の後ろに `fix-*.json` が並ぶ）、
  同じ batch で元の答えと直しが同じ時刻でも、直しが後に入る。直しの `finished_at` は直したときの時刻にする
- 採点で見つけた誤りを次の回で直すとき（docs/ai-ops.md の 7）は、新しい batch の `fix-*.json` として置く。古い batch が受け箱に残っていても、時刻で古い答えは飛ぶ

### 6-3. batch ごとの結果の決め方

| `aiApply` の中で起きたこと | 結果 |
| --- | --- |
| すべて入った・6-2 で飛ばした（古い答え・入れ済み） | 入れた |
| 「枠が無い」で飛ばした答えがある（判定から外れた・アーカイブが消えた枠など） | **入れた**（飛ばした動画を結果に書く。入れ直しても入らない） |
| 答えの形が不正（status・confidence・rationale・evidence・works の key） | **入れた**（不正な答えは結果に書いて人が直す。ローカルの `ai:check` で防ぐ前提。入れ直しても変わらない） |
| 「外部DBで引けない」（照会のエラー・作品クラスでない項目） | **やり直し**（照会のエラーなら次の日に入る見込み） |
| 「作品の属性を埋められなかった」 | 入れた（次の resolve で埋める。今と同じ） |
| ファイルが読めない（JSON が壊れている）・**`batch`・`model`・`finished_at` が無い** | **failed**（入れ直しても変わらない）。今の `aiApply` はこれを problems に入れて先へ進むので、そのままだと「入れた（0件）」で applied/ に移ってしまう（Fable の中-7）。`ai:ingest` はファイル単位の問題を分けて受け、failed にする（→ 9「直す」） |
| `ai:ingest` が途中で殺された（タイムアウト・ランナーの停止。result.json が無い） | **やり直しと同じ**（Fable の中-5）。6-2 の決まりで入れ直しても同じ結果になる |

- **やり直しの回数は `ai/results/<batch>/` のファイルの数で数える**（2 で「始めた」の印を先に置くので、殺された回も1回に数える）。3回（3日）に達したら ai/failed/ に移す
  （実装: やり直しになった回がその batch の3回目なら failed。取り込む前に印がもう3つ以上ある batch は、入れずに failed。落とせない・DB の例外など答えのせいでない失敗はやり直しに数える）
- 「枠が無い」は、watch_events に行が無い・判定から外れた（excluded_at）・アーカイブが消えた（archive_gone_at）の3つ（実装 2026-11-13。それまでの aiApply は行があれば外れた枠にも入れていた）。
  候補（続きの回）の答えは、塊 D3a で枠を作るまでここに入る
- failed の batch は人が見る（結果の JSON に理由がある）。直したら新しい batch の名前で受け箱に置き直す

### 6-4. 1回の量

- 1回に取り込む batch は**5つまで**（docs/ai-ops.md の1回の上限が 500件＝10ファイルなので、ふつうは週に1つ）。残りは次の日
- `ai:apply` は「確定した判定を保留に置き換えた枠」をその場で名寄せし直す（外部DBに照会する）。答えが多いと時間がかかるので、ステップのタイムアウトは 20分。
  超えたら残りの batch はやり直し（6-3）になる
- 取り込んだ数・飛ばした枠（動画の ID だけ）は 2-9 の結果に出す。人が次に `ai:status` と `ai/results/` で確かめる（docs/ai-ops.md の 7）

### 6-5. こちらで決めないこと

答えのファイルの中身の形（`finished_at` を必ず書くこと以外）・batch の名前の付け方・候補（続きの回）の答えの反映（docs/ai-ops.md の 3-4）。
`ai:ingest` は `aiApply` を batch ごとに呼ぶだけにし、候補の反映が `aiApply` に入ればそのまま取り込める形にしておく。

## 7. YouTube のクォータ

1日 10,000 ユニット（太平洋時間の0時に戻る）。今の設定は `stop_at: 9000`・1回の上限 daily 6000（config/crawl.yaml。日次の CLI は roster・crawl:daily・refresh がそれぞれ別の回で、どれも daily の上限）。

| 使うもの | 1日の見積もり | 元にした実績 |
| --- | --- | --- |
| roster | 15 | 2026-10-11・10-19 の runs |
| crawl:daily | 約 570 | 2026-10-11 の runs（565。遡りは終わっている） |
| refresh | 約 150〜160 | 2026-10-11 の runs（153。7,610枠。枠が増えると 50枠ごとに1ずつ増える） |
| 候補の詳細（videos.list。docs/ai-ops.md 3-2） | ふだん 0〜1（判定に回す候補の25日ごとの取り直しを足しても 0〜2）。初回だけ約 10 | 50本で1。弱い語を入れた候補は今の DB の写しで 481本（2026-11-13。塊 D3b）なので初回は約 10。それまでの数え: 2026-11-08 の `candidates:select --dry-run`（3層で 201本。10-30 の巡回で入った19日ぶんの動画 4,069本から増えた候補は0本）から。弱い語を入れると増える（10-23 の数えで +274本・+6） |
| 30日の決まりの videos_seen の取り直し（`retention`。D-12） | ふだん 約 285。初回の追いつきは 1,500 × 約5日 | 題名を持つ行 355,373 ÷ 25日 ÷ 50本。25日を過ぎた行（2026-11-13 の写しで 330,043）が多いときは上限 `retention.videos_seen_max_units`（1,500）まで。巡回・refresh で見た動画は取り直さない |
| 巡回を止めた配信者のチャンネル（roster の channels.list。D-12） | 0〜1 | 今は巡回を止めた配信者は0人。50人で1 |
| 遡り（新しいチャンネルが入ったとき） | 0〜3,000 | `backfill.max_units_per_run`。2026-09-23 の初回は3,549 |
| **ふだんの合計** | **約 1,050〜1,100**（初回の5日ほどは 約 2,300） | 2時間ごとの回（約 550〜650/日）が無くなり、30日の決まりの約 285 が足された |
| AI の判定の取り分（ローカルの `ai:queue`） | **600**（2026-10-26 ユーザー決定。docs/ai-ops.md の 5） | 2026-10-18 の report は 46 |
| Tier 2 の取り分（Phase 5） | 約 1,500 | docs/crawl.md「crawl の分担」 |

- **AI の判定の取り分を除いた上限**: ジョブ側は `stop_at − ai_reserve` = 9,000 − 600 = **8,400** で止める。config/crawl.yaml の `quota` に `ai_reserve: 600` を足し、
  `Quota.remaining()`・`reserve()` でジョブ（job が hourly・daily）のときだけ引く（→ 9）。ローカルの `ai:queue` の「取り分を超えたら止める」は docs/ai-ops.md の 5 の側で作る
- 遡りが 3,000 を使う日でも 1,100 + 3,000 = 4,100 で、8,400 に届かない（30日の決まりの追いつきの日と重なっても 2,300 + 3,000 = 5,300）。2時間ごとをやめて空いたぶん（約 600/日）は、付録の「戻すとき」に使えるよう残す
- **APIキーは1つのまま**（ローカルの AI の判定も同じキー）。クォータを増やすためにプロジェクトを分けてキーを増やすのは、YouTube の API の規約で禁じられていると理解している（「クォータの制限を逃れるために複数のプロジェクトを作らない」）。
  **実装の前に規約の文面を読み直す** → 2026-11-13 に読み直した（Developer Policies と Terms of Service。公式のページ）。
  - Developer Policies III.D.1.c は「1つの API Client に API Project を1つ」「1つの Project を複数の API Client に使わない」。API Client は「あなたが作った Web サイトかアプリ」なので、
    このサイトの日次のジョブとローカルの `ai:queue` は同じ API Client（同じ Project・同じキー）と読める。Developer Policies の手引き（Complying with YouTube's Developer Policies）は、
    同じサービス・同じ用途で枠を増やすために Project を増やすことを禁じ、用途ごと・試しと本番で分けるのは認めている。「キーは1つのまま」はこれに合う
  - Terms of Service の 15（Usage and Quotas）は、クォータの制限を超えたり逃れたりしないこと。1日の使用量は 2-9 の結果に出す
  - 保存の期間（III.E.4.c・d）と再生数の更新（III.E.4.e・f）・集計（III.E.2）・派生の指標（III.E.4.h）・広告（III.G.1）は、このジョブより広い話なので塊 F の報告に書いた（docs/ では直していない）。
    → docs/youtube-policy.md にまとめた。保存の期間は D-12（30日の決まり。日次の retention。docs/crawl.md）で直した
- 1日の使用量は 2-9 の結果に毎回出す（`today_units`）

## 8. Secrets と Variables の名前

| 名前 | 種類 | 中身 | 使うワークフロー |
| --- | --- | --- | --- |
| `YOUTUBE_API_KEY` | Secret | YouTube Data API のキー | 日次 |
| `ANNICT_TOKEN` | Secret | Annict の個人用アクセストークン | 日次（名寄せ・取り込み）・手動（`resolve_all` のときだけ） |
| `CLOUDFLARE_ACCOUNT_ID` | Secret | アカウント ID（R2 の接続先にも使う） | 日次・手動 |
| `CLOUDFLARE_API_TOKEN` | Secret | Workers へのアップロード（Workers のスクリプトの編集。最小の権限は未確認。docs/deploy.md 1-B-6） | 日次・手動 |
| `R2_ACCESS_KEY_ID` | Secret | R2 の API トークン（Object Read & Write・バケット限定） | 日次・手動 |
| `R2_SECRET_ACCESS_KEY` | Secret | 同上 | 同上 |
| `R2_BUCKET` | Variable | バケット名（例 `simulwatch-data`） | 同上 |
| `SITE_URL` | Variable | サイトの URL（`https://<Worker名>.<サブドメイン>.workers.dev`（→ D-11 で変更予定・未実装）。astro.config.mjs が `SITE_URL` を読む。config/site.yaml の仮の URL より優先） | 同上 |
| `SCHEDULE_ENABLED` | Variable | `true` で schedule の回を動かす（5-2） | 日次 |
| `R2_PREFIX` | Variable | 試しの置き場所（例 `test/`）。あれば R2 のすべてのキーの先頭に付け、本番にはアップロードしない（1・13）。ふだんは**作らない** | 日次・手動 |

- 上の6つは docs/deploy.md の 1-C と同じ名前。Worker 名は Variables に置かず、リポジトリの `wrangler.jsonc` の `name` に書く（docs/deploy.md 3）
- Variables は秘密ではない値なので Secrets に入れない（ログで伏せ字にならず、見て確かめやすい）
- `permissions` は既定を `contents: read` にし、keepalive だけ `contents: write`
- トリガーは schedule と workflow_dispatch だけ。pull_request で起動しないので、フォークからの PR に Secrets が渡ることは無い

## 9. CLI: そのまま使えるもの・新しく要るもの・直すもの

`src/cli.ts` と `src/lib/` を読んで分けた。**CLAUDE.md とコードはこの文書では直さない**（実装と同じコミットで直す決まり）。

### そのまま使える

| コマンド | 理由 |
| --- | --- |
| `roster`・`crawl:daily`・`refresh` | 環境変数で動く。ステップの失敗は runs に partial として残し、終了コード 0（後続を止めない） |
| `resolve`（`--limit`・`--all`） | `mode: new` は未処理と照会エラーの枠を拾うので、`--limit` で切っても次の回が続きをやる（並びの直しは下） |
| `site:data` | 最初に前回の site-data.json を消す（失敗したらビルドが失敗する）。runs に記録する |
| `npm run site:build` | `SITE_URL`・`OG_CACHE`・`SITE_DATA` を環境変数で変えられる。og のキャッシュの掃除と `_redirects` の上限の確認も入っている |
| `ai:apply` | 中身は `ai:ingest` から呼ぶ（下の直しを足して）。同じファイルを何度入れても同じ |
| `crawl:hourly` | 日次では使わない。消さない（付録で戻すとき用） |
| `report:quota`・`ai:status` | 手で確かめるとき用（ワークフローからは呼ばない） |

`finishCtx` が毎回 `checkpoint(TRUNCATE)` して閉じるので、CLI のステップが正常に終われば WAL は空になっている。生レスポンスは1つの CLI につき1ファイル（日次で5〜6ファイル）。

### 新しく要る

| コマンド | 中身 | 終了コード |
| --- | --- | --- |
| `db:check --expect <meta.json>` | 2-3 の検査。DB が無ければ**作らずに**失敗する（`openDb` を使わない）。`--accept` で sha256・行数の照合を飛ばす | 外れたら 1 |
| `db:pack --against <meta.json> --out <dir>` | 2-4 の後始末（checkpoint・quick_check・行を消さない表の行数の比較・gzip・新しいメタデータの JSON） | 外れたら 1 |
| `ai:ingest --remote r2 --result <file> [--max-batches 5]`・`ai:ingest --settle <file>` | 6 の取り込み。batch ごと・ファイル名の順に `aiApply` を呼び、6-2 の時刻の決まりで飛ばし、6-3 の結果（入れた / やり直し / failed・件数・飛ばした動画・問題）と移す先を JSON に書く。受け箱の一覧・印・落とす・移すも CLI の中（6-1 の実装）。2026-11-13 実装（塊 C） | 0（結果は JSON で返す） |
| `candidates:select`・`candidates:fetch` | docs/ai-ops.md 3-1・3-2 の候補の選定（API なし）と詳細（videos.list）。中身は ai-ops の側で設計する | 0 |
| `site:fingerprint [--commit <sha>] [--date YYYY-MM-DD]` | 2-6 の指紋（generatedAt を除いた site-data.json の sha256）。`--commit` を渡すとコミットと日本時間の日付（既定は今日）も混ぜる。標準出力は `fingerprint=…` の1行（`$GITHUB_OUTPUT` に足せる） | 0。**site-data.json が無ければ 1**（3-1 の 13 が失敗する前提。2026-11-08 実装で決めた） |
| `job:due --meta <head.json>`（か `--written-at`・`--writer`）`[--hours 20]` | 5-2 の保険の cron。メタデータの `written-at` と `writer` だけで決め、日次が20時間以内に書いていれば `due=false`、値が無い・読めない・日次でない・未来なら `due=true` | 0 |
| `runs:summary --since <ISO> [--out <file>]` | 2-9 の結果。runs の行ごとに状態・秒・エラー数・クォータ、ステップの結果は**数だけ**（文字列は出さない。配列は件数）、エラーの文は300字まで、DB の大きさ。`--out` に追記し、partial・aborted・running（殺された回）は標準出力に `::warning::` | 0 |

- R2 の出し入れそのもの（落とす・置く・一覧・移す・メタデータ）は CLI にせず、ワークフローの中の AWS CLI の数行にする（2-2）。CLI にすると S3 の SDK を依存に足すことになる。
  ローカルの `ai:pull`・`ai:push` は CLI のコマンドで、中から `aws` を呼ぶ（2-2。2026-10-30 決定。作るのは ai-ops の側）。`.env.example` に R2 の4つの名前を足す
- `db:check`・`db:pack`・`site:fingerprint`・`job:due`・`runs:summary` は 2026-11-08 に実装した（塊 B。`src/lib/dbfile.ts`・`src/lib/jobtools.ts`）。どれも `createCtx` を通さない（runs に行を足さない・DB が無くても作らない）
- `db:check`・`db:pack` は**ワークフローを止めるための**コマンドなので、ほかのジョブと違って失敗で終了コード 1 を返す（docs/dev.md の「実行方法」に例外として書いた）

### 直す

| どこ | 何を |
| --- | --- |
| `src/resolve/resolve.ts` の対象の選び方（`ORDER BY e.id`） | 済（2026-11-08）。未処理の枠を先・照会エラーの枠を後に（`ORDER BY (u.reason = 'error'), e.id`）。`--limit` がエラーの枠で埋まらないように（Fable の中-6） |
| `src/report/ai.ts` の `aiApply` | 済（2026-11-13。塊 C）。(1) `problems` を種類（file・no_event・invalid・lookup・enrich）で返す。(2) 6-2 の時刻の決まりを瞬間で比べる（`answerFreshness`）。ローカルの `ai:apply` も同じ（D-09）。(3) 名前の順・`fix-` の決まりを関数の説明に書いた |
| `src/lib/quota.ts`・`src/lib/config.ts`・`config/crawl.yaml` | 済（2026-11-08）。`quota.ai_reserve: 600`（7）。job が hourly・daily のときは `stop_at − ai_reserve` で止める |
| `src/lib/http.ts` の HttpError | 済（2026-11-08）。URL のクエリの値とフラグメントを伏せ、名前だけ残す（runStep が runs とログに出すため）。パスは伏せない（日次で呼ぶ照会先のパスに照会の語は入らない。Wikipedia・Wikidata は POST の本文） |
| `src/resolve/ai.ts` の冒頭のコメント | 「定期実行のジョブからは入れない」→「判定は人が起動した回でだけ作り、ジョブは答えのファイルを取り込むだけ」（docs/ai-ops.md の 1。2026-10-26 決定） |
| CLI のログ | 公開リポジトリの Actions のログに概要欄・判定の根拠を出していないか確かめる（2-9） |
| `wrangler.jsonc`（新しく置く） | 済（2026-11-13）。`name`・`compatibility_date`・`workers_dev`・`preview_urls`・`assets`（directory・`not_found_handling: "404-page"`・`html_handling`）（docs/deploy.md 3） |
| CLAUDE.md | 「確定している前提」の取得方式（2時間ごと → 日次）、「これは何か」の3つめ、「crawl の分担」（今は docs/crawl.md）、「技術スタック」（Pages → Workers・R2 の置き場所と concurrency の組）、「実行方法」（今は docs/dev.md）に新しいコマンド、「フェーズ」。実装と同じコミットで |

## 10. 所要時間の見積もり

元にしたのは DB の写しの `runs` の表（job・started_at・finished_at・summary）と `data/crawl-1011.log`。API を呼ぶジョブは流していない。GitHub のランナー（米国）からの時間は測っていないので、手元の実績に通信の遅れを足した目安。

| ステップ | 実績（手元） | ランナーでの目安 |
| --- | --- | --- |
| 準備（checkout・setup-node・npm ci） | — | 1〜2分（未計測） |
| DB の取得・展開・検査 | gzip の展開 0.5秒・quick_check 0.3秒・integrity_check 1.3秒（332MB の写し） | 30秒以内（57MB の取得を含む。未計測） |
| `roster` | 12〜21秒（2026-10-08〜19 の4回） | 30秒前後 |
| `crawl:daily`（遡りなし） | 237秒（2026-10-11。uploads 127秒・メン限 107秒） | 4〜6分 |
| `crawl:daily`（遡り 3,000 ユニット） | 1,129〜1,332秒（2026-09-23） | 20〜25分 |
| `refresh` | 32秒（2026-10-11・7,610枠） | 1分以内 |
| 候補の選定と詳細 | 未実装 | 1分以内（推定。API は数回） |
| AI の答えの取り込み | `ai:apply` 0〜47秒（2026-10-08〜18 の回） | 1〜5分 |
| `resolve`（1日ぶんの新しい枠。数件〜数十件） | 68秒（2026-10-21・6件の照会）〜 198秒（2026-10-11・43枠） | 1〜4分。固定の後処理（視聴系列 11秒・画像 7秒・属性 3秒・型分け 5秒）が約30秒 |
| `site:data` | 0.3秒（2026-10-19〜22 の3回） | 数秒 |
| DB の後始末・gzip・書き戻し | gzip 3.5秒 | 30秒以内（未計測） |
| `site:build`（og のキャッシュあり） | **未計測**（キャッシュが無いと約3分のびる） | 1〜3分（推定） |
| アップロード（変わったファイルだけ送られる） | **未計測** | 1分前後（推定） |

| ワークフロー | 合計の目安 |
| --- | --- |
| 日次（ふだん） | 12〜20分 |
| 日次（遡りあり・新しい枠がたまっている） | 40〜90分（`resolve --limit 400` で 45分まで） |
| 保険の cron（もう済んでいる日） | 1分ほど |
| 手動 | 4〜7分（`resolve_all` ならキャッシュが効いて＋数分） |

- 1か月の Actions の時間は約20分 × 30日 ≒ 600分。公開リポジトリの標準のランナーは無料（docs/deploy.md の出典）
- 大きく外れうるのは名寄せ（照会の数しだい）と遡り。照会のキャッシュ（resolve_cache の30日）が効くので、ふつうは新しい区間の照会だけ
- resolve_cache は DB の約半分（153MB / 332MB。2026-10-22）。DB が大きくなるほど出し入れが遅くなるので、DB の大きさは 2-9 の結果に毎回出す

## 11. 決めること

1. ~~日次の時刻~~ → **決定: 日本時間 05:23（UTC 20:23）**（2026-10-30 ユーザー決定。5-2）。保険の cron は6時間後の 11:23（UTC 02:23）
3〜6 は 2026-10-30 にユーザーが推奨どおりに決めた。

2. ~~R2 の出し入れの道具~~ → **決定: ジョブもローカルも AWS CLI**（一覧・大きいファイル・メタデータが扱える。ローカルは 2026-10-30 ユーザー決定。2-2）
3. ~~DB と検査の値の対の守り方~~（Fable の高-2）→ **決定: 1つのオブジェクトのメタデータにまとめる＋手動の `accept_db`**（2026-10-30）。
   採らなかった案: meta に run_id を入れて別のファイルのまま／sha256 が合わなくても quick_check と行数で通す（取り違えを見逃す）
4. ~~DB の世代を残すか~~ → **決定: その日の最初の書き戻しの前に `db/backup/<日付>.sqlite.gz` を残し、14日で消す**（2026-10-30。57MB × 14 ≒ 0.8GB。R2 の無料枠 10GB の中）
5. ~~上限の値~~ → **決定: resolve は日次 400枠・45分、dist/ のファイル数は 15,000 で警告・18,000 で止める、取り込みは1回5 batch・やり直し3回で failed**（2026-10-30。仮の値として始め、実測で見直す）
6. ~~`_redirects` が上限に近づいたときの扱い~~ → **決定: 1,600 行で警告を出すだけにし、整理の決め方は警告が出てから決める**（2026-10-30。今は 16 行）

## 12. この下書きで確かめていないこと

- ランナーでの所要時間（10 はすべて手元の実績からの目安）。とくに `site:build` とアップロードは手元でも測っていない
- AWS CLI で R2 に出し入れできるか（チェックサムの設定・メタデータの付け方と読み方を含む）。2026-11-13 はローカルのフォルダで同じ手順を通しただけ（13-3）
- wrangler-action の入力（`wranglerVersion`・`command`）と `versions upload --preview-alias` を Actions から動かしたときの出力（版の URL の取り方）。Workers のトークンの最小の権限
- concurrency の待ちの取り消しの動き（公式の文書の記述だけ）と、ジョブのタイムアウトで殺されたときに `if: always()` のステップが動くか（ステップごとのタイムアウトで避けている）
- `db:check` の開き方: WAL のモードの DB を読み取り専用で開くと `-shm` を作れない場所では開けないことがある、と理解している（推測）。ランナーの作業フォルダは書けるので、ふつうに開いてマイグレーションだけしない形にする
- actions/cache の展開が og のキャッシュの更新日時を保つか（2-5）
- ~~YouTube の API の規約の「複数のプロジェクト」の文面（7）~~ → 2026-11-13 に読み直した（7）
- 今の CLI のログに概要欄が出ていないか（2-9。公開リポジトリのログは誰でも見られる）→ 2026-11-13 に日次で呼ぶコードのログの出し方を grep で見た。型分け（src/resolve/routing.ts）が Wikidata の照会に失敗したときに区間の文（概要欄から切り出した区間もありうる）を出していたので、出さないようにした。
  ほかは件数・動画の ID・エラーの文だけだった。照会先のエラーの文そのものに照会の語が入るか（HttpError の URL は伏せてある）は見ていない

## 13. 実装（2026-11-13。塊 F）

### 13-1. ファイル

| ファイル | 中身 |
| --- | --- |
| `.github/workflows/daily.yml` | 3-1 の日次。schedule 2本（`23 20 * * *`・保険の `23 2 * * *`）とボタン（入力 `target`・`crawl`） |
| `.github/workflows/publish.yml` | 3-2 の手動。入力 `target`・`force`・`resolve_all`・`accept_db` |
| `.github/workflows/keepalive.yml` | 3-3。`.github/keepalive` に日付を書いて push（`contents: write` はこれだけ） |
| `scripts/ci/job.sh <ステップ>` | ステップの中身。yml の `run` はこれを1ステップ1回呼ぶだけ（ローカルで同じものを通すため）。R2 の出し入れ（AWS CLI か `R2_LOCAL_DIR` のフォルダ）もここ |
| `scripts/ci/local-daily.sh` | daily.yml と同じ順・同じ「失敗したら」でローカルに通す（アップロードと actions/cache だけはしない）。終了コードはワークフローの色（赤なら 1） |
| `scripts/ci/install-aws.sh` | AWS CLI 2.39.1 を入れる（2-2） |
| `wrangler.jsonc` | Workers の静的アセット（docs/deploy.md 3） |

- 秘密の値はステップごとの `env` で、使うステップにだけ渡す（`npm ci` には渡さない）。`actions/checkout` は `persist-credentials: false`
- job.sh のステップ: `start`（入力の確かめ・始まりの時刻）・`due`（5-2）・`pull`（2-3）・`roster`・`crawl`・`refresh`・`candidates`・`retention`（3-1 の 6b。2026-11-13）・`ai-ingest`・`resolve`・`resolve-all`・`site-data`・
  `push`（2-4。日次はその日（日本時間）の最初なら `db/backup/` へ写してから。置いたメタデータを読み直して sha256 を確かめる）・`settle`・`raw`・`fingerprint`（2-6。`build=true|false`）・
  `build`・`check-dist`（2-7。dist/404.html が無くても止める）・`last-deploy`・`summary`（2-9）・`seed`（docs/deploy.md 1-D の最初の置き方。ワークフローからは呼ばない）
- dist/ のファイル数は `find dist -type f`。wrangler の「Read N files from the assets directory」はフォルダも数える（2026-11-13 の dist/ で 5,695 = ファイル 3,815 ＋ フォルダ 1,880）が、
  上限を見る manifest はファイルだけ（wrangler 4.155.0 のソースで確かめた）
- ローカル（Actions の外）の job.sh は、R2 の4つ（`R2_ACCESS_KEY_ID` など）が環境に無ければ `.env` から読む。`R2_PREFIX` は `.env` から読まない（試しの置き場所は起動するときに明示する）

### 13-2. 本物の DB を置く前の試し（R2_PREFIX）

    1. ローカルで写しを試しの置き場所に置く:   R2_PREFIX=test/ SEED_DB=<DB の写し> DATA_DIR=data/seed bash scripts/ci/job.sh seed
    2. GitHub の Variable に R2_PREFIX = test/ を作る
    3. Actions → daily → Run workflow: target = preview・crawl = false（YouTube を呼ばない。true なら 1日 800 ユニットほど）
    4. 見るもの: 緑か・step summary・R2 の test/db/db.sqlite.gz のメタデータ（writer = daily）・test/db/backup/・プレビューの URL
    5. 済んだら Variable の R2_PREFIX を消し、バケットの test/ を消す

`R2_PREFIX` がある回で target が production なら、`start` が赤で止める（本番に試しのデータを上げない）。

### 13-3. ローカルで通した記録（2026-11-13）

- DB: 本体の data/db.sqlite（2026-11-04 02:22 の更新。user_version 11）を `VACUUM INTO` で作業ツリーの data/db.sqlite に写した（本体は読むだけ）。og:image のキャッシュは本体の data/site/og-cache（1,843枚）の写し
- R2 の代わり: `R2_LOCAL_DIR=data/trial-r2`・`R2_PREFIX=test/`。最初に `seed` で写しを置いた（55.2MB・メタデータ付き。2回目は「もうある」で止まった）
- 1日目: `local-daily.sh`（`CRAWL=false`。巡回の4ステップは YouTube のクォータを使うので飛ばした）。受け箱に本体の data/ai/ai-run-9/answers/01.json（入れ済みの答え23件）を置いた。
  名寄せとチェックのステップが「失敗」になったが、**走っている途中に job.sh を書き換えたため**（bash がファイルを途中から読み直した）で、CLI の名寄せは ok。これを受けて job.sh と local-daily.sh を関数に包み、最後の1行で呼ぶ形にした
- 2日目（1日目が書き戻した DB から。書き換えのあと）: 全ステップ緑。pull（sha256・integrity_check・user_version 12（1日目にマイグレーション 12 が入った）・行数）→ ai-ingest（ai-run-8 の2ファイル。古い答え14・入れ済み49 → applied）→
  resolve（対象0）→ site:data（5,101枠）→ push（`db/backup/2026-11-13` は「もうある」の分岐・行が減っていない・sha256 の読み直し）→ settle（ai-run-8 を ai/applied/ へ2ファイル）→ fingerprint（1日目と同じデータの指紋）→ build（1,868ページ）→ check-dist（3,815ファイル・_redirects 16行）
- `npx wrangler@4.155.0 deploy --dry-run` と `versions upload --preview-alias preview --dry-run` が wrangler.jsonc と dist/ で通った（アカウントには触れていない）
- 失敗をわざと起こした（scripts は作業用のフォルダ。R2 のフォルダは試しごとに data/trial-r2 の写しを使い、置いてある全ファイルの sha256 を前後で比べた）。11項目すべて期待どおり:

  | # | 起こしたこと | 期待 | 結果 |
  | --- | --- | --- | --- |
  | T1 | メタデータの sha256 を 0 にした（local-daily で1周） | pull で赤・push と build は動かない・R2 は変わらない | そのとおり（10ファイルの sha256 が同じ） |
  | T2 | pull のあと ai_decisions を3行消して push | 「行を消さない表の行が減った: ai_decisions」で終了コード 1・out/ に gzip を残さない・R2 は変わらない | そのとおり |
  | T3 | R2 に DB が無い | pull で赤・空の DB を作らない | そのとおり |
  | T4 | gzip の1000バイト目を壊した | pull で赤（gzip -t） | そのとおり |
  | T5 | R2_PREFIX があるのに target = production | start で赤 | そのとおり |
  | T6 | 保険の判定: 日次が書いたばかり／writer = manual／DB が無い | false／true／true | そのとおり |
  | T7 | site-data.json が無い | fingerprint で終了コード 1（ビルドしない） | そのとおり |
  | T8 | 本番の指紋を last-deploy.json に書いた | build=false。force と preview は true | そのとおり |

- **この試しで確かめていないこと**: AWS CLI の側（R2 のフォルダの代わりにしたので、`aws` の引数・メタデータの付け方と読み方・チェックサムは動かしていない）、GitHub の上での動き（`if` の組み合わせ・concurrency・actions/cache・wrangler-action の出力）、
  巡回の4ステップ（クォータを使うので流していない）、名寄せの対象がある回の所要時間（2回とも対象0。1日目は Wikidata のアニメのまとめに145秒）、ジョブのタイムアウトで殺されたときの動き、
  keepalive の push。yml の文法は actionlint 1.7.12（リリースの checksums で照合）で0件（shellcheck は入れていないので、yml の中の短い `run` のシェルは見ていない。job.sh は `bash -n` だけ）

### 13-4. GitHub で手で起動する手順（段6。リポジトリ・Cloudflare・Secrets が済んで push したあと）

    1. Variables: R2_BUCKET・SITE_URL（・試しなら R2_PREFIX）。Secrets: 8 の6つ。SCHEDULE_ENABLED はまだ作らない
    2. R2 に DB を置く（13-2 の 1。試しなら R2_PREFIX=test/）
    3. Actions → daily → Run workflow（target = preview。最初は crawl = false）→ 緑と step summary とプレビューの URL を見る
    4. プレビューで確かめる（docs/phase4-plan.md の段6: 末尾スラッシュ・301・404・noindex）
    5. 試しの R2_PREFIX を消し、本物の DB を置いて publish（preview）→ ユーザーが確認 → publish（production）→ Search Console → daily を手で1回 → SCHEDULE_ENABLED = true

- **Worker がまだ無いときに `versions upload` が通るかは確かめていない**（文書に書かれていない）。3 で「Worker が無い」で失敗したら、そこで止めてユーザーに聞く（本番の `deploy` で作るか、ダッシュボードで作るか）

## 付録. 2時間ごとに戻すとき

需要があって「これから始まる枠」（予定枠・配信中・LIVE バッジ）と2時間ごとの巡回を戻すときの手順。コードは残してある（`crawl:hourly`・`config/crawl.yaml` の `hourly`・`site.yaml` の `upcoming_stale_hours`）。

- `daily.yml` に2時間ごとの cron を足す（例 `23 0-18/2,22 * * *`。日次の時刻の回を除く）。その回は「DB を取得 → `crawl:hourly` → 取り込み → `resolve --limit 150` → `site:data` → 書き戻し → ビルド → アップロード」
  （2026-10-23 の下書きはコミットしていないので、手順はこの行のとおり）。ステップのタイムアウトの合計を2時間より短くする
- 1つのファイルにまとめるのは、concurrency の「待っている回が取り消される」で日次が落ちないようにするため（日次の時刻には2時間ごとの回を置かない）
- クォータは2時間ごとの回で約 550〜650/日増える（playlistItems の順繰りが1回47・予定枠と配信中の取り直し）。8,400 の中に収まる
- 2-6 の指紋は、配信中の枠の再生数で `viewsFetchedAt` が毎回変わるので、「終わった枠だけの最大」にする（そうしないと毎回アップロードになる）。アップロードは月に約390回になる（Workers にはビルドの回数の枠は無い）
- UI の側（トップの「これから始まる枠」・決定 A の6時間）は別に戻す
