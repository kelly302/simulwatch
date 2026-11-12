# 決定の記録

2026-11-04 に作った。**決定を1件ずつ、日付と状態つきで書く場所**（ADR の形）。本文の文書（CLAUDE.md・docs/ の各文書）は今のコードの動きを書き、
変わる予定の所には「（→ D-xx で変更予定・未実装）」の印をその場に付けてここを指す。実装したら状態を「実装済み」にし、本文を直して印を消す。

- 状態: **未実装**（決めたがコードはまだ）／**実装済み**／**置き換え済み**（あとの決定で覆った。どれに置き換わったかを書く）
- 決めた人: 書いていなければユーザー。Claude が任されて決めたものは「Claude（任された）」と書く
- 覆った古い決定は、本文から消したあともここに残す（決め直しを防ぐ材料）

## 未実装

### D-02 公開先は Cloudflare Workers・workers.dev・生レスポンスは R2 に30日・コミットの作者は noreply（2026-10-26）

- 置き換えるもの: 技術スタックの「Cloudflare Pages」／決定 D（2026-10-19。「公開の前に決める」→ 決まった）
- 進み具合: コミットの作者を noreply にするところは済（2026-11-04。履歴の書き換えと user.email）。Workers・R2 は塊 F・段6
- 正の文書: docs/deploy.md の6章（直す箇所の一覧は 6-10）
- 印を付けた本文: CLAUDE.md の技術スタック、docs/ui.md（Pages の20,000ファイル・決定 D）

### D-03 AI の判定の公開後の運用（2026-10-26・10-27・10-30）

- 中身: 判定は人が起動した Claude Code の回でだけ作り、**日次のジョブは R2 の受け箱の答えのファイルを `ai:ingest` で取り込むだけ**（ジョブから Claude は呼ばない）。
  まず週1回手で回す。採点は取り込みのあと。**すでにある判定より古い答えは取り込まない**（時刻は文字列でなく瞬間で比べる。今の ai_decisions.decided_at は `Z` と `+09:00` が混ざっている）。
  R2 の出し入れはローカルも AWS CLI
- 置き換えるもの: 2026-10-01 の「人が起動するコマンドでだけ入れる（定期実行のジョブからは呼ばない）」
- 正の文書: docs/ai-ops.md の1・2・7章、docs/workflows.md の6章
- 印を付けた本文: docs/ai-judging.md（AI の判定のしかた）
- 進み具合（2026-11-13。塊 C）: 取り込む側を作った。aiApply の古い答えの決まり（瞬間で比べ、UTC で入れる）と問題の種類分け、
  `ai:ingest`（受け箱の batch を5つまで・結果と移す先を JSON に・`--settle` で移す）・`ai:check`・`ai:pull`・`ai:push`（ローカルのフォルダと AWS CLI の R2 を `--remote` で切り替える層。src/report/inbox.ts）、
  `ai:queue` のローカルのクォータのファイル（data/ai/quota.json）・同じシードの2回目・`--max-files`・返す値。
  残り: 日次のワークフローから呼ぶこと（塊 F）・R2 との実際の往復（段6）・Claude Code のワークフロー（塊 E）。候補の答えの反映は塊 D3a（それまでは「枠が無い」）。
  経緯と検証は docs/ai-runs.md の 2026-11-13 の節

### D-04 題名に同時視聴の語が無い続きの回を「候補 → AI」で枠にする（2026-10-22・10-30）

- 中身: 公開の前に作る。最初の候補は3層（弱い語は判定役の試しのあとに決める）。候補の表 candidates・答えの区分 not_watchalong・`detect_source = ai_candidate`
- 正の文書: docs/ai-ops.md の3章
- 印を付けた本文: docs/backlog.md（題名に同時視聴の語が無い続きの回）、docs/crawl.md（detect の弱い語）。docs/data-model.md（detect_source）の印は 2026-11-13 に外した（表と detect_source を書いた）
- 進み具合: 2026-11-08 に塊 D1（候補の選定と件数）を作った。3層の選び方（src/candidates/select.ts・config/candidates.yaml）・メン限の見出しの区間を除く決まり（neighbors.ts と共有）・
  `candidates:select --dry-run`（件数と一覧だけ）。巡回の前の DB で 201本・今の DB でも 201本（docs/ai-runs.md の 2026-11-08 の節）。
  残り: D3a（表と保存・fetch・反映）・D3b（層と語の設定・GUIDE）
- 進み具合（2026-11-08）: 塊 D2（判定役の試し）を済ませた。110本で正解が「同時視聴でない」49本に yes は0（95%上限 5.9%）、取りこぼし0。結果と手順は docs/ai-runs.md の 2026-11-08 の節。
  層を絞るか・弱い語を入れるかはまだ決めていない（塊 D3b でユーザーが決める）
- 進み具合（2026-11-13）: 塊 D3a の前半を作った。候補の表 candidates（マイグレーション 12。詳細の列・状態・答えの時刻まで。行を消さない）・
  `candidates:select` の保存（`--dry-run` は残した）・`candidates:fetch`（job は daily）・`detect_source = 'ai_candidate'` の枠を巡回と detect:rerun が語彙で外さない・
  候補から枠を作る関数と AI が足した枠を外す関数（src/candidates/frames.ts。`ai_revoked`）。docs/data-model.md に表と detect_source を書いた。
  今の DB の写しで select は 201本（dry-run と動画の ID・理由・種の枠まで同じ）、fetch は 5ユニットで 201本とも終わった動画。
  残り（D3a の後半。塊 C のマージのあと）: ai:queue が表から読む・aiApply で枠を作ってから判定を入れる・not_watchalong を表に持つ・ai:revoke・古い答えの決まりを候補にも当てる

### D-05 Phase 4 の進め方（2026-10-30）

- 中身: 段0〜6（docs/phase4-plan.md）。Claude Code のワークフロー（docs/ai-ops.md の4章。塊 E）は公開のあとに回す（ai-ops.md の「公開の前」を変えた）。
  E を作るとき、判定役には CLAUDE.md を読ませず GUIDE（src/report/blind.ts）だけを渡す
- 正の文書: docs/phase4-plan.md

### D-08 unresolved の JSON を R2 に置かない（2026-11-04。Claude（任された））

- 中身: 公開後の unresolved の確認は、`ai:pull` で落とした DB の写しをローカルの CLI で見る。`unresolved:export` の JSON は R2 に置かない（R2 の置き場所の表に無く、写しで足りる）
- 置き換えるもの: 「unresolved は R2 の JSON に出力し、ローカルの CLI で確認する」（Phase 1）
- 印を付けた本文: docs/crawl.md（unresolved の確認方法）、docs/dev.md（unresolved:export）

## 実装済み

### D-01 日次だけにする・「これから始まる枠」をやめる（2026-10-27。実装 2026-11-08、塊 A）

- 中身: 定期実行は日次だけ（日本時間 05:23。2026-10-30）。2時間ごとの巡回（crawl:hourly）は流さない（コードは戻すときのために残す）。
  トップから「これから始まる枠」と LIVE バッジを外し、予定枠・配信中の枠はサイトに出さない（終わってから判定されて出る）。目的の3つめ（予定枠と過去アーカイブを同じ場所で）を外す
- 置き換えたもの: 2026-10-11 の「巡回は2時間ごと」（その前は毎時）／2026-10-11 の「予定枠・配信中の枠は作品の同定を待たずに出す」／決定 A（2026-10-19。予定時刻から6時間で外す。意味を失った）
- 実装: site-data は終わった枠だけ（config/site.yaml の `publish_upcoming: false`。true で予定枠・配信中の枠も events に入る）。publishState の eventStatus の分岐を消した。
  ai:queue と ai:status は終わった枠だけ（ai:status は終わっていない枠を別の行に数える）。トップの UI と CSS（水色の面・LIVE バッジ）・formatWhen を消した。
  戻すときは UI と「判定待ちの予定枠を枠として出す」分岐を履歴から作り直す（docs/workflows.md の付録）。日次のワークフロー自体は塊 F
- 正の文書: docs/workflows.md の冒頭・3章・5-2・付録（戻すとき）

### D-09 ローカルの ai:apply にも「古い答えは取り込まない」を入れる（2026-11-04。Claude（任された）。実装 2026-11-13、塊 C）

- 中身: 時刻の決まりは aiApply の中に1つだけ作り、ジョブの ai:ingest とローカルの ai:apply の両方が通る（決まりを2つにしない）
- 実装: src/report/ai.ts の `answerFreshness`（すでにある取り消されていない判定の decided_at と、答えのファイルの finished_at を瞬間で比べる。新しければ入れる・同じなら入れ済み・古ければ飛ばす）。
  比べる時刻はその枠の取り消した行も含めた decided_at の最大（ai:revoke のあとに受け箱の取り消した答えがまた入らないように）。
  同じ呼び出しの中では名前の順に入れ、同じ時刻ならあとのファイル（`fix-*.json`）が残る。decided_at は UTC で入れる（前からある `+09:00` の行は直さない。比べるときに瞬間にする）。
  batch・model・finished_at（時差付き・未来でない）の無いファイルは、ai:apply でも入れない（それまでは finished_at が無いと取り込んだ時刻で入っていた）
- 正の文書: docs/workflows.md 6-2（「ai-ops の側と決める」としていた所の答え）

### D-06 決定は決めた日に記録し、本文は実装と同じコミットで直す（2026-10-30）

- CLAUDE.md の「実装と同じコミットで直す」の読み替え。2026-11-04 からは、決定はこの文書に、本文の該当の所には印を書く

### D-07 CLAUDE.md を毎回守る決まりだけに絞り、細部を docs/ に分ける（2026-11-04）

- 821行・約10万字あった。文言は変えずに移した（55b5390）。CLAUDE.md の「文書の目次」
