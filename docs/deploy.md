# Web サイトへのアップロード（公開）の手順

2026-10-07 の下書き（2026-10-19 に、巡回の間隔（2時間ごと。2026-10-11 決定）と Phase 3 の初めの決定 D に合わせて直した）。**まだ作っていないもの（Phase 3 の UI・Phase 4 のワークフロー）を含む。**
CLAUDE.md の決定（Cloudflare Pages へ Actions から直接アップロード、DB と生レスポンスは R2 の非公開領域、定期実行は GitHub Actions）と、
公式の文書で確かめた事実（末尾の表）から組んだ。決まっていないことは「6. 決めること・確かめること」に分けた。
**2026-10-26 にユーザーが公開の基盤を決めた**（6-1 Workers・6-2 独自ドメインなし・6-4 生レスポンス30日・6-5 R2 を使う・6-6 noreply に書き換える）。
この文書の Pages の手順は Workers に直した。CLAUDE.md・コードで直す箇所は 6-10 に一覧にした（実装と同じコミットで直す）。
**2026-10-27 にユーザーが、2時間ごとの巡回とトップの「これから始まる枠」をやめ、定期実行を日次だけにすると決めた**。この文書の2時間ごとの前提を日次に直した（ワークフローの中身は docs/workflows.md が正）。

## 今の状態

| もの | 状態 |
| --- | --- |
| 取得・名寄せのジョブ（CLI） | ある（ローカルで実行している） |
| サイトのビルド（集計・Astro。出力は `dist/`） | ある（2026-10-19。`npm run cli -- site:data` → `npm run site:build`。2026-10-26 21:40 のビルドで3,807ファイル・約97MB（og:image の PNG・HTML が大半。docs/workflows.md 2-7 も 3,807）。og:image のキャッシュが無いと約3分） |
| ワークフロー（`.github/workflows/`） | ある（2026-11-13。塊 F。daily.yml・publish.yml・keepalive.yml。中身は scripts/ci/job.sh。GitHub ではまだ動かしていない） |
| Workers の設定（`wrangler.jsonc`） | ある（2026-11-13。Worker 名は仮の `simulwatch`） |
| GitHub のリポジトリ | 無い（git の remote が未設定。予定は `kelly302/simulwatch`） |
| Cloudflare（Workers・R2） | 未設定 |

いまアップロードできるものはまだ無い。下の「1. 最初に1回だけやること」は Phase 3 の実装と並行して進められる。

## 全体の流れ

    GitHub Actions（日次の schedule。2時間ごとは 2026-10-27 にやめた）
      1. R2 から DB（SQLite）を取得
      2. ジョブ（名簿・巡回・再生数の取り直し・続きの回の候補・AI の答えの取り込み・名寄せ）
      3. DB と生レスポンスを R2 に書き戻す
      4. 集計（site:data）→ Astro でビルド（site:build。dist/）
      5. wrangler で dist/ を Cloudflare Workers（静的アセット）にアップロード
                                   ↓
                     https://<Worker名>.<アカウントのサブドメイン>.workers.dev（独自ドメインは使わない。6-2）

「アップロード」は 5 の1コマンド。人が毎回やる作業は無い（手でやる方法は「4.」）。

## 1. 最初に1回だけやること（ユーザーの手作業）

アカウントの作成とキー・トークンの発行・入力は、Claude は代わりにできない。

### A. GitHub

1. 公開リポジトリ `kelly302/simulwatch` を作る（`config/crawl.yaml` の User-Agent にこの URL を書いている）
2. **push の前に、履歴の作者・コミッターのメールアドレスを GitHub の noreply に書き換える**（6-6 の決定）。
   GitHub のメールの設定で「Keep my email address private」をオンにして noreply のアドレスを控え、以後のコミットもそのアドレスで記録するよう git の設定を変える
   **済（2026-11-04）**: 80コミットを `126982655+kelly302@users.noreply.github.com` にし、`.git/config` の user.email も同じにした（記録は docs/ai-runs.md の 2026-11-04 の節）
3. ローカルから push する
4. 公開の前の確認（2026-10-07 に確認済み）
   - `.env` は一度もコミットされていない。`.env` の2つの値は、履歴のどのコミットにも追跡中のどのファイルにも無い
   - `data/`（DB・生レスポンス・メン限枠の概要欄を含む判定のファイル）は追跡していない（2026-10-19 に確かめ直した。追跡中は77ファイルで、data/ の下は0）
   - 75コミット（2026-10-26。全ブランチ）すべての作者・コミッターのメールアドレスが個人の Gmail だった → 2026-11-04 に noreply に書き換えた（6-6）

### B. Cloudflare

1. アカウントを作る
2. R2 を有効にする: ダッシュボード → Storage & databases → R2 → Overview → チェックアウトを済ませる（→ 6-5。支払い方法の入力が求められたら、それもユーザーの作業）。
   使用量・請求の通知を設定できる画面があれば設定する
3. バケットを1つ作る（例 `simulwatch-data`）。公開アクセス（r2.dev・独自ドメイン）は有効にしない。
   ライフサイクルのルールを2つ付ける（ダッシュボードか `npx wrangler r2 bucket lifecycle add`）:
   - `raw/` を30日で消す（6-4）。`raw/<日付>/` の日付は **UTC**（src/lib/rawlog.ts が run_id の先頭10文字＝ジョブを始めた時刻の UTC の日付を使う）。消える日はオブジェクトを置いた時刻から数えるので、日付のずれは消える日に関係しない
   - `db/backup/` を14日で消す（docs/workflows.md の 11-4。日次の最初の書き戻しの前の DB。14日は 2026-10-30 に workflows.md 11-4 で決めた）
4. R2 の API トークンを作る: R2 → API Tokens の Manage → 権限は **Object Read & Write**、対象は 3 のバケットだけ。
   **Access Key ID と Secret Access Key は作った直後の1回しか表示されない**
5. workers.dev の**アカウントのサブドメイン**を決める（Workers & Pages → Your subdomain）。サイトの URL `<Worker名>.<サブドメイン>.workers.dev` の一部になるので、
   公開してから変えると URL が変わる（変えること自体はダッシュボードでできる）。Worker 名は設定ファイルの `name`
6. デプロイ用の API トークンを作る: API Tokens → Create Token。権限は Workers のスクリプトの編集（テンプレートの「Edit Cloudflare Workers」か、Custom Token で必要な権限だけ）。
   **どの権限で足りるかは、2026-10-26 の時点で文書で確かめていない**（ワークフローを書くときに確かめる）
7. アカウント ID を控える

Pages のプロジェクトを作る手順（`wrangler pages project create`）は要らなくなった（6-1）。Worker は最初の `wrangler deploy` で作られる。

### C. GitHub の Secrets と Variables に入れる

リポジトリの Settings → Secrets and variables → Actions。Secrets は「Secrets」のタブ、Variables は「Variables」のタブ（秘密ではない値。ログで伏せ字にならない）。
名前と中身は docs/workflows.md の 8章が正（ここはその写し）。

| 名前 | 種類 | 中身 | 使うところ |
| --- | --- | --- | --- |
| `YOUTUBE_API_KEY` | Secret | ローカルの `.env` と同じ | 巡回 |
| `ANNICT_TOKEN` | Secret | ローカルの `.env` と同じ | 名寄せ・AI の答えの取り込み |
| `CLOUDFLARE_ACCOUNT_ID` | Secret | B-7 | wrangler・R2 の接続先 |
| `CLOUDFLARE_API_TOKEN` | Secret | B-6 | Workers へのアップロード |
| `R2_ACCESS_KEY_ID` | Secret | B-4 | DB・生レスポンス・AI の答えの出し入れ |
| `R2_SECRET_ACCESS_KEY` | Secret | B-4 | 同上 |
| `R2_BUCKET` | Variable | B-3 のバケット名（例 `simulwatch-data`） | 同上 |
| `SITE_URL` | Variable | 本番の URL `https://<Worker名>.<サブドメイン>.workers.dev`（B-5 で決める）。astro.config.mjs が config/site.yaml の仮の URL より優先して読む | ビルド |
| `SCHEDULE_ENABLED` | Variable | `true` で schedule の回を動かす。最初の公開（6-8）が済むまで入れない | 日次 |
| `R2_PREFIX` | Variable | 試しの置き場所（例 `test/`）。写しで日次を1周するときだけ作り、済んだら消す（docs/workflows.md 13） | 日次・手動 |

上の2つは今の `.env` と同じ名前。Cloudflare の2つは公式の例の名前。前の下書きにあった `PAGES_PROJECT` は Workers に決めたので要らない（6-1。docs/workflows.md 8章からも外してある）。

### D. 最初の DB を R2 に置く

ローカルの `data/db.sqlite`（2026-10-19 に 338MB。ルールと AI の判定が入っている最新）が本番の最初の DB になる。置いたあとは **R2 の DB が正**で、ローカルは写し（→ 6-7）。

- wrangler の `r2 object put` は1ファイル 315MB まで。**DB はそのままでは上限を超えている**（2026-10-19 に 338MB）
- gzip すると 58MB（2026-10-07 に計測。そのときは 319MB）。**R2 には gzip した DB を置く**（docs/workflows.md の 1章。キーは `db/db.sqlite.gz`。検査用の値は別のファイルにせず、このオブジェクトのメタデータに持つ（docs/workflows.md 2-3・11-3。2026-10-30 決定）。2026-10-22 の写しで 332MB → 57MB）
- **置き方**（2026-11-13。ローカルの AWS CLI と `.env` の R2 の4つで。Git Bash）: 本体の DB を `VACUUM INTO` で `data/db.before-r2.sqlite` に写してから

      SEED_DB=data/db.before-r2.sqlite DATA_DIR=data/seed bash scripts/ci/job.sh seed

  `db:pack --initial` で梱包し（checkpoint・quick_check・gzip を展開して照合）、メタデータ（docs/workflows.md 2-3）を付けて `db/db.sqlite.gz` に置き、置いたメタデータの sha256 を読み直して確かめる。
  もう置いてあれば止まる（`SEED_OVERWRITE=true` で上書き）。`R2_PREFIX=test/` を付ければ試しの置き場所に置く。R2 の代わりに `R2_LOCAL_DIR=<フォルダ>` でも同じ手順が通る（2026-11-13 にこの形で試した）

## 2. Claude が作るもの（Phase 3〜4）

| もの | 中身 |
| --- | --- |
| サイトのビルド | 集計 → 画面ごとの JSON と HTML → `dist/`。`_headers`（JSON に `X-Robots-Tag: noindex`）・`_redirects`（作品の URL が変わったときの 301）・404 ページ |
| 日次のワークフロー | DB を取得 → `roster` → `crawl:daily` → `refresh` → 候補の選定と詳細 → AI の答えの取り込み（`ai:ingest`）→ `resolve` → `site:data` → DB を書き戻す → 取り込んだ答えを受け箱から移す → 生レスポンスを R2 へ → 中身が変わっていればビルド → アップロード（細部は docs/workflows.md の日次の節が正） |
| 手動のワークフロー | ボタンで「ビルドとアップロードだけ」を実行する（`workflow_dispatch`）。入力 `resolve_all: true` で `resolve --all` も流す（ルールを直してコミット・push したあと、本番の DB で名寄せし直す。docs/workflows.md 3-2） |
| keepalive のワークフロー | 月1回の軽いコミット（schedule が60日で止まるのを防ぐ）。**`SCHEDULE_ENABLED` を見ないので、公開の前でも既定のブランチに置いた時点から動き、リモートの main が進む。ローカルから push する前に `git pull --rebase` する**（docs/workflows.md 3-3） |

2時間ごとのワークフローは 2026-10-27 にやめた（ユーザー決定。トップの「これから始まる枠」もやめた）。

守ること（CLAUDE.md のルールから）:

- DB を書くワークフローは同時に1つだけ（Actions の `concurrency`）
- **R2 から DB を取れなかったら、そこで止める**。空の DB で始めて書き戻さない（既存データを消さない）
- ジョブの途中のステップが失敗しても、DB の書き戻しは必ず行う
- ビルドが失敗したらアップロードしない（前の版がそのまま公開され続ける）
- アップロードの前に `dist/` のファイル数を数え、上限（20,000）に近づいたら止めて知らせる（2026-10-26 に3,807。15,000 で警告・18,000 で止める。docs/workflows.md 2-7・11-5）
- `site:data` は作品の公開キーと lastmod の表を DB に書くので、DB の書き戻しより前に動かす
- `site:data` は最初に前回の `site-data.json` を消す。書き出しに失敗するとビルドがファイル無しで失敗し、アップロードしない（前の版が公開され続ける）。
  `data/site/` をキャッシュに入れても、古いデータを公開しない
- og:image のキャッシュ（`data/site/og-cache/`）を残す（Actions のキャッシュか R2。無いと毎回約3分のびる。docs/workflows.md 2-5 で Actions のキャッシュにした）。ビルドが使わなかった画像は消すので、枚数は作品・配信者のページの数＋1
- schedule は正時（0分）を避ける（混雑で遅れる。公式の注意）

## 3. 毎回のアップロード（自動）

ワークフローの最後のステップ（6-1 で Workers に決めた。2026-10-26）。リポジトリの直下の `wrangler.jsonc`（2026-11-13 に置いた）:

    {
      "name": "simulwatch",                      // 仮。公開の URL の一部になる（1-B-5）
      "compatibility_date": "2026-10-28",
      "workers_dev": true,
      "preview_urls": true,                      // 版の URL・preview の別名の URL を出す
      "assets": { "directory": "./dist", "not_found_handling": "404-page", "html_handling": "auto-trailing-slash" }
    }

アップロードは daily.yml・publish.yml の `cloudflare/wrangler-action`（コミットの SHA で v4.1.3 に固定。`wranglerVersion: "4.155.0"`）。本番は `deploy`、プレビューは `versions upload --preview-alias preview`
（docs/workflows.md 2-8）。Worker のコードは無く、`dist/` を静的アセットとしてそのまま出す。

- `cloudflare/wrangler-action` の最新は 2026-11-13 も v4.1.3（2026-09-24）。`wranglerVersion` で版を固定できる（README）
- 20,000ファイルを使うには wrangler 4.34.0 以上（公式）。`_headers`・`_redirects` は `dist/` に置けばそのまま効く（公式）
- `not_found_handling: "404-page"` で、いちばん近い `404.html` を 404 で返す（公式）
- プレビュー（本番に出さずに確かめる URL）は、`wrangler versions upload --preview-alias preview` の版の URL を使う（2026-10-27 に Cloudflare の文書の Previews で確かめた。docs/workflows.md 2-8。Actions から動かしたときの出力は未確認）。
  URL は `preview-<Worker名>.<サブドメイン>.workers.dev`。別名は英小文字・数字・ダッシュで、`別名-Worker名` が63文字まで（2026-11-13 に文書で確かめた）。`preview_urls: true` を設定に書いた（無いと workers_dev の設定に従う）
- 末尾スラッシュ: 既定の `html_handling: "auto-trailing-slash"` は、`/works/x/index.html` がある `/works/x` を 307 で `/works/x/` に送る（公式の表）。ファイルが無いときの動きは表に無い。
  `_redirects` は「アセットがあってもなくても常に」先に効く（公式）ので、無くなったページの 301 は今の `_redirects`（両方の形）で効く見込み。段6 のプレビューで確かめる

## 4. 手でアップロードする（ローカルから）

ワークフローが止まっているとき・公開の前に見た目を確かめるとき用。

    npx wrangler login
    npm run cli -- site:data && npm run site:build                       # dist/ を作る
    npx wrangler deploy                                                  # 本番へ（プレビューは npx wrangler versions upload --preview-alias preview。「3.」）

プレビュー・版の URL も、URL を知っていれば誰でも見られる（Cloudflare Access で塞げる。公式）。

## 5. アップロードのあとに確かめること

| 何を | どうやって |
| --- | --- |
| 6つの画面が開く（トップ・作品一覧・配信者一覧・作品ページ・配信者ページ・ランキング） | 本番の URL をブラウザで（スマホの幅でも） |
| 無いページが 404 になる | 枠が0の作品の URL など |
| 公開キーが変わった作品の旧 URL が 301 になる | `curl -I` で末尾スラッシュあり・なしの両方（`_redirects` に両方の形を書いている。Workers の上での効き方は未確認） |
| JSON に `X-Robots-Tag: noindex` が付いている | `curl -I <JSON の URL>` |
| ジョブが毎日動いている | GitHub の Actions の履歴、DB の `runs` |
| YouTube のクォータ | `report:quota`（1日 10,000。ジョブは AI の判定の取り分 600 を除いた **8,400** で止める。docs/workflows.md 7章・docs/ai-ops.md 5章） |
| R2 の使用量 | Cloudflare のダッシュボード（→ 6-4・6-5） |
| 404・`_headers`・`_redirects` が Workers の上で効いている | 上の3行（Workers に決めたので、Pages の「ビルド回数」は見なくてよい。6-3） |
| `_redirects` の行数 | ビルドのログ「_headers と _redirects（○件・○行）」。1転送につき2行（末尾スラッシュあり・なし）なので、**上限 2,000行 ＝ 1,000転送**。2026-10-26 の dist/ で16行（8転送） |

`_redirects` が 2,000行を超えると、astro.config.mjs（58行あたり）がビルドを失敗させる。ビルドが失敗するとアップロードしないので、**サイトが更新されなくなる**（前の版が出続ける。巡回と DB の書き戻しは続く）。
近づいたときの扱い（2026-10-30 決定。docs/workflows.md 11-6）: 1,600行で警告（`::warning::`）を出すだけにし、整理のしかたは警告が出てから決める。候補は超える前に (1) 末尾スラッシュの無い形をやめて1転送1行にする、(2) 古い転送（例 1年以上前に変わったキー）から外す、のどちらかを決める。
## 6. 決めること・確かめること

6-1・6-2・6-6 は公開の前（Phase 4 の最初のアップロードの前）に決める（2026-10-19 の決定 D）。**2026-10-26 にユーザーが 6-1・6-2・6-4・6-5・6-6 を決めた**（下の各節の「決定」）。
公式の文書は 2026-10-23 に確かめ直した（末尾の「確かめ直した事実と出典」）。

### 6-1. Pages のままか、Workers にするか — **決定: Workers（静的アセット）**（2026-10-26 ユーザー決定）

Cloudflare の Pages の文書の先頭には今も「Start new projects with Workers.」と書かれている（Pages が終わるとは書かれていない。2026-10-23 に確かめた）。
Workers の静的アセットでも、同じ `dist/` をそのまま出せる。

| | Pages | Workers の静的アセット（決定） |
| --- | --- | --- |
| ファイル数・1ファイルの大きさ（無料） | 20,000・25MiB | 同じ（20,000ファイルは wrangler 4.34.0 以上） |
| `_headers`・`_redirects` | 100行・固定2,000＋動的100 | 同じ |
| 静的ファイルへのリクエスト | 無料 | 無料・無制限（公式に明記） |
| アップロード | `wrangler pages deploy dist` | `wrangler deploy`（`wrangler.jsonc` に `assets.directory`） |
| 404 ページ | 自動 | 設定で指定（`not_found_handling: "404-page"`。いちばん近い `404.html`） |
| 公開の URL（独自ドメインなし） | `<プロジェクト名>.pages.dev` | `<Worker名>.<アカウントのサブドメイン>.workers.dev`（1段長い） |
| 月500ビルドの上限 | 直接アップロードが数えられるか不明（6-3） | ビルドの上限という枠が無い |

決めた理由: 公式が新しいプロジェクトに Workers を勧めていること、6-3 の「ビルド回数に数えられるか」の不安が無くなること。
独自ドメインを使わない（6-2）ので、DNS の違い（Workers は Cloudflare のゾーンが要る）は関係しない。代わりに URL が Pages より1段長くなる。

これで変わること: この文書の 1-B・3・4・5 を Workers の手順に直した（2026-10-26）。CLAUDE.md・コード・設定で直す箇所は 6-10。

### 6-2. 独自ドメインを使うか — **決定: 使わない。workers.dev で公開する**（2026-10-26 ユーザー決定）

- 2026-10-07 の「広告の審査が pages.dev のサブドメインで通るかは未確認」は、**AdSense にサイトとして登録はできる**まで確かめた（2026-10-23）。
  AdSense が足せるのは「ドメイン」と「Public Suffix List（PSL）に載っている基盤のサブドメイン」で、`pages.dev`・`workers.dev`・`r2.dev` は PSL の Cloudflare の節に載っている
- **審査に通るか**（中身の質の評価）は文書からは分からない。ドメインの種類で落ちるかどうかも書かれていない
- 独自ドメインの費用（年に約1,000〜2,000円）をかけない。公開後に独自ドメインへ移すときは、301 と Search Console の移転が要る
- 6-1 で Workers にしたので、URL は `<Worker名>.<アカウントのサブドメイン>.workers.dev`。**アカウントのサブドメインと Worker 名は最初の公開の前に決める**（1-B-5）。
  config/site.yaml の仮のサイトの URL も、そのとき本番の URL に替える

### 6-3. アップロードの回数（確かめること。6-1 で Workers にしたので、Pages に戻さない限り不要）

日次だけにした（2026-10-27）ので、アップロードは**月に約30回**＋手動の回（2時間ごとのころは約390回、毎時のころは約750回）。
Pages に戻しても「月500ビルド」には十分に収まる。Pages の「月500ビルド」に直接アップロードが数えられるかは、公式の文書に今も書かれていない（2026-10-23 に確かめ直した）。
「中身が変わったときだけアップロードする」（docs/workflows.md 2-6）は、回数のためではなく無駄なアップロードを避けるために残す。

### 6-4. 生レスポンスを R2 に何日残すか — **決定: 30日**（2026-10-26 ユーザー決定）

R2 の無料枠は保存 10GB-月（Standard のみ）。DB は gzip で約0.06GB。生レスポンスは消さなければ増え続ける。

- ローカルの実績（2026-10-26 に `data/raw/` を数え直した。手で流した15日ぶんで計 470MB）: 1日 1MB〜121MB（多い日は `resolve --all` のやり直しを含む。ふつうの巡回の日は 26〜72MB）。
  ふつうの巡回の日は `crawl:daily` を含む日なので、**日次だけ（1日1回）なら1日 30〜70MB 前後**の見込み。日次のジョブを本番で動かしたときの量は未計測
- 30日ぶんの見込み: 1日 70MB で約2.1GB（2時間ごとをやめたので、前の見込みの「1日 120MB で約3.6GB」より少ない）
- ほかの置き物: `db/db.sqlite.gz` 約57MB、`db/backup/` 14日ぶん 約0.8GB（docs/workflows.md 11-4）、AI の答え（小さい）。**合わせて約3GB で、無料枠 10GB の中**
- R2 のライフサイクルのルールで `raw/` に「30日で削除」を付ける（消えるのは期限からふつう24時間以内。wrangler の `r2 bucket lifecycle add` でも設定できる）。設定は 1-B-3

決めた理由: デバッグ用なので。resolve_cache の30日とそろう。**公開して最初の1か月の実際の量を見て、見直す**。

### 6-5. R2 の登録 — **決定: R2 を使う**（2026-10-26 ユーザー決定）

- R2 を使うにはチェックアウトで R2 のサブスクリプションをアカウントに足す。請求は使った量に応じて月ごと（公式。2026-10-23 に確かめ直した）
- **支払い方法の登録が要るかは、公式の文書に今も書かれていない**（解説記事では要るとされる）。登録の画面で分かる。カードなどの入力はユーザーの作業
- 無料枠を超えたぶんは止まらずに課金される（Standard の保存は $0.015/GB-月）。操作の回数は余裕がある（日次の DB・生レスポンス・受け箱の出し入れで月に数百回。無料枠は書き込み系100万回・読み出し系1,000万回）
- 「無料枠のみで完結」は次の3つで守る: (1) `raw/` を30日・`db/backup/` を14日で消す（6-4・1-B-3）、(2) 登録のときに使用量・請求の通知を設定できればする（できなければ月に1回ダッシュボードで見る）、
  (3) 公開して1か月の使用量をこの文書に書く
- R2 を使わない案（DB を Actions のキャッシュ・成果物に置く）は、消えることがあり「取得失敗時に既存データを消さない」に合わないので採らない
- 使用量の通知がどこで設定できるかは、2026-10-26 の時点で確かめていない（登録の画面で見る）

### 6-6. コミットの作者のメールアドレス — **決定: GitHub の noreply に書き換える**（2026-10-26 ユーザー決定）

- 2026-10-26 の75コミット（全ブランチ）は、作者・コミッターとも個人の Gmail で記録されていた。remote はまだ無い（一度も push していない）
- **済（2026-11-04）**: 80コミットの作者・コミッターを `rextn <126982655+kelly302@users.noreply.github.com>` に書き換え、`.git/config` の user.email も同じにした（名前は rextn のまま）。書き換える前の履歴はリポジトリの外の `同時視聴サイト-before-noreply.bundle`。古い ID と新しい ID の対応は docs/ai-runs.md の 2026-11-04 の節
- GitHub の noreply は `ID+ユーザー名@users.noreply.github.com`（メールの設定の「Keep my email address private」で表示される）
- コミット用のアドレスを変えても、前のコミットは前のアドレスのまま（GitHub の文書）。なので**最初の push の前に、履歴の全コミットのアドレスを書き換える**（`git filter-repo` の mailmap など。コミットの ID はすべて変わる）。
  以後のコミットも noreply で記録するよう git の `user.email` を変える
- 書き換えは、同じフォルダで作業しているほかのセッションが無いときに1回だけやる（ブランチ・worktree が残っていれば、それも書き換えるか消す）。手順は 1-A-2
- 書き換えの前に消してよい worktree（2026-10-27 に `git worktree list` で確かめた）: `.claude/worktrees/ui-redesign-1b8bf6`（ブランチ `claude/ui-redesign-1b8bf6`。main に入れ済み）。
  → 2026-11-04 にユーザーが書き換えを始めると決め、消した（直しかけの変更が無いことを確かめてから）
- 確かめた（2026-11-04）: 書き換えの前の全コミットの全ファイルとメッセージに Gmail のアドレスは書かれていなかった（0件）。書き換えたあとの全オブジェクトにも0件

### 6-7. 公開後のローカルの作業（D-03 で決まった。正は docs/ai-ops.md・docs/workflows.md 6章）

公開後は R2 の DB が正で、日次のジョブ（と手動のワークフロー）が書く。ローカルからは R2 の DB を書かない。
- AI の判定: ローカルで作った答えを R2 の受け箱（`ai/inbox/`）に置き、日次のジョブが `ai:ingest` で取り込む（docs/ai-ops.md・docs/workflows.md 6章）
- ルールを直したあとの `resolve --all`: コミットして push し、手動のワークフローを `resolve_all: true` で流す（docs/workflows.md 3-2）
- CLAUDE.md の「未確定」（今は docs/backlog.md）の「AI の判定の公開後の運用」は、「決まった」に直してある（docs/decisions.md の D-03）

### 6-8. 最初の公開の段取り（提案）

プレビューにアップロード → ユーザーが確認 → 本番にアップロード → Search Console に登録 → schedule を有効にする（Variable の `SCHEDULE_ENABLED` を `true`）、の順。

Search Console の所有権の確認: workers.dev は自分のドメインでないので DNS のレコードを置けず、**「ドメイン」のプロパティは使えない**。
「URL プレフィックス」のプロパティ（`https://<Worker名>.<サブドメイン>.workers.dev/`）で、HTML ファイル（`site/public/` に置く）か HTML タグ（meta タグ。レイアウトの head に入れる）で確かめる
（Google のヘルプ: ドメインのプロパティは DNS だけ、URL プレフィックスは HTML ファイル・HTML タグなども使える。2026-10-27 に確かめた）。
**置き場所**（2026-11-13）: HTML タグなら、Search Console が出す meta タグの `content` の値を config/site.yaml の `search_console_verification` に書く（空ならタグを出さない。トップのページ `/` の head にだけ入る。site/layouts/Base.astro）。
HTML ファイルなら、渡された `google….html` を `site/public/` に置く（dist/ の直下に出る）。どちらもコミットして push し、本番にアップロードしてから Search Console で「確認」を押す。確認のあとも消さない

### 6-9. GitHub Actions の規約（知っておくこと。2026-10-08 に確認）

GitHub の規約は、GitHub のランナーを「そのリポジトリのソフトウェアの制作・テスト・デプロイ・公開に関係のない活動」に使うことと、
「CDN やサーバーレスのアプリの一部として使う」ことを認めていない。このジョブは「このリポジトリのサイトを組み立てて公開する」ものだが、
データの取得を含むので、どちらに当たるかは解釈しだい。止められたときは、同じジョブ（`npm run cli` を呼ぶだけ）をほかの場所で動かす。
2026-10-27 に日次だけにしたので、取得は1日1回（ジョブも1日1回、数十分）になり、2時間ごとのころより「サイトを組み立てて公開する」ためのジョブに近い。規約の文面は変わっていない（読み直していない）。
出典: https://docs.github.com/en/site-policy/github-terms/github-terms-for-additional-products-and-features

### 6-10. Workers に決めたことで CLAUDE.md・コード・設定で直す箇所（一覧。実装と同じコミットで直す）

2026-10-27 に grep で探した（行番号はその時点。2026-11-04 に CLAUDE.md の細部を docs/ に移したので、「どこ」を節の名前に直した）。**2026-11-13 に塊 F で直した**（下の「状態」）。

| どこ | 今 | 直し方 | 状態 |
| --- | --- | --- | --- |
| CLAUDE.md の技術スタック（もとの 94行） | 「Cloudflare Pages。Actions からの直接アップロード」 | Cloudflare Workers の静的アセット。Actions から `wrangler deploy` | 済（2026-11-13） |
| docs/ui.md の「Phase 3 の UI・SEO の決定」（もとの CLAUDE.md 162行） | 「Cloudflare Pages の無料プランは1サイト20,000ファイルまで」 | Workers の無料プランも1版20,000ファイル（wrangler 4.34.0 以上）。中身はそのまま | 済（2026-11-13） |
| docs/ui.md の「Phase 3 の UI・SEO の決定」・docs/backlog.md の未確定（もとの CLAUDE.md 163行・738行） | 「未決事項（Pages か Workers か・独自ドメイン・生レスポンスの保存期間など）は docs/deploy.md」 | 決定（Workers・workers.dev・30日）を書き、残りの未決だけを指す | 済（ui.md は 2026-11-13。backlog.md は前から） |
| CLAUDE.md のフェーズ（もとの 771行） | 「Phase 4 公開と定期実行（Actions・R2・Pages）」 | Pages → Workers | 済（前から） |
| astro.config.mjs 56行のコメント | 「無くなったページには Pages のスラッシュの付け直しが効かないため」 | Workers の `html_handling` の文書を読んで直した（ファイルがある所だけ付け直す。`_redirects` は常に先に効く）。実際の動きは段6 のプレビューで | 済（コメント。2026-11-13） |
| config/site.yaml 3行 | 仮の URL と「Pages か Workers か・独自ドメインは公開の前に決める」 | 本番の URL（`https://<Worker名>.<サブドメイン>.workers.dev`）。Actions では Variable の `SITE_URL` が優先 | コメントは直した（2026-11-13）。URL はサブドメインと Worker 名が決まってから |

足すもの:

- 404 は `wrangler.jsonc` の `not_found_handling: "404-page"`（3章）。Pages の「自動」に頼っていた所は無い（404.html はビルドが作っている）。済（2026-11-13。dist/404.html が無ければ check-dist が止める）
- 公開の URL は `<Worker名>.<アカウントのサブドメイン>.workers.dev`（6-2）。Worker 名は wrangler.jsonc の `name`（仮に `simulwatch`）
- Search Console の所有権は HTML ファイルか meta タグ（6-8。DNS は使えない）。済（2026-11-13。config/site.yaml の `search_console_verification`）
- CLAUDE.md の 2時間ごと・「これから始まる枠」の記述（2026-10-27 の決定）は、このセッションの範囲外（docs/workflows.md・UI の側で一覧にする。一覧は docs/decisions.md の D-01・docs/phase4-plan.md の塊 A）

## 確かめた事実と出典（2026-10-07）

| 事実 | 出典 |
| --- | --- |
| Pages 無料: 20,000ファイル・1ファイル 25MiB・月500ビルド・`_redirects` 固定2,000＋動的100・`_headers` 100行 | https://developers.cloudflare.com/pages/platform/limits/ |
| wrangler の直接アップロードは 20,000ファイルまで（ドラッグ＆ドロップは1,000）。直接アップロードのプロジェクトは Git 連携に切り替えられない | https://developers.cloudflare.com/pages/get-started/direct-upload/ |
| Actions からのアップロードの手順（トークンの権限・Secrets の名前・ワークフローの例） | https://developers.cloudflare.com/pages/how-to/use-direct-upload-with-continuous-integration/ |
| 「新しいプロジェクトは Workers で」 | https://developers.cloudflare.com/pages/ |
| Workers の静的アセット: 20,000ファイル・25MiB、リクエストは無料・無制限 | https://developers.cloudflare.com/workers/platform/limits/ ・ https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/ |
| 独自ドメイン（Pages）: サブドメインは CNAME だけで可、ルートのドメインは Cloudflare のネームサーバーが必要 | https://developers.cloudflare.com/pages/configuration/custom-domains/ |
| R2 無料枠: 10GB・書き込み系100万回・読み出し系1,000万回・転送は無料 | https://developers.cloudflare.com/r2/pricing/ |
| R2 の API トークン（Object Read & Write をバケット限定で。キーは1回だけ表示） | https://developers.cloudflare.com/r2/api/tokens/ |
| wrangler の R2 へのアップロードは1ファイル 315MB まで | https://developers.cloudflare.com/r2/objects/upload-objects/ |
| R2 のライフサイクルのルール（接頭辞ごとに N 日で削除） | https://developers.cloudflare.com/r2/buckets/object-lifecycles/ |
| R2 を使うにはチェックアウトが要る | https://developers.cloudflare.com/r2/get-started/ |
| Actions: 公開リポジトリは標準のランナーが無料 | https://docs.github.com/en/billing/concepts/product-billing/github-actions |
| Actions の schedule: 最短5分・混雑時に遅れる（毎時0分は混む）・既定のブランチで動く・公開リポジトリは60日動きが無いと止まる | https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows |

確かめていないこと: Cloudflare・GitHub の画面での実際の操作（文書の記述だけ）、wrangler のコマンドの実行、
本番で日次のジョブを動かしたときの生レスポンスの量・ジョブの所要時間。

## 確かめ直した事実と出典（2026-10-23。6-1・6-2・6-4・6-5・6-6 を決めるため）

公式の文書を WebFetch で読んだ。上の 2026-10-07 の表と食い違ったものは無かった（足したものだけ書く）。

| 事実 | 出典 |
| --- | --- |
| Pages の文書の先頭は今も「Start new projects with Workers.」。Pages が終わる・非推奨になるとは書かれていない | https://developers.cloudflare.com/pages/ |
| Pages 無料の上限は 10-07 と同じ。月500ビルドに直接アップロードが数えられるかは今も書かれていない | https://developers.cloudflare.com/pages/platform/limits/ |
| Workers 無料の静的アセット: 1版 20,000ファイル（wrangler 4.34.0 以上）・25MiB・`_headers` 100行（1行2,000文字）・`_redirects` 固定2,000＋動的100（1行1,000文字） | https://developers.cloudflare.com/workers/platform/limits/ |
| Workers の静的アセットへのリクエストは無料・無制限。保存の追加料金なし | https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/ |
| Workers の静的アセットで `_headers` が使える（100行） | https://developers.cloudflare.com/workers/static-assets/headers/ |
| Workers の静的アセットで `_redirects` が使える（固定2,000＋動的100） | https://developers.cloudflare.com/workers/static-assets/redirects/ |
| `not_found_handling: "404-page"` はいちばん近い `404.html` を 404 で返す | https://developers.cloudflare.com/workers/static-assets/routing/static-site-generation/ |
| workers.dev の URL は `<Worker名>.<アカウントのサブドメイン>.workers.dev`。サブドメインはダッシュボードで変えられる。版・プレビューの URL は workers.dev を切っても残る・Cloudflare Access で塞げる | https://developers.cloudflare.com/workers/configuration/routing/workers-dev/ |
| Workers の独自ドメインは Cloudflare のゾーンが要る（6-2 で使わないので関係しない） | https://developers.cloudflare.com/workers/configuration/routing/custom-domains/ |
| Pages の独自ドメイン: サブドメインは外部の DNS の CNAME で可、ルートは Cloudflare のゾーンが要る（10-07 と同じ） | https://developers.cloudflare.com/pages/configuration/custom-domains/ |
| AdSense に足せるサイトは「ドメイン」「Public Suffix List に載っている基盤のサブドメイン」「AdSense の提携の基盤（blogspot など）」。ほかのサブドメインは足せない | https://support.google.com/adsense/answer/12170421?hl=en |
| `pages.dev`・`r2.dev`・`workers.dev` は Public Suffix List の Cloudflare の節に載っている（2026-10-23 に一覧のファイルを検索した） | https://publicsuffix.org/list/public_suffix_list.dat |
| R2 無料枠: Standard の保存 10GB-月・書き込み系100万回・読み出し系1,000万回・転送は無料。超えたぶんは課金（Standard の保存 $0.015/GB-月） | https://developers.cloudflare.com/r2/pricing/ |
| R2 は「checkout の流れで R2 のサブスクリプションを足す」、請求は使用量で月ごと。支払い方法の登録には触れていない | https://developers.cloudflare.com/r2/get-started/ |
| R2 のライフサイクル: 接頭辞と日数で削除、ふつう期限から24時間以内、1バケット1,000ルールまで、wrangler の `r2 bucket lifecycle add/set/list/remove` | https://developers.cloudflare.com/r2/buckets/object-lifecycles/ |
| GitHub の noreply は `ID+ユーザー名@users.noreply.github.com`（2017-07-18 より後に作ったアカウント） | https://docs.github.com/en/account-and-profile/reference/email-addresses-reference |
| コミット用のアドレスを変えても、それより前のコミットは前のアドレスのまま | https://docs.github.com/en/account-and-profile/how-tos/email-preferences/setting-your-commit-email-address |
| （2026-10-27）`cloudflare/wrangler-action` にタグ `v4` がある。最新は v4.1.3（2026-09-24）。v4 は既定で wrangler v4、`wranglerVersion` で固定できる | https://api.github.com/repos/cloudflare/wrangler-action/releases ・ https://github.com/cloudflare/wrangler-action |
| （2026-10-27）Search Console: ドメインのプロパティの確認は DNS だけ。URL プレフィックスのプロパティは HTML ファイル・HTML タグ・Google アナリティクス・タグマネージャーでも確かめられる | https://support.google.com/webmasters/answer/9008080?hl=en |

確かめられなかったこと（2026-10-23〜26）: AdSense の審査に workers.dev で通るか（文書に無い。申し込んでみるまで分からない）、
R2 の登録に支払い方法が要るか（公式に無い）、R2 の使用量の通知の設定の場所、Workers へのデプロイのトークンに要る最小の権限、
Workers のプレビュー（版の URL）の出し方（2026-10-27 に文書で確かめた。docs/workflows.md 2-8）、本番で日次のジョブを動かしたときの生レスポンスの量。
