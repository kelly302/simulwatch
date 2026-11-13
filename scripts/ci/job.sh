#!/usr/bin/env bash
# 日次・手動のワークフローのステップの中身（docs/workflows.md の 2・3）。.github/workflows/*.yml の run はこのファイルを1ステップ1回呼ぶだけ。
# ローカルで同じ順に通すときは scripts/ci/local-daily.sh（R2 の代わりにローカルのフォルダ。docs/workflows.md 13）。
#
#   使い方: scripts/ci/job.sh <ステップ>
#
# 環境変数（どれもワークフローの env で渡す。秘密の値はこのファイルに書かない）
#   R2_LOCAL_DIR   あれば R2 の代わりにこのフォルダを使う（キーをそのままパスにし、メタデータは <キー>.meta.json。src/report/inbox.ts の LocalRemote と同じ）
#   R2_BUCKET・CLOUDFLARE_ACCOUNT_ID・R2_ACCESS_KEY_ID・R2_SECRET_ACCESS_KEY   R2（AWS CLI）。R2_LOCAL_DIR が無いときに要る
#   R2_PREFIX      試しの置き場所（例 test/）。すべてのキーの先頭に付ける。空なら本物の置き場所
#   TARGET         production / preview（アップロード先。R2_PREFIX があれば preview だけ）
#   WRITER         daily / publish（DB のメタデータの writer）
#   ACCEPT_DB      true なら db:check --accept（手動の accept_db。docs/workflows.md 2-3）
#   FORCE          true なら指紋が同じでもビルドする
#   DATA_DIR       既定 data。JOB_DIR（既定 $DATA_DIR/job）にこの回の作業ファイルを置く
#   COMMIT         指紋に混ぜるコミット（既定 GITHUB_SHA か git rev-parse HEAD）
#   JOB_STARTED_AT runs:summary の --since（既定は gate のステップで書いたもの）
set -euo pipefail

STEP="${1:?ステップを指定してください}"
cd "$(dirname "$0")/../.."

# ローカル（Actions の外）では、R2 の4つだけを .env から読む（環境にすでにあればそちら。R2_PREFIX は読まない: 試しの置き場所は起動するときに明示する）
if [ "${GITHUB_ACTIONS:-}" != "true" ] && [ -f .env ]; then
  for k in R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY CLOUDFLARE_ACCOUNT_ID R2_BUCKET; do
    if [ -z "${!k:-}" ]; then
      v="$(sed -n "s/^$k=//p" .env | tail -1 | tr -d '\r')"
      v="${v%\"}"; v="${v#\"}"
      [ -n "$v" ] && export "$k=$v"
    fi
  done
fi

DATA_DIR="${DATA_DIR:-data}"
export DATA_DIR
JOB_DIR="${JOB_DIR:-$DATA_DIR/job}"
DB="$DATA_DIR/db.sqlite"
# 空でも export する（CLI の --env-file-if-exists は、環境にある名前を .env で上書きしない。シェルと CLI で置き場所をそろえる）
export R2_PREFIX="${R2_PREFIX:-}"
TARGET="${TARGET:-production}"
WRITER="${WRITER:-daily}"
RUN_ID="${RUN_ID:-${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-1}}"
REMOTE="${R2_LOCAL_DIR:-r2}"   # CLI の --remote（ai:ingest）
export SITE_DATA="${SITE_DATA:-$DATA_DIR/site/site-data.json}"
export OG_CACHE="${OG_CACHE:-$DATA_DIR/site/og-cache}"
mkdir -p "$JOB_DIR"

in_actions() { [ "${GITHUB_ACTIONS:-}" = "true" ]; }
err() { if in_actions; then echo "::error title=$STEP::$*"; else echo "ERROR [$STEP] $*" >&2; fi; }
warn() { if in_actions; then echo "::warning title=$STEP::$*"; else echo "WARN  [$STEP] $*" >&2; fi; }
# ステップの出力（$GITHUB_OUTPUT。ローカルでは $JOB_DIR/outputs.env）
output() { echo "$1=$2" >> "${GITHUB_OUTPUT:-$JOB_DIR/outputs.env}"; echo "$1=$2"; }
cli() { npm run -s cli -- "$@"; }
jst_date() { node -e 'console.log(new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Tokyo",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date()))'; }
# JSON のファイルから値を1つ（jq を使わない。ローカルの Git Bash に jq が無い）
json_get() { node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const v=process.argv[2].split(".").reduce((o,k)=>o==null?o:o[k],j);console.log(v==null?"":typeof v==="object"?JSON.stringify(v):String(v))' "$1" "$2"; }

if [ -n "$R2_PREFIX" ] && ! [[ "$R2_PREFIX" =~ ^([a-z0-9_-]+/)+$ ]]; then
  err "R2_PREFIX が不正: $R2_PREFIX（例 test/。英小文字・数字・_ - の名前を / で区切り、/ で終わる）"; exit 1
fi

# ─── R2 との出し入れ（AWS CLI か、ローカルのフォルダ。docs/workflows.md 2-2） ───

r2_path() { echo "$R2_LOCAL_DIR/$R2_PREFIX$1"; }
aws_r2() {
  AWS_ACCESS_KEY_ID="${R2_ACCESS_KEY_ID:?R2_ACCESS_KEY_ID が無い}" AWS_SECRET_ACCESS_KEY="${R2_SECRET_ACCESS_KEY:?R2_SECRET_ACCESS_KEY が無い}" \
    AWS_DEFAULT_REGION=auto aws "$@" --endpoint-url "https://${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID が無い}.r2.cloudflarestorage.com" --region auto
}
s3url() { echo "s3://${R2_BUCKET:?R2_BUCKET が無い}/$R2_PREFIX$1"; }

# メタデータを {"Metadata": {...}} の形で OUT に書く。0 = ある・1 = 無い・2 = 読めない（通信など）
r2_head() {
  local key="$1" out="$2"
  if [ -n "${R2_LOCAL_DIR:-}" ]; then
    local p; p="$(r2_path "$key")"
    [ -f "$p" ] || return 1
    if [ -f "$p.meta.json" ]; then node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(JSON.stringify({Metadata:j.Metadata??j}))' "$p.meta.json" > "$out"
    else echo '{"Metadata":{}}' > "$out"; fi
    return 0
  fi
  local e="$JOB_DIR/head.err"
  if aws_r2 s3api head-object --bucket "${R2_BUCKET:?}" --key "$R2_PREFIX$key" > "$out" 2> "$e"; then return 0; fi
  if grep -Eq '\b(404|Not Found|NoSuchKey)\b' "$e"; then return 1; fi
  cat "$e" >&2; return 2
}
r2_get() {
  if [ -n "${R2_LOCAL_DIR:-}" ]; then cp "$(r2_path "$1")" "$2"; else aws_r2 s3 cp "$(s3url "$1")" "$2" --only-show-errors; fi
}
# r2_put SRC KEY [META.json]。メタデータは db:pack の meta.json（平らな文字列の対）。S3 と同じく、付けなければ前のメタデータは残らない
r2_put() {
  local src="$1" key="$2" meta="${3:-}"
  if [ -n "${R2_LOCAL_DIR:-}" ]; then
    local p; p="$(r2_path "$key")"; mkdir -p "$(dirname "$p")"
    cp "$src" "$p.tmp" && mv "$p.tmp" "$p"
    if [ -n "$meta" ]; then node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));require("fs").writeFileSync(process.argv[2],JSON.stringify({Metadata:j},null,2)+"\n")' "$meta" "$p.meta.json"
    else rm -f "$p.meta.json"; fi
    return 0
  fi
  if [ -n "$meta" ]; then
    aws_r2 s3 cp "$src" "$(s3url "$key")" --only-show-errors --metadata "$(node -e 'console.log(JSON.stringify(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))))' "$meta")"
  else
    aws_r2 s3 cp "$src" "$(s3url "$key")" --only-show-errors
  fi
}
# R2 の中での写し（メタデータも写る）
r2_copy() {
  if [ -n "${R2_LOCAL_DIR:-}" ]; then
    local a b; a="$(r2_path "$1")"; b="$(r2_path "$2")"; mkdir -p "$(dirname "$b")"
    cp "$a" "$b"; if [ -f "$a.meta.json" ]; then cp "$a.meta.json" "$b.meta.json"; fi
  else aws_r2 s3 cp "$(s3url "$1")" "$(s3url "$2")" --only-show-errors; fi
}
# フォルダの中身をキーの接頭辞の下へ（生レスポンス）
r2_put_tree() {
  if [ -n "${R2_LOCAL_DIR:-}" ]; then mkdir -p "$(r2_path "$2")" && cp -r "$1"/. "$(r2_path "$2")"
  else aws_r2 s3 cp "$1" "$(s3url "$2")" --recursive --only-show-errors; fi
}

# ─── ステップ ───
# 関数に包んで最後に呼ぶ（bash はファイルを少しずつ読むので、走っている途中にこのファイルが書き換わると続きが崩れる。関数なら呼ぶ前に全部読む）
main() {
case "$STEP" in

  # 最初のステップ。入力の組み合わせを確かめ、この回の始まりの時刻を残す
  start)
    if [ -n "$R2_PREFIX" ] && [ "$TARGET" = "production" ]; then
      err "R2_PREFIX（$R2_PREFIX）は試しの置き場所なので、本番にはアップロードしない。手動で起動し、target を preview にする"; exit 1
    fi
    if [ "$TARGET" != "production" ] && [ "$TARGET" != "preview" ]; then err "TARGET が不正: $TARGET"; exit 1; fi
    rm -f "$JOB_DIR/outputs.env"
    output started_at "$(node -e 'console.log(new Date().toISOString())')"
    if [ -n "${R2_LOCAL_DIR:-}" ]; then where="フォルダ $R2_LOCAL_DIR"; else where="バケット ${R2_BUCKET:-?}"; fi
    echo "R2: $where 置き場所: ${R2_PREFIX:-（本物）} アップロード先: $TARGET 書く人: $WRITER"
    ;;

  # 保険の cron（docs/workflows.md 5-2）。R2 の DB のメタデータだけを見て、日次が20時間以内に書いていれば流さない
  due)
    rc=0; r2_head db/db.sqlite.gz "$JOB_DIR/due-head.json" || rc=$?
    if [ "$rc" = 2 ]; then warn "R2 のメタデータを読めない。日次として流す"; output due true; exit 0; fi
    if [ "$rc" = 1 ]; then output due true; exit 0; fi
    output due "$(cli job:due --meta "$JOB_DIR/due-head.json" | sed -n 's/^due=//p')"
    ;;

  # 2-3 DB の取得と検査。外れたら終了コード 1（巡回もアップロードもしない）
  pull)
    if [ -e "$DB" ]; then err "$DB がもうある。上書きしない（ランナーはまっさら。ローカルは DATA_DIR を空のフォルダにする）"; exit 1; fi
    rm -f "$JOB_DIR/observed.json" "$JOB_DIR/head.json" "$JOB_DIR/pulled.sqlite.gz"
    rc=0; r2_head db/db.sqlite.gz "$JOB_DIR/head.json" || rc=$?
    if [ "$rc" = 1 ]; then err "R2 に ${R2_PREFIX}db/db.sqlite.gz が無い。空の DB を作って始めない（最初の1回は docs/deploy.md の 1-D の手で置く）"; exit 1; fi
    if [ "$rc" != 0 ]; then err "R2 の ${R2_PREFIX}db/db.sqlite.gz のメタデータを読めない"; exit 1; fi
    r2_get db/db.sqlite.gz "$JOB_DIR/pulled.sqlite.gz"
    gzip -t "$JOB_DIR/pulled.sqlite.gz" || { err "gzip が壊れている"; exit 1; }
    mkdir -p "$DATA_DIR"
    rm -f "$DB-wal" "$DB-shm"
    gzip -dc "$JOB_DIR/pulled.sqlite.gz" > "$DB.tmp" && mv "$DB.tmp" "$DB"
    accept=(); if [ "${ACCEPT_DB:-false}" = "true" ]; then accept=(--accept); warn "accept_db: sha256 と行数の照合を飛ばす"; fi
    cli db:check --db "$DB" --gz "$JOB_DIR/pulled.sqlite.gz" --expect "$JOB_DIR/head.json" --observed "$JOB_DIR/observed.json" "${accept[@]}"
    rm -f "$JOB_DIR/pulled.sqlite.gz"
    ;;

  roster)       cli roster ;;
  crawl)        cli crawl:daily ;;
  refresh)      cli refresh ;;
  candidates)   cli candidates:select; cli candidates:fetch ;;
  # 6 の 1〜3（受け箱から移すのは settle。DB の書き戻しのあと）
  ai-ingest)
    rm -f "$JOB_DIR/ai-result.json"
    cli ai:ingest --remote "$REMOTE" --result "$JOB_DIR/ai-result.json"
    ;;
  resolve)      cli resolve --limit "${RESOLVE_LIMIT:-400}" ;;
  resolve-all)  cli resolve --all ;;
  site-data)    cli site:data ;;

  # 2-4 DB の書き戻し。日次はその日（日本時間）の最初なら先に db/backup/ へ写す。行を消さない表が減っていたら db:pack が何も書かずに 1
  push)
    [ -f "$JOB_DIR/observed.json" ] || { err "取得したときの値（observed.json）が無い。pull が通っていない"; exit 1; }
    if [ "$WRITER" = "daily" ]; then
      bkey="db/backup/$(jst_date).sqlite.gz"
      rc=0; r2_head "$bkey" "$JOB_DIR/backup-head.json" || rc=$?
      if [ "$rc" = 1 ]; then
        if r2_copy db/db.sqlite.gz "$bkey"; then echo "前の DB を $R2_PREFIX$bkey に写した"; else warn "$bkey への写しに失敗した（書き戻しは続ける）"; fi
      elif [ "$rc" = 2 ]; then warn "$bkey があるか確かめられない（写さずに書き戻しを続ける）"
      else echo "$R2_PREFIX$bkey はもうある（その日の最初の書き戻しではない）"; fi
    fi
    rm -rf "$JOB_DIR/out"
    cli db:pack --db "$DB" --against "$JOB_DIR/observed.json" --out "$JOB_DIR/out" --run-id "$RUN_ID" --writer "$WRITER"
    r2_put "$JOB_DIR/out/db.sqlite.gz" db/db.sqlite.gz "$JOB_DIR/out/meta.json"
    # 置いたメタデータを読み直し、sha256 が付いているか確かめる（付け損ねると次の回の db:check が止まる）
    r2_head db/db.sqlite.gz "$JOB_DIR/pushed-head.json"
    want="$(json_get "$JOB_DIR/out/meta.json" sha256)"; got="$(json_get "$JOB_DIR/pushed-head.json" Metadata.sha256)"
    if [ "$want" != "$got" ]; then err "置いた DB のメタデータの sha256 が合わない（$want / ${got:-無い}）"; exit 1; fi
    echo "DB を ${R2_PREFIX}db/db.sqlite.gz に書き戻した（sha256 ${want:0:12}…）"
    ;;

  # 6 の 4〜5。push が通ったときだけ（yml の if）
  settle)
    if [ ! -f "$JOB_DIR/ai-result.json" ]; then echo "取り込みの結果が無い（ai:ingest が動いていないか、途中で止まった。受け箱に残る）"; exit 0; fi
    cli ai:ingest --settle "$JOB_DIR/ai-result.json" --remote "$REMOTE"
    ;;

  # 生レスポンス（data/raw/<日付>/<run_id>.jsonl.gz）を raw/ へ。この回のファイルだけ（ランナーはまっさら）
  raw)
    if [ -d "$DATA_DIR/raw" ] && [ -n "$(ls -A "$DATA_DIR/raw" 2>/dev/null)" ]; then
      r2_put_tree "$DATA_DIR/raw" raw/
      echo "生レスポンス $(find "$DATA_DIR/raw" -type f | wc -l) ファイルを ${R2_PREFIX}raw/ に置いた"
    else echo "生レスポンスが無い"; fi
    ;;

  # 2-6 指紋。site-data.json が無ければ site:fingerprint が 1（ビルドとアップロードをしない）。build=true|false を出す
  fingerprint)
    commit="${COMMIT:-${GITHUB_SHA:-$(git rev-parse HEAD)}}"
    fp="$(cli site:fingerprint --file "$SITE_DATA" --commit "$commit" | sed -n 's/^fingerprint=//p')"
    [ -n "$fp" ] || { err "指紋を作れない"; exit 1; }
    output fingerprint "$fp"
    build=true
    if [ "$TARGET" = "production" ] && [ "${FORCE:-false}" != "true" ]; then
      rc=0; r2_head site/last-deploy.json "$JOB_DIR/last-deploy-head.json" || rc=$?
      if [ "$rc" = 0 ]; then
        r2_get site/last-deploy.json "$JOB_DIR/last-deploy.json"
        if [ "$(json_get "$JOB_DIR/last-deploy.json" fingerprint)" = "$fp" ]; then build=false; echo "本番の指紋と同じ。ビルドとアップロードを飛ばす"; fi
      fi
    fi
    output build "$build"
    ;;

  # 2-7 ビルドと dist/ の確認（og:image のキャッシュは yml の actions/cache で戻す）
  build)
    rm -rf dist
    npm run site:build
    ;;
  check-dist)
    n=$(find dist -type f | wc -l)
    echo "dist/ のファイル ${n}"
    if [ "$n" -ge 18000 ]; then err "dist/ のファイルが $n（18,000 で止める。上限 20,000）"; exit 1; fi
    if [ "$n" -ge 15000 ]; then warn "dist/ のファイルが $n（15,000 で警告。上限 20,000）"; fi
    big="$(find dist -type f -size +25M)"
    if [ -n "$big" ]; then err "25MiB を超えるファイル: $big"; exit 1; fi
    r=0; [ -f dist/_redirects ] && r=$(wc -l < dist/_redirects)
    echo "_redirects ${r} 行"
    if [ "$r" -ge 1600 ]; then warn "_redirects が $r 行（1,600 で警告。2,000 を超えるとビルドが失敗する。docs/workflows.md 11-6）"; fi
    [ -f dist/404.html ] || { err "dist/404.html が無い（not_found_handling が 404 を返せない）"; exit 1; }
    ;;

  # 本番へのアップロードが通ったあとだけ（yml の if）。プレビューでは書かない
  last-deploy)
    [ "$TARGET" = "production" ] || { echo "プレビューなので書かない"; exit 0; }
    [ -z "$R2_PREFIX" ] || { err "試しの置き場所では本番に上げない"; exit 1; }
    node -e 'require("fs").writeFileSync(process.argv[1],JSON.stringify({fingerprint:process.argv[2],commit:process.argv[3],run_id:process.argv[4],deployed_at:new Date().toISOString()},null,2)+"\n")' \
      "$JOB_DIR/last-deploy.json" "${FINGERPRINT:?FINGERPRINT が無い}" "${COMMIT:-${GITHUB_SHA:-$(git rev-parse HEAD)}}" "$RUN_ID"
    r2_put "$JOB_DIR/last-deploy.json" site/last-deploy.json
    ;;

  # 2-9 結果の書き出し。概要欄・判定の根拠は出さない（runs:summary は数とエラーの文だけ）
  summary)
    out="${GITHUB_STEP_SUMMARY:-$JOB_DIR/summary.md}"
    cli runs:summary --since "${JOB_STARTED_AT:?JOB_STARTED_AT が無い}" --out "$out"
    {
      echo ""
      echo "- 置き場所: ${R2_PREFIX:-（本物）}・アップロード先: $TARGET・書く人: $WRITER"
      [ -f "$JOB_DIR/out/meta.json" ] && echo "- 書き戻した DB: rows \`$(json_get "$JOB_DIR/out/meta.json" rows)\`"
      [ -f "$JOB_DIR/ai-result.json" ] && echo "- AI の答えの取り込み: batch $(json_get "$JOB_DIR/ai-result.json" batches | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const b=JSON.parse(s||"[]");console.log(b.map(x=>`${x.batch}=${x.outcome}`).join("・")||"0")})')"
    } >> "$out"
    ;;

  # 最初の1回だけ（docs/deploy.md 1-D）。SEED_DB（DB の写し。本体の DB を直接指さない）を db:pack --initial で梱包し、メタデータ付きで db/db.sqlite.gz に置く。
  # もう置いてあれば SEED_OVERWRITE=true でなければ止める。ローカルの AWS CLI か R2_LOCAL_DIR で動かす（ワークフローからは呼ばない）
  seed)
    src="${SEED_DB:?SEED_DB（置く DB の写し）を指定してください}"
    rc=0; r2_head db/db.sqlite.gz "$JOB_DIR/seed-head.json" || rc=$?
    if [ "$rc" = 0 ] && [ "${SEED_OVERWRITE:-false}" != "true" ]; then err "${R2_PREFIX}db/db.sqlite.gz はもうある。上書きするなら SEED_OVERWRITE=true"; exit 1; fi
    if [ "$rc" = 2 ]; then err "R2 を読めない"; exit 1; fi
    rm -rf "$JOB_DIR/seed-out"
    cli db:pack --db "$src" --initial --out "$JOB_DIR/seed-out" --run-id "seed-$(date -u +%Y%m%dT%H%M%S)" --writer manual
    r2_put "$JOB_DIR/seed-out/db.sqlite.gz" db/db.sqlite.gz "$JOB_DIR/seed-out/meta.json"
    r2_head db/db.sqlite.gz "$JOB_DIR/seed-head.json"
    want="$(json_get "$JOB_DIR/seed-out/meta.json" sha256)"; got="$(json_get "$JOB_DIR/seed-head.json" Metadata.sha256)"
    [ "$want" = "$got" ] || { err "置いた DB のメタデータの sha256 が合わない（$want / ${got:-無い}）"; exit 1; }
    echo "${R2_PREFIX}db/db.sqlite.gz に置いた（sha256 ${want:0:12}…・rows $(json_get "$JOB_DIR/seed-out/meta.json" rows)）"
    ;;

  *) err "知らないステップ: $STEP"; exit 1 ;;
esac
}
main; exit $?
