# Phase 4 の実装の段取り

2026-10-30 にユーザーが決めた段取り（D-05）を、2本のレビュー（2026-10-30。Opus の段取りのレビューと文書の点検）の指摘と一緒にまとめた（2026-11-04）。
**レビューの指摘は、どの塊で直すか・済んだか・やらないかを全部ここに書く**（黙って落とさない）。仕様は docs/workflows.md・docs/ai-ops.md・docs/deploy.md、決定は docs/decisions.md。

## 段

| 段 | 中身 | 状態 |
| --- | --- | --- |
| 0 | 本体の DB を写してから crawl:daily と refresh（巡回は 10-11 から止まっていた） | 済（2026-10-30。写しは data/db.before-crawl-1030.sqlite。新しい枠91。名寄せは 11-04 に流し直し） |
| 0 | 履歴の作者を noreply に書き換え（`git bundle --all` で退避 → UI の作業ツリーを消す → filter-repo（できれば新しいクローンで）→ `user.email` を noreply） | 済（2026-11-04。記録と古い ID の対応表は docs/ai-runs.md の 2026-11-04 の節） |
| 1 | A・B・D1・D2・G（並行） | A・B・D1・D2 は済（2026-11-08。11-11 に main へマージ）。G はユーザーの手作業で、途中 |
| 2 | C・D3a（並行） | 済（2026-11-13。C を先にマージし、D3a は ai.ts に触らない前半のあと C を取り込んで後半を足した。どちらも main にマージ済み） |
| 3 | D3b（D2 の採点のあと） | 済（2026-11-13。試し直し cand-retrial-1113 でサイトに出る誤り 0/73・取りこぼし 0/56。記録は docs/ai-runs.md。同日 main にマージ） |
| 4 | F（早めに push して手で起動して試す） | 作った（2026-11-13。ローカルで1周と失敗の試しまで。同日 main にマージ）。GitHub での起動は G と push のあと |
| 5 | DB の写しでローカルのフォルダを1周 → 本体の写しを取る → 本体に過去の候補と判定待ちの枠を `ai:ingest` で入れる | |
| 6 | もう一度 refresh → R2 に置いて往復で確かめ、ローカルの DB を止める → プレビューをユーザーが確認 → 本番 → 日次を手で1回 → Search Console → SCHEDULE_ENABLED | |
| 公開のあと | E（Claude Code のワークフロー）→ 手で数回 → 予定タスクに移すか決める | |

## 塊ごとの中身と「済んだ」の基準

各塊は別のセッション・別の作業ツリーで進め、親が順にマージする。作業ツリーでは `npm ci`、DB は本体から `VACUUM INTO` で写す（cp しない。置き忘れると空の DB ができる）、
og-cache は写して使う（本体の OG_CACHE を共有しない。ビルドが使わなかった画像を消すため）、.env は本体から写す（無いと lookup が Annict を引かない）。マージのあと写しの DB を使い回さない。
`src/cli.ts`（JOBS・HELP）と docs/dev.md は B・C・D が同じ所に足すので、マージの衝突は親が解く。**DB のマイグレーションは D3a だけが持つ**（db.ts は配列の位置が番号）。

### A 日次だけにする（D-01）

- トップの「これから始まる枠」・LIVE バッジを外す（site/pages/index.astro・site/lib/data.ts・encode.ts・views.ts）
- 予定枠を site-data から外す（src/publish/snapshot.ts。config/site.yaml の切り替えで戻せる形）。usedStreamers・usedWorkIds にも数えない
- publishState の eventStatus の分岐を外す（src/resolve/route.ts）。待ち行列は終わった枠だけ（src/report/ai.ts）
- コメントの古い記述: src/cli.ts（crawl:hourly の「毎時」）・src/crawl/jobs.ts・refresh.ts・sources.ts（「毎時」）・config/crawl.yaml（2時間ごとの理由）・config/detect.yaml（弱い語の理由）・config/site.yaml（決定 A）・src/publish/snapshot.ts（決定 A）
- 本文: D-01 の「印を付けた本文」を直して印を消す。test/publish.test.ts・site.test.ts
- 済んだの基準: npm test・typecheck、DB の写しで site:data と site:build、site-data の events が終わった枠だけ、dist/ に「LIVE」「これから」が無い、
  スマホとデスクトップの幅のプレビュー、ai:status の前後の差を報告に添える

### B ジョブの基盤

- db:check・db:pack（メタデータは1つのオブジェクトに。失敗で終了コード 1。CLAUDE.md の「終了コードは 0」の例外として docs/dev.md に書く）・site:fingerprint・job:due・runs:summary
- クォータの AI の取り分（`quota.ai_reserve: 600`。ジョブは 8,400 で止める）
- resolve の対象の並び（未処理を先・照会エラーを後。`ORDER BY (u.reason = 'error'), e.id`）。テストに未処理・エラー・処理済みの3種
- **ログの URL のクエリを伏せる**（src/lib/http.ts の HttpError は URL を丸ごと持ち、runStep が runs と log に出す。Wikipedia の検索の語にメン限の概要欄の断片が入りうる）
- 済んだの基準: db:check・db:pack を小さな DB で（ファイル無し・壊れ・sha の不一致・user_version が上・行の減少で、どれも終了コード 1）、写しで pack → 展開 → check の往復（-wal が空）、
  同じ DB で site:data を2回流して指紋が同じ、ログのクエリが伏せてある
- 状態: 実装済み（2026-11-08。ブランチ claude/p4-b-jobbase-1e1cdc。メタデータの形は docs/workflows.md 2-3）

### C AI の答えの取り込み（D-03・D-09）

- aiApply: 古い答えは取り込まない（時刻は瞬間で比べる。`Z` と `+09:00` の混ざり。入れるときも UTC にそろえる）・問題を種類で分ける（batch・model・finished_at が無いファイルは failed）
- ai:ingest（どの batch を取り、どこへ移すかを CLI が決めて出力する。受け箱をローカルのフォルダと aws で切り替えられる薄い層を ai:pull・ai:push と共用）・ai:check・ai:pull・ai:push・.env.example
- ai:queue: ローカルのクォータのファイルと取り分 600 で止める・同じシードの2回目は同じバッチを使い答えのそろったファイルを飛ばす・`--max-files`・返す値（docs/ai-ops.md 4-1・4-2・5）
- 候補の答えは D3a まで「枠が無い」として扱う（テストにそう書く）
- 済んだの基準: 6-3 の各区分を小さなファイルで、時刻の混在、同じ受け箱を2回取り込んで判定の集合が変わらない、途中で殺した回、ai:check が finished_at の無いファイルを弾く、ai:pull・ai:push をローカルのフォルダで
- 状態: 実装済み（2026-11-13。ブランチ claude/p4-c-ingest-f7ce33。test/ai-ingest.test.ts と、DB の写しでの確かめは docs/ai-runs.md の 2026-11-13 の節）。
  aws の側は組み立てるコマンドのテストまで（実際の往復は段6）。D3a が使う所: `answerFreshness`（候補の not_watchalong の答えの時刻の比べ）・`readAnswerFile` の `noEvent`（候補の答えを「枠が無い」にしている所）

### D 続きの回の候補（D-04）

- D1 選定と件数: **巡回の前の写し（data/db.before-crawl-1030.sqlite）で**数え、10-23 の手作業の 205本と動画の ID の単位で突き合わせる（差の一覧も）。見出しの区間を除く決まり（neighbors.ts・config/extract.yaml）。
  過去のバッチの1つで、判定役に見せる手がかりの数が前後でどう変わったかも見る。候補の videos.list の見積もり（docs/workflows.md 7章の 689本・初回14ユニット）を件数に合わせて直す
  （済。2026-11-08。201本・初回5ユニット。docs/ai-runs.md の 2026-11-08 の節）
- D2 判定役の試し: 抜き取りは data/review/candidates-1023/sample-cand-1023.json（110本）。**正解を判定役より先に付ける**（docs/ai-runs.md の 10-23 の節の決まり）。
  待ち行列は別のバッチのフォルダに作り、PROMPT で docs/・data/review/ を開かせない（試しの時点ではフックが無い）。.env を写す。
  見るのは「同時視聴でない動画を同時視聴と答えた件数」とその95%上限、層ごとの当たりの割合
- D3a（C のマージのあと、D2 と並行）: candidates の表のマイグレーション（詳細の列と答えの時刻まで最初に決める。行を消さない表として db:pack に入れる）・candidates:select の保存と candidates:fetch（job は daily）・
  ai:queue が候補を表から読み種の枠も見せる・ingest.ts と reports.ts で `ai_candidate` の枠を語彙で外さない・ai:revoke で AI が足した枠を外す（`ai_revoked`）・aiApply で枠を作ってから判定を入れる（is_members_only は candidates の値）
- D3b（D2 の採点のあと）: 層・続きの語・弱い語の設定と GUIDE の文面（弱い語は 2026-11-13 に「入れる」と決まった。D-04）。GUIDE の「そもそも作品を観ていない枠は not_a_work」と not_watchalong の重なりをここで整理する
  状態: 実装済み・main にマージ済み（2026-11-13。ブランチ claude/p4-d3b-guide-098632）。弱い語の層・GUIDE の not_watchalong の節・採点の not_watchalong・待ち行列の配信の長さとメン限の行（2026-11-13 ユーザー決定）。足した2行の効果は段5の本番の判定で見る
- 済んだの基準: DB の写しで select → fetch → queue → 用意した答え → ingest を通し、`ai_candidate` の枠ができる・is_members_only が正しい・detect:rerun で外れない・ai:revoke で外れる・publishState

### E Claude Code のワークフロー（公開のあと。D-05）

- 判定役のエージェントの型で CLAUDE.md を読ませない（omitClaudeMd を試して GUIDE だけで足りるか確かめる）
- フックは最初の行で判定役以外をすぐ通す（全セッションを止めない）。捨ててよいセッションで試す。settings とフックは単独のコミット
- 済んだの基準: 1ファイルで1回回して許可の確認の回数を数える、禁じた読み方をわざとさせてフックが止める・親のセッションは止まらない

### F Actions と Workers

- daily.yml・手動・keepalive・wrangler.jsonc。プレビューは `versions upload --preview-alias`
- 試しの R2 の置き場所（先頭に付ける変数。例 `test/`）と、日次の入力（アップロード先を preview に）。本物の DB を置く前に写しで日次を1周できるように
- Search Console の所有権の確認の HTML ファイルか meta タグ（本番より前）。og-cache は Actions のキャッシュ（docs/workflows.md 2-5）
- keepalive は SCHEDULE_ENABLED を見ないので、公開前に動くとリモートの main が進む（push の前に pull）
- 済んだの基準: CLI のステップを並べたシェルを写しでローカルに通す、GitHub で preview への手動起動、失敗をわざと起こす（メタデータの不一致で止まる・行の減少で書き戻さない）
- 状態: 実装済み・main にマージ済み（2026-11-13。ブランチ claude/p4-f-actions-edf6ab）。ローカルの1周と失敗の試し・actionlint・wrangler の dry-run は済（docs/workflows.md 13-3）。
  **GitHub での preview への手動起動は残り**（リポジトリ・Secrets（G）と push のあと。手順は docs/workflows.md 13-4）

### R YouTube の30日の決まり（D-12。2026-11-13 ユーザー決定）

- videos_seen の題名の取り直し（日次の retention）・候補の詳細の取り直しと消去・巡回を止めた配信者のチャンネルの取り直し・アーカイブが消えた枠の中身の消去・手元のファイルの一覧（retention:files）
- 済んだの基準: 写しの DB で1周（API は 50ユニット以内）、テストと型チェック、文書、本体の data/ の一覧（読むだけ）
- 状態: 実装済み（2026-11-13。ブランチ claude/p4-r-retention-af0224。写しでの確かめは docs/ai-runs.md の 2026-11-13（塊 R）の節。39ユニット）。
  残り: 本体の DB の枠の取り直し（11-28 までに refresh。段6）・手元のファイルのどれを消すか（ユーザー）・R2 の raw/ の日数（G）

### G ユーザーの手作業

- GitHub のリポジトリと noreply、Cloudflare のアカウント・R2・トークン、Secrets と Variables、ローカルに AWS CLI
- YouTube の規約の読み直し（docs/workflows.md 7章）、R2 のトークンをバケットの中の場所まで絞れないことの確かめ（docs/ai-ops.md 2-1）

### 段6 で確かめること

- R2 に置く前に `db.before-r2.sqlite` に写して integrity_check、db:pack でメタデータ。put（メタデータ付き）→ head-object → get → sha256 → db:check の往復（AWS CLI のチェックサムの設定の確かめも兼ねる）。
  S3 のメタデータは ASCII の名前と値で合計 2KB まで
- 置いたあと、ローカルの data/db.sqlite は名前を変えるか読み取り専用にする（ローカルの ai:apply・resolve --all で黙ってずれないように）
- プレビューで Workers の末尾スラッシュ（html_handling。astro.config.mjs のコメント）・301・404・noindex を確かめる
- 最初の日次を無人の schedule で初めて動かさない（手で1回起動して見届けてから SCHEDULE_ENABLED）
- ai:ingest で5 batch の所要時間を測る（batch ごとに外部の照会を回す）

## レビューの指摘で、塊に入れずに片づけたもの・やらないもの

| 指摘 | 扱い |
| --- | --- |
| CLAUDE.md が workflows.md・ai-ops.md を指していない／文書の順位が無い／UI の側の直す箇所の一覧が無い | 済（7b49cc7） |
| CLAUDE.md が長すぎる（821行） | 済（55b5390。215行に） |
| 古い記述が印なく残る | 済（決定の記録 docs/decisions.md と、本文の印。この節を書いたコミット） |
| CLAUDE.md の中の事実の食い違い（5画面と6画面・ランキングの枠数・3ブロックと4ブロック・「固定の転送は2,000件」・置き換わった色の記述） | 済（同じコミット。コードで確かめて直した） |
| GUIDE の過去の答えの例・モノノ怪の例の食い違い・周年の「本編」・ホロぐらの書き方 | D2 の前に直す（親セッション） |
| docs/deploy.md の小さい食い違い（プレビューの確認済み・バックアップの決定・節の参照・PAGES_PROJECT・3,803） | 済（同じコミット） |
| docs/ai-runs.md の 10-21・10-23 の節が「2026-10-09 までの記録」の見出しの下にある | 済（同じコミット） |
| 履歴の書き換えのあと、文書の中のコミットの ID が別のものを指す | 済（2026-11-04。文書の7つの ID を新しい ID に置き換え、対応表を docs/ai-runs.md に残した） |
| 公開前のローカルのビルドで書いた work_public_keys・`_redirects` の16行 | やらない（害が無い） |
