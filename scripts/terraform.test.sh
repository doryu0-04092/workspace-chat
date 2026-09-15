#!/usr/bin/env bash
# Terraform の定義（infra/ の下の構成）を、AWS に接続せずに確かめる（#452）。
#
#   1. 整形（terraform fmt -check）
#   2. 構成ごとに、プロバイダーがロックのとおりに入り（init -backend=false -lockfile=readonly）、構文が通る（validate）
#   3. CloudFront Functions のコード（infra/production/functions/）が期待どおりに書き換える（scripts/cloudfront-functions.test.mjs）
#
# -lockfile=readonly: .terraform.lock.hcl に無いプロバイダー・この OS のハッシュが無いときに、ロックを書き換えて通さず落とす。
# **確認が空回りしたときにも落ちる形にする**: 追跡中の構成が1つも無い・ロックが追跡されていない構成があるときは落とす。
set -euo pipefail

cd "$(dirname "$0")/.."

fail() {
  echo "NG: $*" >&2
  exit 1
}

mapfile -t dirs < <(git ls-files -- ':(glob)infra/**/*.tf' | xargs -r -n1 dirname | sort -u)
[ "${#dirs[@]}" -gt 0 ] || fail "infra/ の下に追跡中の .tf が無い"

command -v terraform >/dev/null 2>&1 || fail "terraform が見つからない（技術スタックの版の terraform を入れる）"

echo "== 1. 整形（terraform fmt -check）"
# fmt -check は、整形の差分があるとそのファイル名を標準出力に並べて落ち、構文の誤りなどでは標準エラーに理由を出して落ちる。
# 並んだファイル名の有無で案内を分け、原因を決めつけない。
fmt_status=0
unformatted=$(terraform fmt -check -recursive infra) || fmt_status=$?
if [ "$fmt_status" -ne 0 ]; then
  [ -z "$unformatted" ] || fail "整形されていない .tf がある（terraform fmt -recursive infra で直す）: $(echo "$unformatted" | tr '\n' ' ')"
  fail "terraform fmt -check が終了コード $fmt_status で落ちた（整形の差分は出ていない。上に出たエラーを見る）"
fi

echo "== 2. プロバイダーのロックと構文（init -backend=false -lockfile=readonly / validate）"
for dir in "${dirs[@]}"; do
  echo "-- $dir"
  git ls-files --error-unmatch -- "$dir/.terraform.lock.hcl" >/dev/null 2>&1 || fail "$dir/.terraform.lock.hcl が追跡されていない"
  terraform -chdir="$dir" init -backend=false -lockfile=readonly -input=false -no-color >/dev/null || fail "$dir の init が通らない"
  terraform -chdir="$dir" validate -no-color || fail "$dir の validate が通らない"
done

echo "== 3. CloudFront Functions のコード"
node scripts/cloudfront-functions.test.mjs || fail "CloudFront Functions の検査が通らない"

echo "すべての構成が通った（${#dirs[@]} 件）"
