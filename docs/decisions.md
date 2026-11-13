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
- 進み具合（2026-11-13。塊 F）: Workers の設定（wrangler.jsonc。Worker 名は仮の `simulwatch`）と、日次・手動・keepalive のワークフロー（.github/workflows/・scripts/ci/job.sh）を作った。
  R2 の出し入れは AWS CLI（2.39.1 に固定）、アップロードは wrangler-action（v4.1.3・wrangler 4.155.0）。試しの置き場所 `R2_PREFIX`（例 `test/`）と、日次の手動の入力 `target: preview`・`crawl: false`。
  CLAUDE.md の技術スタック・docs/ui.md の印を直した（docs/deploy.md 6-10）。DB の写しでローカルのフォルダを使って日次を通した（docs/workflows.md 13）。
  残り: リポジトリ・Cloudflare・Secrets（ユーザーの手作業 G）と push のあとの GitHub での起動、R2 との実際の往復・本番へのアップロード（段6）、Worker 名とサブドメインの決定
- 正の文書: docs/deploy.md の6章（直す箇所の一覧は 6-10）
- 印を付けた本文: CLAUDE.md の技術スタック、docs/ui.md（Pages の20,000ファイル・決定 D）
- 2026-11-13: 「workers.dev で公開する」は D-11（midokoroya.com のサブドメイン）で置き換わる予定
- 2026-11-13 ユーザー決定: 生レスポンス（R2 の raw/）は**30日のまま**（Claude は、R2 のライフサイクルが最大24時間遅れて消すので29日を勧めたが、30日にした。G のセッションがライフサイクルを30日で設定済み。docs/youtube-policy.md の選択肢6）

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
  残り: ~~日次のワークフローから呼ぶこと（塊 F）~~（2026-11-13 に daily.yml の ai:ingest・settle のステップにした）・R2 との実際の往復（段6）・Claude Code のワークフロー（塊 E）。候補の答えの反映は塊 D3a で入れた（2026-11-13。D-04 の進み具合）。
  経緯と検証は docs/ai-runs.md の 2026-11-13 の節

### D-04 題名に同時視聴の語が無い続きの回を「候補 → AI」で枠にする（2026-10-22・10-30）

- 中身: 公開の前に作る。最初の候補は3層（弱い語は判定役の試しのあとに決める）。**2026-11-13 ユーザー決定: 弱い語（weak_word）も候補に入れる**（D2 の試しで、同時視聴でない7本を同時視聴と答えたものは0。作品の同時視聴は 5/30）。候補の表 candidates・答えの区分 not_watchalong・`detect_source = ai_candidate`。
  **2026-11-13 ユーザー決定: 判定役に配信の長さとメン限かどうかを見せる**（枠・候補とも。待ち行列の行。2行を足したあとの試し直しは費用のためしない。効果は段5の本番の判定で見る）
- 正の文書: docs/ai-ops.md の3章
- 印を付けた本文: docs/backlog.md（題名に同時視聴の語が無い続きの回。日次から呼ぶ所が残る）。docs/data-model.md（detect_source）・docs/crawl.md（detect の弱い語）・docs/ai-judging.md（答えの区分）・docs/ai-ops.md 3-1 の印は 2026-11-13 に外した
- 進み具合: 2026-11-08 に塊 D1（候補の選定と件数）を作った。3層の選び方（src/candidates/select.ts・config/candidates.yaml）・メン限の見出しの区間を除く決まり（neighbors.ts と共有）・
  `candidates:select --dry-run`（件数と一覧だけ）。巡回の前の DB で 201本・今の DB でも 201本（docs/ai-runs.md の 2026-11-08 の節）。
  残り: D3a（表と保存・fetch・反映）・D3b（層と語の設定・GUIDE）
- 進み具合（2026-11-08）: 塊 D2（判定役の試し）を済ませた。110本で正解が「同時視聴でない」49本に yes は0（95%上限 5.9%）、取りこぼし0。結果と手順は docs/ai-runs.md の 2026-11-08 の節。
  層を絞るか・弱い語を入れるかはまだ決めていない（塊 D3b でユーザーが決める）→ 弱い語は 2026-11-13 に「入れる」と決まった（上の中身。実装は塊 D3b）
- 進み具合（2026-11-13）: 塊 D3a の前半を作った。候補の表 candidates（マイグレーション 12。詳細の列・状態・答えの時刻まで。行を消さない）・
  `candidates:select` の保存（`--dry-run` は残した）・`candidates:fetch`（job は daily）・`detect_source = 'ai_candidate'` の枠を巡回と detect:rerun が語彙で外さない・
  候補から枠を作る関数と AI が足した枠を外す関数（src/candidates/frames.ts。`ai_revoked`）。docs/data-model.md に表と detect_source を書いた。
  今の DB の写しで select は 201本（dry-run と動画の ID・理由・種の枠まで同じ）、fetch は 5ユニットで 201本とも終わった動画。
  残り（D3a の後半。塊 C のマージのあと）: ai:queue が表から読む・aiApply で枠を作ってから判定を入れる・not_watchalong を表に持つ・ai:revoke・古い答えの決まりを候補にも当てる
- 進み具合（2026-11-13）: 塊 D3a の後半を作った（塊 C のマージのあと）。
  - ai:queue: 候補（ready。`--include-hold` で hold）を枠と同じ待ち行列に混ぜる。候補であること・同時視聴でなければ not_watchalong・候補にした同時視聴の枠（近い5枠）を見せ、層は sealed/ にだけ残す。`--candidates` で候補だけ。`--type` を付けると入れない
  - 答えの形: not_watchalong を受け付ける（works・title は書かない）。ai:check は待ち行列の候補でない動画の not_watchalong を弾く
  - aiApply: 候補の動画は枠が無い・外れた行でも通し、src/candidates/frames.ts で枠を作るか戻してから判定を入れる。語彙の変更で外れた行（detect_rule）・取り消しで外した枠も同じ行を戻す（ルールの枠の答えは塊 C のまま「枠が無い」）。
    アーカイブが消えた枠は候補でも入れない。not_watchalong と枠の無い候補の hold は候補の表に持つ。直しの not_watchalong が AI の足した枠に来たら、判定を取り消して枠を外す
  - 古い答え: 枠の判定の decided_at（取り消した行も含む）と候補の表の answered_at（取り消した答えも含む）の大きいほうと、answerFreshness で比べる
  - ai:revoke: ai_candidate の枠は外し（`ai_revoked`）、候補を ready に戻す。候補の表の答え（not_watchalong・hold）も取り消す（answer_revoked_at。answered_at は残す）。ルールの枠は今までどおり名寄せし直す
  - 今の DB の写しで select（201本）→ fetch（5ユニット）→ queue（10本）→ 用意した答え → ai:push → ai:ingest → settle を通した（結果は D3a の報告。答えは判定役のものではない）
  - 残り（D3b）: 層・続きの語・弱い語・GUIDE の文面（not_watchalong と「そもそも作品を観ていない枠は not_a_work」の整理）。ai:report は not_watchalong の答え（候補の表）を採点の表に出していない
- 進み具合（2026-11-13）: 塊 D3b を作った。
  - 弱い語の層（weak_word。config/candidates.yaml の weak_words。10-23 の式のまま）を足した。公開・メン限とも、種の枠の無い配信者も入る。今の DB の写しで候補 481本（弱い語 292・弱い語だけ 280）、巡回の前の DB で 478本（弱い語 289 は 10-23 と動画の ID まで同じ）
  - メン限の見出しの区間だけの層は落としたまま（D1 の決まり）。続きの語は変えない（語ごとの当たりと外れは docs/ai-runs.md の 2026-11-13 の節）
  - GUIDE に「続きの回の候補」の節（同時視聴の定義・not_watchalong と not_a_work の分け方・見分ける手がかり）。CLAUDE.md の「作品かどうかの境目」に「作品ではない」と「同時視聴ではない」を分ける1段落を足した
  - ai:report が候補の表の答え（not_watchalong・枠の無い hold）も採点の表に出す
  - 本番の答えの形での試し直し（cand-retrial-1113。110本。長さ・メン限の行が無い待ち行列）を回した。作品でない動画をサイトに出る答えは 0/73（95%上限 4.0%）・取りこぼし 0/56。結果は docs/ai-runs.md の 2026-11-13 の節
  - 待ち行列に「メン限」「配信の長さ」の行を足した（上の 2026-11-13 ユーザー決定。src/report/blind.ts の streamLength。枠は watch_events、候補は candidates の started_at_source・ended_at から）。GUIDE に長さの使い方を書いた
  - 日次のジョブから candidates:select・candidates:fetch を呼ぶところは塊 F で入った（daily.yml の candidates のステップ・scripts/ci/job.sh）。残り: 段5の本番の判定（過去の候補 約481本）で長さ・メン限の行の効果を見る

### D-05 Phase 4 の進め方（2026-10-30）

- 中身: 段0〜6（docs/phase4-plan.md）。Claude Code のワークフロー（docs/ai-ops.md の4章。塊 E）は公開のあとに回す（ai-ops.md の「公開の前」を変えた）。
  E を作るとき、判定役には CLAUDE.md を読ませず GUIDE（src/report/blind.ts）だけを渡す
- 正の文書: docs/phase4-plan.md

### D-08 unresolved の JSON を R2 に置かない（2026-11-04。Claude（任された））

- 中身: 公開後の unresolved の確認は、`ai:pull` で落とした DB の写しをローカルの CLI で見る。`unresolved:export` の JSON は R2 に置かない（R2 の置き場所の表に無く、写しで足りる）
- 置き換えるもの: 「unresolved は R2 の JSON に出力し、ローカルの CLI で確認する」（Phase 1）
- 印を付けた本文: docs/crawl.md（unresolved の確認方法）、docs/dev.md（unresolved:export）

### D-11 公開の URL は midokoroya.com のサブドメインにする（2026-11-13）

- 中身: ユーザーが取ったドメイン midokoroya.com（同じ Cloudflare のアカウントにある）のサブドメインを、Workers のカスタムドメインとして本番の URL にする。**サブドメインは `simulwatch`（本番の URL は https://simulwatch.midokoroya.com。2026-11-13 ユーザー決定。G のセッションで控えた）**。
  workers.dev は版とプレビューの URL（`preview-<Worker名>.<アカウントのサブドメイン>.workers.dev`）にだけ使う。本番の workers.dev の URL は止めるか、カスタムドメインへ移す（同じ中身が2つの URL に出ないように）
- 置き換えるもの: D-02 の「workers.dev で公開する」（docs/deploy.md 6-2 の「独自ドメインは使わない」）
- 変わるもの: SITE_URL（canonical・sitemap・og:url）、Search Console は「ドメイン」のプロパティ（DNS のレコード）でも確かめられる、AdSense の「workers.dev で審査に通るか分からない」（docs/deploy.md の確かめられなかったこと）は自分のドメインになるので当たらなくなる
- 確かめたこと（2026-11-13。G のセッションが読むだけで確かめた）: Worker `dokosuku` はカスタムドメインもルートも無し（`dokosuku.kelly00.workers.dev` だけ）。midokoroya.com は Cloudflare Registrar で登録し、DNS も Cloudflare（レコードはまだ0件）。アカウントの workers.dev のサブドメインは `kelly00`（プレビューの URL に使う）。カスタムドメインを Worker に付けるのは段6の最初のデプロイのあと
- 正の文書: この決定（docs/deploy.md 6-2 は印を付けた。実装するときに直す）
- 印を付けた本文: CLAUDE.md の技術スタック、docs/deploy.md（1-B の URL・SITE_URL・6-2・Search Console・6-10 の URL）、docs/workflows.md（2-8・8）、docs/ui.md、config/site.yaml、wrangler.jsonc

## 実装済み

### D-13 旧 NIJISANJI KR・旧 NIJISANJI ID のうち、同時視聴の枠が1つも無い4チャンネルを巡回しない（2026-11-13。実装 2026-11-13）

- 中身: オ ジユ・明楽レイ（旧 KR）、デレム カド・ナギサ アルシニア（旧 ID）。2026-11-13 に本体の DB を読んで数えた（巡回は 2026-10-30 が最後。data/analysis/overseas-channels-1113.md）。
  卒業と同じく is_active = 0 にして巡回を止める。行と取得済みのデータは残す（枠は0なのでサイトには出ていない）。設定から消せば次の roster で戻る
- 実装: config/roster.yaml の `excluded_channels`、src/roster/sync.ts の `applyExcluded`（一覧に載っていても inactive にする）。テストは test/parsers.test.ts
- 確かめたこと: 本体の DB の写し（VACUUM INTO）で roster を1回流し、streamers 282行のうちこの4行だけが is_active 1 → 0 になり、ほかの行の名前・区分・is_active が変わらないことを1行ずつ比べた（channels.list で約6ユニット）
- 置き換えたもの: CLAUDE.md の対象範囲の「旧 KR（11人）・旧 ID（6人）は外さない」に例外を足した（2026-10-03 の決定の一部）
- 残り: 本体の DB に効くのは次の roster（段6の日次）。この4チャンネルの videos_seen（2,526本）の題名の30日の扱いは塊 R に伝えた
  → D-12 で「取り直さずに消す」側に入れた（roster が巡回を止めたあとの retention で、videos_seen の題名・答える前の候補・アイコンとチャンネル名を消す。2026-11-13）

### D-12 YouTube の30日の決まりを満たす（2026-11-13 ユーザー決定（塊として作る）。実装 2026-11-13、塊 R）

- 中身: YouTube の API の規約 III.E.4（ログインなしで取ったデータは30日を超えて持たない。過ぎたら消すか取り直す）を満たす。DB の中のものは、最後に API で確かめてから
  **25日**（config/crawl.yaml の `retention.act_after_days`。30日との差の5日は日次が止まった日の余白）を過ぎたら取り直すか消す。手元のファイルは一覧にして人が消す。
  - videos_seen: 日次の `retention` が、題名を最後に確かめた時刻（refreshed_at。巡回で同じ題名を見た・refresh が枠の動画を取り直したときも進める）の古いものから videos.list で取り直す。
    1日の本数は「題名を持つ行 ÷ 25」（約285ユニット）と「25日を過ぎた行」の多いほう、上限 1,500ユニット（初回は約5日で追いつく）。返ってこない・公開でない動画は題名を空文字に・公開日を NULL に（gone_at。行と判定の結果は残す）。
    題名が変わったら巡回と同じく判定し直す（枠の動画は題名だけ。語彙のバージョンだけの違いは detect:rerun に任せる）
  - candidates: 判定に回す候補（ready・hold）は詳細が25日より古い・無ければ candidates:fetch が取り直す。終わった候補（detected・framed・not_watchalong）は25日で、取れない候補（unavailable）はすぐに詳細を消す（cleared_at）
  - streamers: roster が巡回を止めた配信者のチャンネルも取り直す。返ってこないチャンネルは、最後に返ってから25日を過ぎたらアイコンとチャンネル名を消す（channel_meta_at）
  - 巡回しないチャンネル（D-13 の excluded_channels）: 今後使わないので取り直さずに消す（親のセッションの提案を受けて Claude が決めた）。roster が is_active = 0 にしたあとの retention で、
    videos_seen の題名（gone_at）と、答える前・保留の候補（unavailable・fetch_note = excluded_channel）を消し、roster の channels.list で引かずにアイコンとチャンネル名を消す。
    卒業した配信者は過去の枠を出すので、ふだんどおり取り直す（src/retention/excluded.ts）
  - watch_events: アーカイブが消えて25日を過ぎた枠の題名・概要欄・サムネの URL・再生数を消す（purged_at）。行・判定・作品の結び付き・時刻・状態は残し、見られるようになったら refresh が入れ直す
  - 手元のファイル: `retention:files` が30日を超えたもの（生レスポンス・DB の写し・AI の作業フォルダ・audit・review・analysis・ログ・unresolved.json・site-data.json）を一覧にする。
    消すのは `--delete` のときだけ（中のファイルが全部古い項目だけ）。ジョブ・RawLog は手元のファイルを自動では消さない（経緯の記録に使っているものがある。日次のランナーは毎回まっさら）
  - 日次のワークフローに `retention` のステップ（docs/workflows.md 3-1 の 6b）。`retention:status` が古いものの件数を出す
- 置き換えたもの: なし（docs/youtube-policy.md の「30日の決まりで取り直す・消すもの」の直し方の案1〜5を、案1の「取り直す」側で実装した）
- 実装: src/retention/（seen・purge・status・files）、マイグレーション 13（videos_seen.refreshed_at・gone_at、watch_events.purged_at、candidates.cleared_at、streamers.channel_meta_at）、
  src/crawl/ingest.ts・refresh.ts・src/roster/sync.ts・src/candidates/store.ts、detect:rerun と判定役に見せる前後の枠・候補の種の枠は中身を消した行を使わない。経緯と写しでの確かめは docs/ai-runs.md の 2026-11-13（塊 R）の節
- 決めていないこと: 手元の今あるファイルのどれを消すか（ユーザーが一覧を見て決める）、
  unresolved・ai_decisions・event_works・候補の答えの根拠に入る題名の断片（自前の判定の記録。API のデータそのものかは灰色）、枠と候補の時刻・状態（消していない）
- R2 の raw/ の日数は塊 R では扱わない（2026-11-13 ユーザー決定で30日。D-02 の進み具合）
- 正の文書: docs/crawl.md の「30日の決まり」・docs/data-model.md・docs/workflows.md 3-1・7

### D-10 YouTube の規約の読み直しのあとも、作品ページの「観た配信者」は再生数の順が既定のまま・最高再生数と合計再生数は残す（2026-11-13。コードは今のまま）

- 中身: 規約と画面の突き合わせ（docs/youtube-policy.md）で、作品ページの既定の並び（別々の配信者を再生数で並べる）は手引きの「チャンネルの間で再生数を順位づけ」に一番近い（重さ 中〜高）と見立てたが、既定は変えない。
  最高再生数・合計再生数（チャンネルをまたいだ集計）は手引きの「許される指標」（まとまりの合計再生数）に沿うとして残す（規約 III.E.2.a の文面とのずれは承知のうえ）。
  ランキングの見出し（トップ「ランキング」・ページ「同時視聴ランキング」）も今のまま（2026-11-13 ユーザー決定。今のほうが分かりやすい。説明の行がすでに「公開枠を、再生数の多い順に」と書いている）
- 置き換えたもの: なし（Claude の勧め「既定を最終視聴日に」は採らなかった）
- 残り: 自前の数の表示・広告の置き場所・生レスポンスの日数は未決（docs/youtube-policy.md の「決め方の選択肢」）

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
