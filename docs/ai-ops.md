# 公開後の AI の判定の運用と、続きの回の候補（仕様の下書き）

2026-10-22 の下書き。2026-10-26 に「7. 決めたこと」の5点をユーザーが決めた。2026-10-27 のユーザーの決定（日次だけ・予定枠を出さない）と Fable のレビューの指摘を反映し、
2026-10-30 にローカルの R2 の道具をユーザーが決めた。**取り込む側と道具（2・2-1・4-1・4-2 の ai:queue・5）は 2026-11-13 に作った（塊 C。src/report/ai.ts・src/report/inbox.ts）。ほかはまだ実装していない**（候補の 3-2〜3-4 は塊 D3a、ワークフロー・フックの 4 は塊 E、ジョブから呼ぶのは塊 F）。
ユーザーの決定（2026-10-22）: この運用は**公開の前に**作る。範囲には、題名に同時視聴の語が無い続きの回を枠にする仕組み（候補 → AI）も含める。
決まったことは、CLAUDE.md とコードを実装と同じコミットで直す（直す箇所の一覧は「8. 実装のときに直すところ」。CLAUDE.md には回の結果・例を書かない）。

関係する記録: docs/ai-runs.md の「2026-10-19 題名に同時視聴の語が無い同時視聴（続きの回）の計測」（候補の層と当たりの割合・作り替えの注意点）・
「2026-10-21 「【最終回】」の続きの回の計測」・「2026-10-23 続きの回の候補（docs/ai-ops.md 3-1 の4層）の件数」、docs/deploy.md の 6-7、docs/workflows.md の 2-2・6・7。

**2026-10-27 のユーザーの決定（この文書の前提が変わったところ）**: トップの「これから始まる枠」（予定枠・配信中・LIVE バッジ）をやめ、巡回は**日次だけ**にする（予定枠のデータは DB に取り続け、戻せる形にしておく。
docs/workflows.md の付録）。そのため「**予定枠・配信中の枠は AI の判定を待たずに出す**」（2026-10-11 の決定・publishState の eventStatus）は無くなる。
終わった枠も予定枠も、AI に回す型の枠は判定するまで出ない。

## 1. 何が変わるか

| | 今 | 公開後 |
| --- | --- | --- |
| 正の DB | ローカルの data/db.sqlite | R2（日次のジョブと手動のジョブが書く。docs/workflows.md） |
| 判定の待ち行列 | ローカルの DB から `ai:queue` | R2 の DB の写しから `ai:queue`（読むだけ） |
| 判定の取り込み | ローカルで `ai:apply` | 答えのファイルを R2 の受け箱に置き、**日次のジョブが取り込む**（`ai:ingest`） |
| 判定するもの | 枠（watch_events）だけ | 枠 ＋ **候補**（同時視聴の語が無いが、続きの回かもしれない動画） |
| 回し方 | Claude Code の会話で私が手で回す | Claude Code の保存したワークフローで、決まった手順を回す |
| YouTube のクォータ | ローカルの DB の quota_usage に記録 | ローカルの消費は R2 の DB に戻らないので、AI の取り分（1日 600）をローカルのファイルで数える（5章） |

「判定は人が起動するコマンドでだけ入る。定期実行のジョブからは入れない」（src/resolve/ai.ts・src/report/ai.ts・src/cli.ts の HELP）は、
「**判定は人が起動した Claude Code の回でだけ作る。ジョブは作られた答えのファイルを取り込むだけ**」に読み替える（決定 1。2026-10-26）。
ジョブから Claude（有料 API）は呼ばない。

## 2. 全体の流れ

    ローカル（人が起動。Claude Code のワークフロー）              R2（非公開）                 GitHub Actions（日次）
    ─────────────────────────────────────────────          ───────────────              ──────────────────
    1. ai:pull     R2 の DB の写しを落とす（読むだけ）   ←  db/db.sqlite.gz
    2. ai:queue    枠と候補の待ち行列を作る（候補を見せない）
    3. 判定役      1ファイル50件・5本並行
    4. ai:check    答えの形・照会の記録・finished_at・割れの確認
    5. ai:report   確度 high 以外の表（人の採点は取り込みのあと。決定 3）
    6. ai:push     答えを受け箱に置く                    →  ai/inbox/<batch>/*.json
                                                                                      →  日次のジョブの resolve の前に
                                                                                         ai:ingest → DB の書き戻しが
                                                            ai/applied/<batch>/       ←  成功したら受け箱から移す
                                                            ai/results/<batch>/       ←  取り込みの結果（件数・飛ばした枠・古い答え）
    7. 次の回で、反映されたか（ai:status と ai/results/）を確かめる。採点で見つけた誤りは fix-*.json にして 6 から

- **ジョブの側（`ai:ingest`・受け箱からの移し方・やり直しと failed・1回の量）と、ローカルとジョブの約束事は docs/workflows.md の 6 が正**。ここはローカルの側だけを書く。
  答えは日次のジョブで入るので、ai:push から反映まで最大1日かかる
- 写しは古くなるが困らない。答えは動画の ID（video_id）で結びつき、ルールの答え・型には依存しない。
  取り込むときに枠が無くなっていた（判定から外れた・アーカイブが消えた）ら飛ばして記録する
- **古い答えで新しい答えを上書きしない**（Fable の高-1。docs/workflows.md 6-2。2026-11-13 実装）。前の `aiApply` は答えの時刻を見ずに入れ直していたので、「同じファイルを2回入れても同じ」は、
  あいだにほかの答え（採点のあとの fix）が入らないときしか成り立たなかった。決め方は、`ai:ingest` が**その枠にすでにある取り消されていない判定の `decided_at` が
  今の答えの時刻（答えのファイルの `finished_at`）より新しければ飛ばし、「古い答え」と記録する**（同じ時刻なら「入れ済み」）。ローカルの側の約束:
  - **答えのファイルには `finished_at` を必ず書く**（`decided_at` はここから入る）。`ai:check` が確かめ、無いファイルは ai:push しない（ジョブは failed にする）
  - **直しの答えのファイルの名前は `fix-` で始める**（batch の中は名前の順に入るので、`01.json`〜 の後ろに並ぶ）。直しの `finished_at` は直したときの時刻にする
  - 採点で見つけた誤りは、新しい batch の `fix-*.json` として置く（古い batch が受け箱に残っていても、時刻で古い答えは飛ぶ）
  - この決まりは `aiApply` の中に入れ、`ai:ingest` とローカルの `ai:apply` で共通にする（D-09。2026-11-13 実装。時刻は文字列でなく瞬間で比べ、入れるときは UTC にする。公開の前のローカルの試しでも同じ動きになる）。
    公開後はローカルの DB が写しなので、ローカルの `ai:apply` で直しても本番には入らない（直しは必ず受け箱へ）
- 取り込みはジョブ（DB を書く concurrency の組）の中で動く。ローカルから R2 の DB を書くことはしない
- R2 を設定するまで（Phase 4 の前）は、「R2」をローカルのフォルダ（例 data/remote/）に置き換えて同じ手順を試す。ジョブの取り込みも `npm run cli -- ai:ingest` で手で流して確かめる
  （実装: どのコマンドも `--remote <フォルダ>` でローカルのフォルダ、`--remote r2`（既定）で AWS CLI の R2。フォルダではキーをそのままパスにし、オブジェクトのメタデータは `<キー>.meta.json` に置く）

### 2-1. ローカルの R2 の道具（2026-10-30 ユーザー決定）

- **AWS CLI をローカルにも入れる**（`winget install Amazon.AWSCLI`。Actions と同じ道具。S3 の SDK は依存に足さない。docs/workflows.md 2-2）
- `ai:pull`・`ai:push` は CLI のコマンドにし、中から `aws` を子プロセスで呼ぶ（`ai:pull` = `aws s3 cp` で db/db.sqlite.gz を落として展開、`ai:push` = 答えのフォルダを `ai/inbox/<batch>/` に `aws s3 cp`）。
  実装（2026-11-13）: `ai:pull` は head-object のメタデータで `db:check` と同じ検査（sha256・integrity_check・user_version・行数）をしてから `--db`（既定 data/db.sqlite）に置き、隣に `<db>.pulled.json` を書く。
  **`.pulled.json` の無い DB は上書きしない**（公開の前の正の DB を写しで消さない。段6 で正の DB の名前を変えてから使う）。
  `ai:push` は `answers/*.json` と batch の直下の `fix-*.json` を `ai:check` に通し、1つでも通らなければ何も置かない（`--skip-failed` で通ったものだけ）
  ローカルは一覧（`aws s3 ls`）を使わない。CLI にしておくと、許可の規則が `npm run cli -- ai:push *` で済み、`aws` そのものを許可しなくてよい（4-3）
- 書く先は `ai/inbox/` だけ（コードで決める）。**R2 の API トークンはバケットまでしか絞れない**（と理解している。実装の前に Cloudflare の文書で確かめる）ので、
  ローカルの鍵でも DB を上書きできてしまう。そのため鍵は **Actions とは別のローカル用の R2 トークン**（Object Read & Write・このバケットだけ）にし、漏れたらそれだけを取り消す
- 鍵はローカルの `.env` に置く。**`.env.example` に足す名前**（値は書かない）: `R2_ACCESS_KEY_ID`・`R2_SECRET_ACCESS_KEY`・`CLOUDFLARE_ACCOUNT_ID`・`R2_BUCKET`（Actions と同じ名前）
- 判定役は `.env` を読めない（4-3 のフックは許すものだけを通す）
- 料金: AWS CLI は無料で、Amazon のアカウントは要らない。ローカルの出し入れは週1回ほど（DB の写し約57MB を1回・答えのファイル数十）で、R2 の無料枠（保存 10GB・書き込み系 100万回/月・読み出し系 1,000万回/月・転送料なし）のごく一部。
  R2 を使い始めるときに Cloudflare がカードの登録を求める（無料枠を超えなければ請求はない。登録の画面で確かめる）
- チェックサムの設定（`AWS_REQUEST_CHECKSUM_CALCULATION=when_required` など）が要るかは、docs/workflows.md 2-2 と同じく実装のときに1回出し入れして確かめる

## 3. 続きの回の候補（新しく作る）

### 3-1. 候補の選び方（ジョブで。API なし）

docs/ai-runs.md の計測で当たりの多かった層だけを候補にする（当たりは 10-18・10-19 の抜き取りの値、本数は 2026-10-23 の DB）。

| 候補の理由 | 中身 | 当たり | 本数（10-23） |
| --- | --- | --- | --- |
| `same_work_members` | 同時視聴枠（種の枠）の作品名の区間を題名に含むメン限の動画（R1）。**メン限の見出しの区間だけで当たるものは除く**（下） | 13/30 | 359 → 見出しを除いて 145 |
| `continuation_word` | メン限で、同じ配信者の種の枠の作品名の区間か前後30日のメン限の枠があり、続きの語（season・episode・ep N・part N・第N話・N話・最終回・finish・続き・観ようよ など）を含む（R3 ＋ レビューで足した語） | 18/30 | 89 |
| `same_title_body` | 同じチャンネルの種の枠と、【】の中身・感嘆符・空白を除いた題名の本体が同じ（本体4文字以上） | 6/22 | 11 |
| `weak_word` | 題名（detect の正規化のあと）が弱い語（let's watch・一緒に/いっしょに 観・見・み・みんなで/皆で 観る・見よう など・視聴会）に当たる動画。公開・メン限とも。種の枠は要らない（2026-11-13 に足した） | 作品 9/30〜11/19（D2 は作品 5/30・作品ではない同時視聴 18/30） | 289（弱い語だけ 274） |

- 3層を重ねて見出しを除くと **205本**（10-23。判定役 5ファイル。1回の上限 500件に収まる）。弱い語を足した4層では、巡回の前の DB で 478本・今の DB（最後の巡回 10-29）で **481本**（弱い語 292・弱い語だけ 280。2026-11-13。docs/ai-runs.md の 2026-11-13 の節）
- **弱い語（`weak_word`）は 2026-11-13 に入れた**（ユーザー決定。D-04。語は config/candidates.yaml の `weak_words`）。判定役の試し（6-2。cand-trial-1104）で、弱い語の層の同時視聴でない7本（全体で 49本）を同時視聴と答えたものは0だった。
  弱い語の候補の多くは作品ではない同時視聴（Direct・スポーツ・ゲーム会社の番組など）で、判定役が not_a_work と答えてサイトには出ない。
  それまで（2026-10-26〜10-30）は入れていなかった。理由は「弱い語の予定枠がトップに出る」（10-27 に予定枠を出さなくなって無くなった）・トークン（弱い語だけの 274本で約130万トークンの見込み）・判定役が「同時視聴ではない」を見分けられるかが分かっていないこと
- 入れない層: 30日を超える同じ作品名の公開の動画（B）・同じ見出しの前後のメン限（C）・前後30日のメン限の全部（D）。当たりが少なく、判定役の手間に見合わない。
  **メン限の見出しの区間だけで当たる動画**も入れない（下。cand-trial-1104 の10本で作品の同時視聴は0）
- **作品名の区間**: neighbors.ts の workKeys・ignore_keys・boilerplate_ratio と同じものを使い、さらに**メン限の見出しの区間**を除く（Fable の低の指摘）。
  10-23 の計測で、same_work_members の 359本のうち 214本は「メンゲン」「メンゲンノチカラ」「konbinicrew」「strim」「member限定」「桜spサン限定」「teaparty」「chillstream」などのメン限の見出しの区間だけで当たっていて、
  正解の付いた 27本で同時視聴は 0本だった（95%上限 約12%）。今の boilerplate_ratio（チャンネルの全動画の3%超・10本以上）は、メン限の見出しが全動画の3%に届かないので効かない。決め方:
  - 区間の割合を**そのチャンネルのメン限の動画の中でも**数え、メン限の動画の一定の割合を超えて出る区間は見出しとして使わない（割合と本数は、実装のときに 10-23 の 214本がほぼ落ちて 145本が残る値を選び、docs/ai-runs.md に書く）
  - 割合で落ちないものは config/extract.yaml の `ai_context.other_videos.ignore_keys` に足す（10-23 の scripts/noise.mjs の NOISE が出発点）
  - **2026-11-08 に実装した**（塊 D1。src/candidates/select.ts・neighbors.ts の videoKeys）: メン限の動画の 25% 超・10本以上（`members_heading`）と、NOISE を ignore_keys に。
    10-30 の巡回の前の DB で 214本は全部落ち、145本は全部残った。3層を重ねて 201本（205本との差4本は、見出しの区間だけで当たり弱い語か見出しの区間経由の続きの語と重なっていた動画）。経緯は docs/ai-runs.md の 2026-11-08 の節
  - この決まりは neighbors.ts と共有する（判定役に見せる「同じ作品名の動画」にも同じ雑音が入っているため。neighbors.ts の挙動も変わるので、変えたら判定役に見せる手がかりが減っていないかを確かめる）
- 候補は新しい表 `candidates` に持つ（video_id・理由・種の枠・選んだ日・状態、と 3-2 の詳細）。同じ動画は1回だけ候補にする
- コマンドは `candidates:select`（この節。日次のジョブの手順 6。docs/workflows.md 3-1）

### 3-2. 候補の詳細（ジョブで。videos.list）

候補にした動画は、日次のジョブで videos.list を引く（50本で1ユニット。205本で5ユニット）。配信が終わったか・配信の長さ・概要欄の全文・メン限か、が分かる。

- **終わった動画だけを判定に回す**。予定・配信中の候補は、まだ中身が無いので判定できない（2026-10-27 に予定枠を出さなくなったので「トップに出るのを防ぐ」という前の理由は無くなった）。次の日の videos.list で終わっていれば回す
- **詳細は `candidates` の表に持つ**（Fable の中-2。2026-10-27 決定）。videos.list の結果を watch_events と同じ列（title_raw・thumbnail_url・started_at・started_at_source・status・ended_at・
  description_raw・is_members_only・view_count など）で持つ。生レスポンスは R2 で30日で消え、ローカルの DB の写しにも入らないので、`ai:queue` は表から読む。
  **概要欄（description_raw）は watch_events と同じく判定のためだけに持ち、公開しない**
- 枠にするとき（3-4）は、この列をそのまま watch_events に写す（もう一度 videos.list を引かない）
- コマンドは `candidates:fetch`（docs/workflows.md 3-1 の手順 6。`candidates:select` のあと）

### 3-3. 判定役への見せ方

- 候補も枠と同じ待ち行列のファイルに混ぜる。見せるものは枠と同じ（タイトル・概要欄・サムネイル・前後の枠・コメント・枠にならなかった動画など）に、**候補にした種の枠**を足す
- 答えに区分 **`not_watchalong`（同時視聴ではない）** を足す。「同時視聴か」と「どの作品か」は1回の答えに書かせる
  （別々にすると、足した枠が未同定 → もう一度待ち行列、になる）
- 候補であることは判定役に伝える（「同時視聴の語が題名に無い動画。同時視聴かどうかから判断する」）。候補の理由（層）は見せない。
  弱い語だけの候補は種の枠が無いので「候補にした同時視聴の枠: なし」
- GUIDE（src/report/blind.ts）の「続きの回の候補」の節（2026-11-13。塊 D3b）: 同時視聴は「映像を視聴者と一緒に観ることが配信の主な中身」。
  同時視聴で観ているものが作品なら identified など、作品でなければ（Direct・スポーツなど。CLAUDE.md の「作品かどうかの境目」）**not_a_work**、
  同時視聴の配信でなければ **not_watchalong**、決められなければ hold。not_watchalong は候補の動画だけに使う。
  同時視聴の語で枠になった枠で、そもそも作品を観ていないものは、今までどおり not_a_work（evidence.notes に「同時視聴枠でない」）
- 採点の表（`ai:report`）は、候補の表に持つ答え（not_watchalong・枠の無い hold）も ai_decisions の判定と同じ表に出す（確度 high は今までどおり抜き取り。2026-11-13）

### 3-4. 答えの反映

| 答え | 反映 |
| --- | --- |
| `not_watchalong` | 候補の状態を「同時視聴ではない」にする。枠は作らない |
| identified / not_in_db / unidentifiable | **枠（watch_events）を作る**。`detect_source = 'ai_candidate'`、`detect_keyword` に候補の理由。判定は今と同じく ai_decisions に入れる |
| not_a_work | 枠を作り、判定を入れる（サイトには出ない。今の作品ではない枠と同じ） |
| hold | 候補のまま（次の回に `--include-hold` で出す） |

今のコードで直すところ（docs/ai-runs.md のレビューで確かめた注意点）:
- `fetchAndUpsert`（src/crawl/ingest.ts）と `rerunDetect`（src/report/reports.ts）は、語彙に当たらない枠を外す。**`detect_source = 'ai_candidate'` の枠は語彙で判定し直さない**
- `ai_decisions.watch_event_id` は NOT NULL。候補は判定が先・枠が後なので、反映のときに枠を作ってから判定を入れる（候補の `not_watchalong` は candidates の表に持つ）
- `is_members_only` は candidates の表の値（videos.list とメン限プレイリスト・videos_seen の `is_members_hint`）を渡す（渡さないとメン限の続きの回が公開の枠になる）
- 取り消し（`ai:revoke`）で、AI が足した枠は `excluded_at` を立てて外す（理由 `ai_revoked`。行は消さない）
- 候補の答えにも 2 の「古い答え」の決まりを当てる（`not_watchalong` は candidates の表に答えの時刻を持ち、それより古い答えは飛ばす）
- 型（route）は ai_* のまま。publishState は eventStatus の分岐を外したあとのものをそのまま使う

## 4. Claude Code のワークフロー（ループの形）

2026-10-26 に Claude Code の文書と、Workflow の台本の決まり（workflow-authoring の参照）で確かめた。出典の URL は 4-4 の末尾。
**試しには動かしていない**（判定役を動かすとトークンを大きく使うため。確かめていないことは末尾）。

### 4-1. 置き場所と起動

- 台本は `.claude/workflows/ai-judge.js`（プロジェクトのフォルダ。リポジトリに入れる）。会話で `/ai-judge` と打つか、名前で Workflow を起動する。
  名前の付いた保存したワークフローを人が起動するのは、Workflow を使ってよい条件に入る
- 台本は素の JavaScript。**ファイル・シェル・`Date.now()`・`new Date()` は使えない**。CLI を動かすのは中のエージェントで、日付（バッチ名のシード）は起動のときの引数で渡す
  （例 `{"seed": "ai-20261102", "maxFiles": 10}`）
- 判定役は**専用のエージェントの型**（`.claude/agents/ai-judge.md`）にし、台本の `agentType: 'ai-judge'` で起動する。型にしておくと、道具を絞れることと、
  フックで判定役の呼び出しだけを見分けられる（4-3）
- 再開: 同じ会話の中なら、止まった回を `resumeFromRunId` で続きから再開できる（終わったエージェントの結果は使い回す）。**会話をまたぐと使えない**ので、
  `ai:queue` は同じシードで2回目に呼ばれたらバッチのフォルダをそのまま使い、答えのそろったファイルを飛ばす（2026-11-13 実装。「そろった」は answers/NN.json が読めて finished_at があり、queue/NN.md の枠を全部答えていること。
  DB の今の状態では選び直さない。別のシードで同じ batch の名前なら断る）

### 4-2. 段（台本の形）

    Prepare    エージェント1本（effort low）: ai:pull → ai:queue --seed <args.seed> --include-hold --candidates --max-files <args.maxFiles>
               → { batch, files: [待ち行列のファイル], remaining: 上限で残った件数, quotaStopped } を schema で返す。0ファイルなら終わり
               （実装: ai:queue の最後の行に {"batch","files","remaining","quotaStopped","units","reused"} の JSON を出す。--max-files は 1〜10）
    Judge      判定役を5本まで同時に（台本の中で5本の作業者が待ち行列のファイルを順に取る形にする。pipeline の同時数の上限は
               min(16, CPU数−2) で5本に絞れないため）。PROMPT.md の <NN> を置き換えてそのまま渡す
               → ファイルが終わるごとに ai:check（エージェント1本・effort low。形・lookup の記録・finished_at）。だめなら同じファイルをもう1回だけ判定させ、それでもだめなら答えから外して log に出す
    Reconcile  全部そろってから（ここだけ待つ）: エージェント1本。同じ配信者・同じ作品・期と編で答えが割れていないかを DB の写しで並べ、直す答えを fix-*.json に書く（finished_at は直した時刻）
    Report     エージェント1本: ai:report（確度 high 以外・保留・特定できない枠の表）→ ai:push
               → 終わりに、入れた件数・保留・残りの件数（remaining）・使ったクォータを log に出す

- **1回の上限は 10ファイル＝500件**（決定 5）。判定役1本で約23万トークンなので、1回で約230万トークン。上限で切ったら残りの件数を必ず log に出し、繰り返さない（次の回で続ける）
- 判定役が途中で落ちた（利用の上限に当たった・ユーザーが止めた）ファイルは答えが無いだけで、次の回の `ai:queue` でまた待ち行列に入る（判定済みでない枠は消えない）
- 採点は取り込みのあと（決定 3）。Report は表を作るだけで、人の採点を待たずに ai:push まで進む。採点で見つけた誤りは、今と同じく fix-*.json にして次の回で置く
- 判定役は CLAUDE.md を読む（今と同じ。エージェントの型の `omitClaudeMd` で止められる）。**CLAUDE.md を直した直後は、会話を開き直してから起動する**。
  CLAUDE.md を読ませないか（`omitClaudeMd: true`。古い写しの問題と、CLAUDE.md の過去の答えが目に入る問題が無くなる。GUIDE.md だけで判断できることを先に確かめる）は実装のときに決める

### 4-3. 権限の扱い

文書で確かめたこと:
- サブエージェント（ワークフローの中のエージェントも）は**会話の許可の規則をそのまま受け継ぐ**。会話が auto・acceptEdits・bypassPermissions のときはその mode で動き、
  エージェントの型の `permissionMode` は無視される。default（Manual）のときは型の `permissionMode` で動く
- 許可が要る呼び出しは、会話の中では人に確認が出る。判定役5本がそれぞれ何十回も `npm run cli -- lookup` を呼ぶので、**許可の規則が無いと確認が続けて出る**
- 規則の書き方: `Bash(npm run cli -- lookup *)`（`:*` で終える書き方も同じ）。`&&`・`;`・`|` でつないだコマンドは、つないだ1つずつが規則に当たらないと許可されない。
  PowerShell の道具は「Bash と同じ形の規則」で書くと文書にあるが、**Bash の規則が PowerShell にも効くかは書かれていない**ので、両方を書く

置く規則（`.claude/settings.json`。リポジトリに入れる）:

    allow:  Bash(npm run cli -- lookup *)      PowerShell(npm run cli -- lookup *)
            Bash(npm run cli -- ai:pull *)     ai:queue・ai:check・ai:report・ai:push・ai:status も同じ（PowerShell も）
            Edit(./data/ai/**)                 答え・fix・work/ を書く（Write も Edit の規則で決まる）
            Workflow(ai-judge)                 予定タスクから起動するとき（下）

`aws` は `ai:pull`・`ai:push` の中から呼ぶので、`aws` そのものは許可しない（2-1）。

判定役が開いてはいけないもの（sealed/・DB・src/・config/・docs/・data/review・data/audit・ほかのバッチ・.env）をどこまで道具で塞げるか:

| 手段 | 塞げるもの | 塞げないもの |
| --- | --- | --- |
| Read の deny の規則 | Read・Grep・Glob（「できる限り」）、Bash で Claude Code が分かる読み方（cat・head・tail・sed・リダイレクト） | `grep -r` のように名前を書かずに読むもの、node・python のスクリプト、PowerShell の Get-Content（文書に書かれていない）。**設定に置くと会話の本体と開発にも効く**（src/・docs/ を読めなくなる）ので、判定役だけには使えない |
| エージェントの型の `tools` | 判定役の道具を Read・Write・Bash（lookup のため）に絞る（Edit・Grep・Glob・Web を外す） | Bash を残す限り、シェルからは何でも読める |
| PreToolUse のフック | **判定役の呼び出しだけ**を見分けて止められる（フックの入力に `agent_type` が入る。exit 2 で止まり、allow の規則より先に効く） | 文字列で見るだけなので、書き方を変えた読み方（変数・別のスクリプト）は漏れる。フックが時間切れになると通る（`onFailure: "block"` で止める） |
| サンドボックス | — | **Windows（ネイティブ）では使えない**（macOS・Linux・WSL2 だけ） |

→ 決め: **判定役の型で道具を絞り、フックで判定役の呼び出しを「許すものだけ通す」形で見る**。
フック（`.claude/hooks/ai-judge-guard`。`agent_type` が `ai-judge` のときだけ働く）は、
Bash・PowerShell は `npm run cli -- lookup …`（出力を `data/ai/<batch>/work/<NN>/` に書くリダイレクトは可）だけ、
Read はそのバッチの GUIDE.md・queue/・thumbs/・work/ だけ、Write は answers/・work/ だけを通し、ほかは止める。
それでも漏れうる（文字列で見る限り）ので、**指示（GUIDE.md・PROMPT.md）で守らせることも今のまま続ける**。
lookup は DB の照会のキャッシュ（resolve_cache）を読み書きするが、出すのは外部DBの照会結果だけで、ルールの答え・ほかの枠の答えは出さない（src/report/lookup.ts）

### 4-4. 予定タスクで無人で回すとき（決定 2 の「慣れたら」）

- デスクトップアプリの予定タスク（ローカル）: **アプリが起動していて PC が起きているときだけ動く**（逃した回は7日以内に1回だけ追いかけて動く。「PC をスリープさせない」の設定あり）。
  タスクごとに permission mode を決める。Manual のままだと、許可の無い呼び出しで**人が許可するまで止まる**。`~/.claude/settings.json` の allow の規則は予定タスクにも効く
  （プロジェクトの `.claude/settings.json` も効くかは文書で確かめられなかった）。起動するプロンプトは「`/ai-judge` を引数 … で」とし、`Workflow(ai-judge)` を allow に入れる
- クラウドの予定タスク（routines）: 使わない。新しいクローンで動きローカルの data/ を読めない。R2・YouTube の鍵をクラウドに置くことになる。permission mode を選べず確認なしで動く
- `claude -p`（ヘッドレス）で回す場合: Manual では許可の要る呼び出しは断られる（`--permission-prompts none` で確認を出さず断る）。`--permission-mode dontAsk` で allow の規則に無いものを全部断る形にできる
- 無人で回すときの注意: **利用の上限に当たっても気づきにくい**（判定役が null で返り、答えの無いファイルが残るだけ）。Report の log と ai:status を次に人が見るときに確かめる。
  1回 500件の上限（約230万トークン）は無人でも変えない

出典: code.claude.com/docs/en/ の permissions・sub-agents・hooks・workflows・permission-modes・headless・cli-reference・desktop-scheduled-tasks・routines・sandboxing（2026-10-26 に読んだ）

## 5. YouTube のクォータ

`ai:queue` はコメント（commentThreads。公開の枠1枠1ユニット）・概要欄のリンク先（videos・playlists。50件で1ユニット）を引く。ローカルの写しに記録した消費は R2 の DB に戻らない。

- **AI の判定の取り分は1日 600 ユニット**（決定 5。日次だけになっても変えない）。`config/crawl.yaml` の `quota.ai_reserve: 600`。ジョブは `stop_at`（9,000）から取り分を引いた **8,400** で止める
  （ジョブの側は docs/workflows.md の 7。ふだんの日次は約 750〜800 で、2時間ごとをやめて空いたぶんは戻すときのために残す）
- APIキーはジョブと同じ1つ（docs/workflows.md 7。クォータのためにプロジェクトを分けない）
- ローカルは、自分の消費を太平洋時間の日付ごとにローカルのファイル（例 data/ai/quota.json）に足し、取り分を超えたら ai:queue のリンク先・コメントの取得をやめる
  （待ち行列は作り、コメントなしと書く）。500件の回で、公開の枠が全部でも約 500＋α ユニットで収まる
  （2026-11-13 実装: data/ai/quota.json。その回の上限を「取り分 − 今日のローカルの消費」に下げ、使い切ったら以降の枠は待ち行列に「コメント欄: 取らなかった（YouTube のクォータの都合…）」
  「YouTube のリンク先: 取らなかった」と書く。途中で落ちてもその回の消費は足す。ローカルの DB の写しの quota_usage の stop_at も今までどおり効く）
- 候補の videos.list（3-2）はジョブ側で引くので、ジョブのクォータに入る（205本で5ユニット）

## 6. 公開の前にやること（順番）

1. 候補の選び方（3-1。見出しの区間を除く決まりを含む）を作り、今の DB で件数を数え直す（判定はしない。10-23 の手作業の数え 205本と合うか）
2. 判定役で見分けられるかの試し: docs/ai-runs.md の 10-23 の節の抜き取り案（シード cand-1023 の110本。弱い語30本・見出しだけの10本を含む）を判定させ、人が採点する。
   見るのは「同時視聴でない動画を同時視聴と答えないか」と、層ごとの当たりの割合
3. 結果で層を絞る・続きの語を直す・弱い語を入れるかを決める（決定 4）
4. 反映（3-4）と、ワークフロー（4）を作る。R2 の代わりにローカルのフォルダで1周まわす
5. 過去の候補を全部判定する（初回だけ大きい。205本なら1回で収まる。弱い語を入れるなら 479本。回す前に件数と消費を伝える）
6. Phase 4 で R2 につなぐ（AWS CLI と鍵を入れ、ai:pull・ai:push とジョブの取り込み）
7. 手で数回まわして、権限の確認の出かた・1回の消費・フックの漏れを確かめてから、予定タスクに移すかを決める（決定 2）

## 7. 決めたこと（ユーザー）

2026-10-26:

1. **取り込みはジョブが受け箱から**（R2 の ai/inbox/ に置き、日次のジョブが resolve の前に取り込む）。答えを作るのは人が起動した Claude Code の回だけ、は変えない。
   ローカルから R2 の DB を書き戻す形・取り込みだけのジョブを手で起動する形は採らない
2. **まず手で回し、慣れたらデスクトップアプリの予定タスクに移す**。手で回す頻度は週1回ほど。移すかどうかは、6-7 で権限の確認の出かたと1回の消費が分かってから決める（4-4）
3. **人の採点は取り込みのあと**（今の「ある程度任せる」のまま）。ワークフローは採点を待たずに ai:push まで進む。誤りは fix-*.json で直す
4. **弱い語（let's watch・一緒に/みんなで観る・視聴会）は、試し（6-2）のあとに入れるかを決める**（2026-11-13 に「入れる」と決まり、塊 D3b で入れた。3-1）。最初の候補は same_work_members・continuation_word・same_title_body の3層。
   試しには弱い語の抜き取りも混ぜる。2026-10-27 に予定枠を出さなくなって前提の1つが無くなったので聞き直し、2026-10-30 に「そのまま試しのあと」と決め直した（3-1）
5. **1回の上限は 500件（10ファイル）、AI の判定の YouTube の取り分は1日 600 ユニット**（ジョブは 8,400 で止める）

2026-10-27（docs/workflows.md の決定。この文書に関わるもの）:

6. トップの「これから始まる枠」をやめ、巡回は日次だけにする。「予定枠・配信中の枠は AI の判定を待たずに出す」は無くなる（冒頭）

2026-10-30:

7. **ローカルの R2 の道具は AWS CLI**。ai:pull・ai:push は CLI のコマンドから `aws` を呼ぶ。鍵は Actions と別のローカル用の R2 トークンを `.env` に置く（2-1）

Fable の指摘で決めたこと（2026-10-27。親セッションから）: 古い答えで上書きしない決め方（2。docs/workflows.md 6-2 とそろえた）・候補の詳細を candidates の表に持つ（3-2）・
メン限の見出しの区間を候補の作品名の区間から除く（3-1）

未決のまま残したもの（実装のときに決める）: 判定役に CLAUDE.md を読ませるか（4-2）・フックの許可の細部（4-3）・見出しの区間を割合で落とすときの値（3-1）

## 8. 実装のときに直すところ（CLAUDE.md とコード。実装と同じコミットで）

| 場所 | 直すこと |
| --- | --- |
| docs/ai-judging.md「同定の型と AI の判定」（CLAUDE.md から移した） | 「人が起動するコマンドでだけ入れる」→ 1章の読み替え。手順を ai:pull → ワークフロー → ai:push → ジョブの ai:ingest に。「予定枠・配信中の枠は、作品の同定を待たずに出す」と publishState の pending_ai の「予定枠・配信中の枠は frame として出す」を消す（10-27） |
| docs/backlog.md「残る課題と未確定」（CLAUDE.md から移した） | 「AI の判定の公開後の運用」を未確定から外す（この文書へ）。「題名に同時視聴の語が無い続きの回」を候補の仕組みとして書き直す（例は書かない） |
| docs/data-model.md「データモデル」「取得用の内部テーブル」（CLAUDE.md から移した） | `candidates` の表・`WatchEvent.detect_source` に `ai_candidate`・答えの区分 `not_watchalong` |
| docs/dev.md「実行方法」「ファイル構成」（CLAUDE.md から移した） | ai:pull・ai:push・ai:check・ai:ingest・`ai:queue --candidates`、`.claude/workflows/`・`.claude/agents/`・`.claude/hooks/`、`.env` の R2 の名前 |
| CLAUDE.md「フェーズ」 | AI の判定の運用と候補を Phase 4 の公開の前に入れる |
| src/resolve/ai.ts 6行 | 済（2026-11-13）。「定期実行のジョブからは入れない」→ 1章の読み替え |
| src/report/ai.ts 32行 | 済（2026-11-13）。「ローカルの CLI。定期実行のジョブからは呼ばない」→ 同上（ai:ingest はジョブから呼ぶ） |
| src/cli.ts 63行（HELP） | 済（2026-11-13。ai:check・ai:pull・ai:push・ai:ingest。`ai:queue --candidates` は D3a）。「人が起動する。定期実行のジョブからは呼ばない」→ 同上。新しいコマンドを足す |
| src/report/ai.ts の aiApply | 済（2026-11-13）。「古い答え」の決まり（2）・ファイル単位の問題を分けて返す（docs/workflows.md 6-3） |
| src/resolve/route.ts の publishState | eventStatus の分岐を外す（docs/workflows.md の側で直すかと合わせる） |
| src/report/neighbors.ts・config/extract.yaml | メン限の見出しの区間を除く（3-1） |
| src/crawl/ingest.ts・src/report/reports.ts | `ai_candidate` の枠を語彙で判定し直さない（3-4） |
| `.env.example` | 済（2026-11-13）。`R2_ACCESS_KEY_ID`・`R2_SECRET_ACCESS_KEY`・`CLOUDFLARE_ACCOUNT_ID`・`R2_BUCKET`（値なし） |
| config/crawl.yaml | `quota.ai_reserve: 600` |
| src/report/blind.ts（GUIDE） | 候補の説明と `not_watchalong`・`finished_at` を必ず書く |

## この下書きで確かめていないこと

- 判定役が候補を「同時視聴ではない」と正しく見分けられるか（6-2 の試しまで分からない。cont-trial-1021 では正解が同時視聴でない46本で yes 0。81本はすべて候補の層に入る動画で、弱い語の動画は1本だけ）
- メン限の見出しの区間を割合で落とす決まりで、10-23 の手作業の切り分け（NOISE。区間の上位25を見て決めた）と同じ結果になるか。下位の雑音の区間は手作業でも残っている
- ワークフローを実際に動かしたときの権限の確認の出かた（文書で確かめただけ。6-7 で手で回して確かめる）
- 文書に無く、確かめられなかったこと: Bash の許可の規則が PowerShell の道具にも効くか（両方を書く）／PowerShell の Get-Content が Read の deny の規則で止まるか（止まらない前提）／
  `Read(**/sealed/**)` のような相対の `**` の起点の決まり／フックの `if` に Read の形が使えるか（`if` は使わず、フックの中で道具の名前と入力を見る）／
  プロジェクトの `.claude/settings.json` の allow の規則が予定タスクにも効くか（`~/.claude/settings.json` は効くと書かれている）／Write が Edit の allow の規則で許可されるか
- エージェントの型の `disallowedTools` に `Read(src/**)` のような範囲つきの規則が書けるか（文書は道具の名前の例だけ。書けるなら、フックより確かに判定役だけを塞げる）
- R2 の API トークンをバケットの中の場所（ai/inbox/ だけ）まで絞れないこと（2-1。Cloudflare の文書で確かめていない）。R2 を使い始めるときのカードの登録（画面で確かめる）
- AWS CLI のチェックサムの設定が R2 で要るか（docs/workflows.md 2-2 と同じ。1回出し入れして確かめる）
