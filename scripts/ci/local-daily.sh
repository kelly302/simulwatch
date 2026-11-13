#!/usr/bin/env bash
# 日次のワークフロー（.github/workflows/daily.yml）のステップを、同じ順・同じ「失敗したら」でローカルに通す（docs/workflows.md 13）。
# R2 の代わりにローカルのフォルダを使い、アップロード（wrangler）と og のキャッシュの出し入れ（actions/cache）だけはしない。
#
#   R2_LOCAL_DIR=data/trial-r2 DATA_DIR=data/trial scripts/ci/local-daily.sh
#
#   R2_LOCAL_DIR  R2 に見立てるフォルダ（先に db/db.sqlite.gz と db/db.sqlite.gz.meta.json を置く。R2_PREFIX があればその下）
#   DATA_DIR      この回の作業のフォルダ（空のフォルダ。ランナーと同じく DB はここに落とす。本体の data/ を指さない）
#   CRAWL         true で roster・crawl:daily・refresh・candidates を流す（YouTube のクォータを使う。既定 false）
#   TARGET        既定 preview（ローカルからはアップロードしない）
#   WRITER        既定 daily
#   OG_CACHE      og:image のキャッシュ（既定 $DATA_DIR/site/og-cache。写しを置けばビルドが速い）
# 終了コードは、ワークフローが赤になる回なら 1
set -uo pipefail
cd "$(dirname "$0")/../.."
: "${R2_LOCAL_DIR:?R2_LOCAL_DIR（R2 に見立てるフォルダ）を指定してください}"
: "${DATA_DIR:?DATA_DIR（空の作業フォルダ）を指定してください}"
case "$(cd "$DATA_DIR" 2>/dev/null && pwd -P)" in
  "$(pwd -P)/data") echo "DATA_DIR に本体の data/ を指さない" >&2; exit 1 ;;
esac
export R2_LOCAL_DIR DATA_DIR
export TARGET="${TARGET:-preview}" WRITER="${WRITER:-daily}" CRAWL="${CRAWL:-false}"
export RUN_ID="${RUN_ID:-local-$(date -u +%Y%m%dT%H%M%S)}"
export JOB_DIR="${JOB_DIR:-$DATA_DIR/job}"
J=scripts/ci/job.sh
red=0
declare -A outcome

# run <名前> <続ける true|false> <ステップ>
run() {
  local name="$1" cont="$2" step="$3"
  echo ""; echo "=== $name ==="
  local t0=$SECONDS
  if bash "$J" "$step"; then outcome[$name]=success; else
    outcome[$name]=failure
    if [ "$cont" = false ]; then red=1; fi
  fi
  echo "=== $name: ${outcome[$name]}（$((SECONDS - t0))秒）"
}
skip() { outcome[$1]=skipped; echo ""; echo "=== $1: skipped"; }
out() { sed -n "s/^$1=//p" "$JOB_DIR/outputs.env" 2>/dev/null | tail -1; }

# 関数に包んで最後に呼ぶ（走っている途中にこのファイルが書き換わっても崩れないように）
main() {
mkdir -p "$JOB_DIR"
run start false start
[ "${outcome[start]}" = success ] || exit 1
export JOB_STARTED_AT="$(out started_at)"
run pull false pull
if [ "${outcome[pull]}" = success ]; then
  if [ "$CRAWL" = true ]; then
    run roster true roster; run crawl true crawl; run refresh true refresh; run candidates true candidates
  else
    for s in roster crawl refresh candidates; do skip "$s"; done
  fi
  run ai-ingest true ai-ingest
  run resolve true resolve
  run site-data true site-data
  run push false push
  if [ "${outcome[push]}" = success ]; then run settle true settle; else skip settle; fi
  run raw true raw
  if [ $red = 0 ]; then
    run fingerprint false fingerprint
    if [ "${outcome[fingerprint]}" = success ] && [ "$(out build)" = true ]; then
      run build false build
      [ $red = 0 ] && run check-dist false check-dist
      echo ""; echo "=== upload: ローカルでは飛ばす（wrangler。設定の確かめは npx wrangler@4.155.0 deploy --dry-run）"
    fi
  fi
fi
run summary false summary
echo ""; echo "=== 結果"
for k in start pull roster crawl refresh candidates ai-ingest resolve site-data push settle raw fingerprint build check-dist summary; do
  printf '%-12s %s\n' "$k" "${outcome[$k]:-skipped}"
done
echo "ワークフローの色: $([ $red = 0 ] && echo 緑 || echo 赤)"
}
main; exit $red
