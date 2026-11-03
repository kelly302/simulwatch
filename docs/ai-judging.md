# 同定の型と AI の判定

CLAUDE.md から移した（2026-11-04。文言は変えずにそのまま移した）。CLAUDE.md と同じく**実装と同じコミットで直す**。未実装の決定は docs/decisions.md が優先する（印「→ D-xx」の付いた文）。

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
- **AI に回す型の枠は、AI が確かめるまでサイトに出さない**（2026-10-01 の決定 (a)）。AI が保留にした枠も出さない（保留のままでよい。2026-10-11 ユーザー）。**保留は型に関係なく出さない**（ルールのまま出す型の枠を `ai:queue --video` で回して保留になったときも。2026-10-22 ユーザー決定）
- **予定枠・配信中の枠は、作品の同定を待たずに出す**（2026-10-11 決定）（→ D-01 で出さない形に変更予定・未実装）。AI の判定待ちでも枠として出し（作品は付けない）、作品が決まっていれば作品を付ける。
  終わった枠は今までどおり、判定するまで出さない。ルールが作品ではない語に当てた枠と、まだ名寄せしていない枠は、予定枠でも出さない（`publishState` の eventStatus）
- サイトでの出し方は `publishState`（src/resolve/route.ts）。Phase 3 の publish はこれに従う。件数は `ai:status`

      work        作品を付けて出す
      frame       枠として出す（作品だが外部DBに無い・作品を特定できない・確度 low の同定）。作品ページは作らない
      hidden      出さない（作品ではない）
      pending_ai  AI の判定待ち（出さない。予定枠・配信中の枠は frame として出す）（→ D-01 で予定枠も出さない予定・未実装）

- 取りこぼし（ルールの答えが AI の答えの一部。サイトに出ないだけ）は型の「誤り」に数えない。件数は記録して改善の材料にする
- 公開後も、型ごとの AI との一致率で確定・AI 行きを上げ下げする（足切りを手で足し続けない。`ai_routes` を変える）
- 新しい枠の5〜6割は AI の判定待ちで始まる（2026-10-09 の DB で日本の所属の57%、EN の90%。未同定が約3割、ルールが同定したが誤りの出た型が約4分の1）

### AI の判定のしかた（src/resolve/ai.ts・src/report/ai.ts・blind.ts・neighbors.ts・answer.ts）

- **人が起動するコマンドでだけ入れる**（定期実行のジョブからは呼ばない。有料APIを使わない）（→ D-03 で、判定は人が起動した回で作り、日次のジョブが答えのファイルを `ai:ingest` で取り込む形に変更予定・未実装）。Claude Code のセッションから、サブエージェントに判定させる
- 手順: `ai:queue --seed <batch> --n N --include-hold` → サブエージェント（1ファイル50件。5本ずつ並行）→ `ai:apply data/ai/<batch>/answers` → `ai:report <batch>`（→ D-03 で ai:pull → 判定 → ai:push → ジョブの ai:ingest に変更予定・未実装）。
  判定役に渡す指示文は `ai:queue` が data/ai/<batch>/PROMPT.md に書き出す（<NN> を待ち行列の番号に置き換えて、そのまま渡す）
- 判定のあと、同じ配信者・同じ作品の枠を DB で並べ、判定役のあいだで答えが割れていないか確かめてそろえる（期・編で分かれた作品、版でずれる話数、Annict と Wikidata の両方にある作品で割れやすい）
- **CLAUDE.md を直した会話のままサブエージェントを起動すると、古い CLAUDE.md が渡る**（会話が始まったときに読み込んだ写しが渡る。2026-10-09 に確かめた）。
  直した直後に判定を回すときは、会話を開き直してから起動する
- **判定役は候補を見ずに自分で答える**（候補を見せると同意に引っ張られる）。渡すのは data/ai/<batch>/GUIDE.md と queue/NN.md だけ。
  使えるのは thumbs/ のサムネイル（画像を直接見る）と `lookup`。sealed/・DB・src/・config/・ほかのバッチ・data/review・data/audit・docs/ は開かせない。
  照会の出力は `work/<番号>/` に分ける（共用の一時ファイルで照会結果が混ざったため）
- 判定役に見せるもの: 配信者・日時・タイトル・概要欄（定型文と URL で始まる行を除く。題名を見せるリンクの行は残す）・サムネイル・同じ配信者の同じ作品名の枠（近い10枠まで）・前後の枠（各3枠）・
  概要欄のリンク先（配信サービス・映画サイト）の題名／公開年／あらすじの冒頭（1枠3件まで）・
  概要欄の YouTube の動画・再生リストの題名／チャンネル名／公開日（2026-10-18。videos.list・playlists.list で引く。1枠3件まで。配信者自身のチャンネルのものは題名が同時視聴の語に当たるときだけ。
  消えた・非公開の動画は「取れなかった」。DB には持たず、待ち行列を作るたびに取る）・
  公開の枠の YouTube のコメント（上位15件。2026-10-16。メン限の枠は取れない。DB には持たず、待ち行列を作るたびに取る）・
  同時視聴枠にならなかった同じ配信者の動画の題名（videos_seen。2026-10-18。続きの回が題名に同時視聴の語を書かずに配信されることがあるため）:
  この枠の作品名の区間を題名に含む動画（期間を限らず近い5本）と、メン限の枠では前後30日のメン限の動画（近い8本）。
  作品名でない区間（MEMBERSHIP STREAM・PART 1 など）とチャンネルの動画の3%を超える動画に出る区間は使わず、英数字の区間は単語の切れ目で照合する。
  設定は config/extract.yaml の `ai_context`。型・区間・候補・ルールの答え・ほかの枠の答えは見せない。
  ルールの答えは `sealed/answers.json` に固定し、判定が終わるまで開かない
- 答えの区分: identified / not_a_work / not_in_db（作品だが外部DBに無い）/ unidentifiable / hold（→ D-04 で not_watchalong を足す予定・未実装）。確度は high / medium / low（**low はサイトに作品を出さない**）。
  not_a_work・not_in_db は lookup の記録が無ければ受け付けない。not_in_db は作品名・kind・movie を ai_decisions.extra に持つ
- **迷ったら hold**（埋めることが目的ではない）。ただし手がかり（同じ配信者のほかの枠・リンク先）まで見て決められるなら決める。
  期・編で作品が分かれていて通し番号や回数しか無い枠は、どの数え方でも確かに含まれる作品だけを答える。
  **英語のタイトルの枠は無理に同定しない**（はっきり分かるときだけ答える。保留でよい）
- **確定**: 判定は `ai_decisions` に1枠1行（取り消しは `revoked_at`。行は残す）。取り消されていない判定（hold 以外）の枠は resolve の対象から外し、最後に判定を入れ直す。
  ルールを直して `resolve --all` しても上書きしない。hold の枠は `--include-hold` を付けたときだけ次の待ち行列に出す。
  確定した判定を `ai:apply` で hold に置き換えた枠は、ルールで名寄せし直す（取り消した判定の結果が残らないように。`ai:revoke` と同じ）
- AI が選んだ Wikidata の項目は、ルールの作品クラスに加えて `wikipedia.ai_extra_work_classes` も受け付ける（ルールの照合には使わない）
- 採点: `ai:report` の表（report.html）は**確度 high 以外・保留・特定できない・`--video` の枠を全部**出す（2026-10-03 決定。AI の判定はある程度任せる）。
  `--sample N` は high からの抜き取り、`--include-high` で全部。採点は scores.md に書き出す。回をカンマでつなぐと複数の回を1つの表にまとめる（`ai:report ai-run-3,ai-run-4`）
- 採点・境目の決定で答えを直すときは、data/ai/<batch>/fix-*.json に答えを書いて `ai:apply` する（前の判定は取り消しになり、行は残る）
- 同じ誤りを AI が繰り返し直しているなら、ルールにする
- サムネイルは判定のためだけにローカルへ落とす（サイトには使わない）。判定のファイルと採点の表はメン限枠の概要欄を含みうるので公開しない（data/ はコミットしない）
- **回ごとの結果・採点・直した枠は docs/ai-runs.md に書き、CLAUDE.md には書かない**。判定役は起動時に CLAUDE.md を読むので、ここに書いた過去の答えが目に入る
  （ai-run-3 の判定役の報告で分かった）
