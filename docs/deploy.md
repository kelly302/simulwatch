# Web サイトへのアップロード（公開）の手順

2026-10-07 の下書き（2026-10-19 に、巡回の間隔（2時間ごと。2026-10-11 決定）と Phase 3 の初めの決定 D に合わせて直した）。**まだ作っていないもの（Phase 3 の UI・Phase 4 のワークフロー）を含む。**
CLAUDE.md の決定（Cloudflare Pages へ Actions から直接アップロード、DB と生レスポンスは R2 の非公開領域、定期実行は GitHub Actions）と、
公式の文書で確かめた事実（末尾の表）から組んだ。決まっていないことは「6. 決めること・確かめること」に分けた。

## 今の状態

| もの | 状態 |
| --- | --- |
| 取得・名寄せのジョブ（CLI） | ある（ローカルで実行している） |
| サイトのビルド（集計・Astro。出力は `dist/`） | ある（2026-10-19。`npm run cli -- site:data` → `npm run site:build`。2026-10-26 に3,807ファイル・約97MB（og:image の PNG・HTML が大半）。og:image のキャッシュが無いと約3分） |
| ワークフロー（`.github/workflows/`） | 無い（Phase 4） |
| GitHub のリポジトリ | 無い（git の remote が未設定。予定は `kelly302/simulwatch`） |
| Cloudflare（Pages・R2） | 未設定 |

いまアップロードできるものはまだ無い。下の「1. 最初に1回だけやること」は Phase 3 の実装と並行して進められる。

## 全体の流れ

    GitHub Actions（2時間ごと・日次の schedule）
      1. R2 から DB（SQLite）を取得
      2. ジョブ（巡回・名寄せ・再生数の取り直し）
      3. DB と生レスポンスを R2 に書き戻す
      4. 集計（site:data）→ Astro でビルド（site:build。dist/）
      5. wrangler で dist/ を Cloudflare Pages に直接アップロード
                                   ↓
                     https://<プロジェクト名>.pages.dev（または独自ドメイン）

「アップロード」は 5 の1コマンド。人が毎回やる作業は無い（手でやる方法は「4.」）。

## 1. 最初に1回だけやること（ユーザーの手作業）

アカウントの作成とキー・トークンの発行・入力は、Claude は代わりにできない。

### A. GitHub

1. 公開リポジトリ `kelly302/simulwatch` を作る（`config/crawl.yaml` の User-Agent にこの URL を書いている）
2. ローカルから push する
3. 公開の前の確認（2026-10-07 に確認済み）
   - `.env` は一度もコミットされていない。`.env` の2つの値は、履歴のどのコミットにも追跡中のどのファイルにも無い
   - `data/`（DB・生レスポンス・メン限枠の概要欄を含む判定のファイル）は追跡していない（2026-10-19 に確かめ直した。追跡中は77ファイルで、data/ の下は0）
   - **46コミット（2026-10-19）すべての作者のメールアドレスが個人の Gmail**。公開すると誰でも見られる（→ 6-6）

### B. Cloudflare

1. アカウントを作る
2. R2 を有効にする: ダッシュボード → Storage & databases → R2 → Overview → チェックアウトを済ませる（→ 6-5）
3. バケットを1つ作る（例 `simulwatch-data`）。公開アクセス（r2.dev・独自ドメイン）は有効にしない
4. R2 の API トークンを作る: R2 → API Tokens の Manage → 権限は **Object Read & Write**、対象は 3 のバケットだけ。
   **Access Key ID と Secret Access Key は作った直後の1回しか表示されない**
5. Pages のプロジェクトを作る（直接アップロード用）。ローカルで

       npx wrangler login
       npx wrangler pages project create <プロジェクト名> --production-branch main

   直接アップロードで作ったプロジェクトは、あとで Git 連携に切り替えられない（切り替える予定は無い）
6. デプロイ用の API トークンを作る: API Tokens → Create Token → Custom Token → 権限は **Account / Cloudflare Pages / Edit**
7. アカウント ID を控える

### C. GitHub の Secrets に入れる

リポジトリの Settings → Secrets and variables → Actions → New repository secret。

| 名前 | 中身 | 使うところ |
| --- | --- | --- |
| `YOUTUBE_API_KEY` | ローカルの `.env` と同じ | 巡回 |
| `ANNICT_TOKEN` | ローカルの `.env` と同じ | 名寄せ |
| `CLOUDFLARE_ACCOUNT_ID` | B-7 | wrangler・R2 の接続先 |
| `CLOUDFLARE_API_TOKEN` | B-6 | Pages へのアップロード |
| `R2_ACCESS_KEY_ID` | B-4 | DB・生レスポンスの出し入れ |
| `R2_SECRET_ACCESS_KEY` | B-4 | 同上 |

上の2つは今の `.env` と同じ名前。下の4つの名前はワークフローを書くときに確定する（Cloudflare の2つは公式の例の名前）。

### D. 最初の DB を R2 に置く

ローカルの `data/db.sqlite`（2026-10-19 に 338MB。ルールと AI の判定が入っている最新）が本番の最初の DB になる。置いたあとは **R2 の DB が正**で、ローカルは写し（→ 6-7）。

- wrangler の `r2 object put` は1ファイル 315MB まで。**DB はそのままでは上限を超えている**（2026-10-19 に 338MB）
- gzip すると 58MB（2026-10-07 に計測。そのときは 319MB）。**R2 には gzip した DB を置く**案（2時間ごとの出し入れも速くなる）。コマンドは R2 の出し入れを実装するときに確定する

## 2. Claude が作るもの（Phase 3〜4）

| もの | 中身 |
| --- | --- |
| サイトのビルド | 集計 → 画面ごとの JSON と HTML → `dist/`。`_headers`（JSON に `X-Robots-Tag: noindex`）・`_redirects`（作品の URL が変わったときの 301）・404 ページ |
| 2時間ごとのワークフロー | DB を取得 → `crawl:hourly` → `resolve` → `site:data` → DB を書き戻す → ビルド → アップロード |
| 日次のワークフロー | DB を取得 → `roster` → `crawl:daily` → `refresh` → `resolve` → `site:data` → DB を書き戻す → ビルド → アップロード |
| keepalive のワークフロー | 月1回の軽いコミット（schedule が60日で止まるのを防ぐ） |
| 手動のワークフロー | ボタンで「ビルドとアップロードだけ」を実行する（`workflow_dispatch`） |

守ること（CLAUDE.md のルールから）:

- DB を書くワークフローは同時に1つだけ（Actions の `concurrency`）
- **R2 から DB を取れなかったら、そこで止める**。空の DB で始めて書き戻さない（既存データを消さない）
- ジョブの途中のステップが失敗しても、DB の書き戻しは必ず行う
- ビルドが失敗したらアップロードしない（前の版がそのまま公開され続ける）
- アップロードの前に `dist/` のファイル数を数え、上限（20,000）に近づいたら止めて知らせる（2026-10-19 に約3,800）
- `site:data` は作品の公開キーと lastmod の表を DB に書くので、DB の書き戻しより前に動かす
- `site:data` は最初に前回の `site-data.json` を消す。書き出しに失敗するとビルドがファイル無しで失敗し、アップロードしない（前の版が公開され続ける）。
  `data/site/` をキャッシュに入れても、古いデータを公開しない
- og:image のキャッシュ（`data/site/og-cache/`）を残す（Actions のキャッシュか R2。無いと毎回約3分のびる）。ビルドが使わなかった画像は消すので、枚数は作品・配信者のページの数＋1
- schedule は正時（0分）を避ける（混雑で遅れる。公式の注意）

## 3. 毎回のアップロード（自動）

ワークフローの最後の2ステップ。Cloudflare の公式の例と同じ形。

    - uses: cloudflare/wrangler-action@v4
      with:
        apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
        accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
        command: pages deploy dist --project-name=<プロジェクト名> --branch=main

`--branch=main`（本番のブランチ）なら本番、ほかの名前ならプレビュー（`<名前>.<プロジェクト名>.pages.dev`）になる。

## 4. 手でアップロードする（ローカルから）

ワークフローが止まっているとき・公開の前に見た目を確かめるとき用。

    npx wrangler login
    npm run cli -- site:data && npm run site:build                       # dist/ を作る
    npx wrangler pages deploy dist --project-name=<プロジェクト名> --branch=preview   # まずプレビューへ
    npx wrangler pages deploy dist --project-name=<プロジェクト名> --branch=main      # 本番へ

プレビューの URL も、URL を知っていれば誰でも見られる。

## 5. アップロードのあとに確かめること

| 何を | どうやって |
| --- | --- |
| 5つの画面が開く | 本番の URL をブラウザで（スマホの幅でも） |
| 無いページが 404 になる | 枠が0の作品の URL など |
| 公開キーが変わった作品の旧 URL が 301 になる | `curl -I` で末尾スラッシュあり・なしの両方（`_redirects` に両方の形を書いている。Pages の上での効き方は未確認） |
| JSON に `X-Robots-Tag: noindex` が付いている | `curl -I <JSON の URL>` |
| ジョブが2時間ごとに動いている | GitHub の Actions の履歴、DB の `runs` |
| YouTube のクォータ | `report:quota`（1日 10,000 のうち 9,000 で止まる設定） |
| R2 の使用量 | Cloudflare のダッシュボード（→ 6-4） |
| Pages の「ビルド回数」が増えていないか | Cloudflare のダッシュボード（→ 6-3） |

## 6. 決めること・確かめること

### 6-1. Pages のままか、Workers にするか（決めること）

6-1・6-2・6-6 は公開の前（Phase 4 の最初のアップロードの前）に決める（2026-10-19 の決定 D）。Phase 3 のビルドは仮のサイトの URL を設定に置いて進める。

Cloudflare の Pages の文書の先頭に「新しいプロジェクトは Workers で始めること」と書かれている（Pages が終わるとは書かれていない）。
Workers の静的アセットでも、同じ `dist/` をそのまま出せる。

| | Pages（今の決定） | Workers の静的アセット |
| --- | --- | --- |
| ファイル数・1ファイルの大きさ（無料） | 20,000・25MiB | 同じ |
| `_headers`・`_redirects` | 100行・固定2,000＋動的100 | 同じ |
| 静的ファイルへのリクエスト | 無料 | 無料・無制限（公式に明記） |
| アップロード | `wrangler pages deploy dist` | `wrangler deploy`（設定ファイルに `assets.directory`） |
| 404 ページ | 自動 | 設定で指定（`not_found_handling`） |
| 独自ドメイン | サブドメインなら外部の DNS の CNAME でも可 | Cloudflare のネームサーバーに置いたドメインだけ |

Claude の意見: 新しく作るので Workers にする。違いはアップロードのコマンドと設定ファイル1つで、あとから移る手間が無くなる。
独自ドメインを Cloudflare 以外の DNS に置いたまま使いたいなら Pages。どちらでも 1〜5 の流れは同じ。

### 6-2. 独自ドメインを使うか（決めること）

使わなければ `<プロジェクト名>.pages.dev`。広告を載せる計画なので、**広告の審査が pages.dev のサブドメインで通るかは未確認**。
公開後に URL を変えると検索の評価を引き継ぐ手間が出るので、公開の前に決めたい。

### 6-3. アップロードの回数（確かめること）

2時間ごとのアップロードと日次のアップロードで月に約390回（毎時のころは約750回）。Pages の無料の「月500ビルド」に数えられるかは、**公式の文書に書かれていない**
（制限のページは「Git に push するたびにビルドする」としか書いていない。直接アップロードのページにも記載なし）。
Cloudflare のコミュニティの回答は「直接アップロードは数えない」だが、スレッド本体は開けず（403）、検索結果の要約でしか読めていない。
→ 最初の数回のアップロードのあとにダッシュボードの数字で確かめる。数えられても500回には収まるが、手でのアップロードや失敗のやり直しで近づくので、「中身が変わったときだけアップロードする」にする。

### 6-4. 生レスポンスを R2 に何日残すか（決めること）

R2 の無料枠は保存 10GB。DB は 0.06GB（gzip）〜0.3GB。生レスポンスは消さなければ増え続ける。

- ローカルの実績: 1日 7MB〜121MB（多い日は `resolve --all` のやり直しを含む）。**2時間ごとに動かしたときの量は未計測**
- 1日 40MB なら約8か月、120MB なら約80日で 10GB に届く
- R2 のライフサイクルのルールで「`raw/` を N 日で消す」ができる（消えるのは期限から24時間以内）

Claude の意見: 30日（デバッグ用なので。resolve_cache の30日とそろう）。

### 6-5. R2 の登録（確かめること・決めること）

- R2 を使うにはチェックアウト（サブスクリプションの追加）が要る（公式）。**支払い方法の登録が要る**というのは公式のページからは読み取れず、複数の解説記事による。画面で確かめる
- 無料枠を超えたぶんは従量で課金される（止まるのではない）。「無料枠のみで完結」は、6-4 の保存期間と使用量の通知で守る
- 操作の回数は余裕がある（2時間ごとの DB の出し入れで月に数千回。無料枠は書き込み系100万回・読み出し系1,000万回）

### 6-6. コミットの作者のメールアドレス（決めること）

今の46コミット（2026-10-19）は個人の Gmail で記録されている。公開したくなければ、**最初の push の前**に GitHub の noreply のアドレスへ書き換える
（push のあとの書き換えは意味が薄い）。そのままでよければ何もしない。

### 6-7. 公開後のローカルの作業（CLAUDE.md の未確定のまま）

公開後は R2 の DB が正で、2時間ごとのジョブが書く。ローカルで行う AI の判定（`ai:apply`）・ルールを直したあとの `resolve --all` を
本番の DB にどう入れるかは未決（CLAUDE.md「未確定」の「AI の判定の公開後の運用」）。

### 6-8. 最初の公開の段取り（提案）

プレビューにアップロード → ユーザーが確認 → 本番にアップロード → schedule を有効にする、の順。

### 6-9. GitHub Actions の規約（知っておくこと。2026-10-08 に確認）

GitHub の規約は、GitHub のランナーを「そのリポジトリのソフトウェアの制作・テスト・デプロイ・公開に関係のない活動」に使うことと、
「CDN やサーバーレスのアプリの一部として使う」ことを認めていない。このジョブは「このリポジトリのサイトを組み立てて公開する」ものだが、
2時間ごとのデータの取得を含むので、どちらに当たるかは解釈しだい。止められたときは、同じジョブ（`npm run cli` を呼ぶだけ）をほかの場所で動かす。
出典: https://docs.github.com/en/site-policy/github-terms/github-terms-for-additional-products-and-features

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
2時間ごとに動かしたときの生レスポンスの量・ジョブの所要時間。
