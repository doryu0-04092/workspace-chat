#!/usr/bin/env bash
# Terraform の定義（infra/ の下の構成）を、AWS に接続せずに確かめる（#452）。
#
#   1. 整形（terraform fmt -check）
#   2. 構成ごとに、プロバイダーがロックのとおりに入り（init -backend=false -lockfile=readonly）、構文が通る（validate）
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

echo "== 1. 整形（terraform fmt -check）"
terraform fmt -check -recursive infra || fail "整形されていない .tf がある（terraform fmt -recursive infra で直す）"

echo "== 2. プロバイダーのロックと構文（init -backend=false -lockfile=readonly / validate）"
for dir in "${dirs[@]}"; do
  echo "-- $dir"
  git ls-files --error-unmatch -- "$dir/.terraform.lock.hcl" >/dev/null 2>&1 || fail "$dir/.terraform.lock.hcl が追跡されていない"
  terraform -chdir="$dir" init -backend=false -lockfile=readonly -input=false -no-color >/dev/null || fail "$dir の init が通らない"
  terraform -chdir="$dir" validate -no-color || fail "$dir の validate が通らない"
done

echo "すべての構成が通った（${#dirs[@]} 件）"
