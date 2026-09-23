#!/usr/bin/env bash
# CloudFront の署名付き Cookie の鍵の対を作り、公開鍵をリポジトリへ、秘密鍵を Parameter Store へ置く（#427）。
# **最初に本番を作るときに1回、依頼側が手で流す。** Terraform は秘密鍵の値を作らず読まない（state とプランに鍵を残さない）。
#
#   bash scripts/cloudfront-signing-key.sh <production|staging> [鍵の名前（既定: signing-1）]
#
# 鍵の対は環境ごとに作る（#686）。ステージングを初めて立てる前にも1回流す。
#
# 前提: openssl と AWS CLI。AWS CLI の資格情報が本番のアカウントを向いていること。
#
# 流れ:
#   1. 秘密鍵（RSA 2048）を一時ディレクトリに作り、公開鍵を infra/production/keys/<環境>/<名前>.pem に書く
#   2. 秘密鍵を Parameter Store の SecureString（既定の鍵 aws/ssm）として置く。終わったら一時ディレクトリの秘密鍵を消す
#   3. 公開鍵を commit して PR にする。マージの後に terraform apply（キーグループに公開鍵が入り、api のタスクが秘密鍵を読む）
#
# 踏むと壊れる:
# - パラメータの名前は infra/production/compute.tf の cloudfront_private_key_parameter_name と（名前の元の規則は main.tf の local.name と同じ）、既定の鍵の名前は
#   infra/production/delivery.tf の cloudfront_signing_key_name と揃える（apps/api/src/config/api-config-infra.test.ts が照合する）
# - 暗号化の KMS の鍵を指定する引数を付けない（既定の鍵 aws/ssm で暗号化する）。実行ロールに kms:Decrypt を足していないため、別の鍵で暗号化すると api のタスクが起動しない
# - apply の前にパラメータを置く。置いていないと、api のタスクが secrets を読めずに起動しない
# - **既にパラメータがあれば止める（上書きしない）。** 動いている api と別の秘密鍵に替わり、キーペア ID と対にならない区間ができる。
#   鍵の入れ替え（漏えいの疑いを含む）は、新しい公開鍵をキーグループに足してから秘密鍵とキーペア ID を切り替える別の手順で行う（#427 の 4）
set -euo pipefail

cd "$(dirname "$0")/.."

# Git Bash（MSYS）は "/" で始まる引数を Windows のパスに書き換えるため、パラメータ名が壊れて put-parameter が断られる。
# パラメータ名の接頭辞だけを書き換えから外す（MSYS_NO_PATHCONV で全体を止めると、openssl が一時ファイルのパスを読めなくなる）。
# 前方一致なので /workspace-chat-staging も含まれる。
export MSYS2_ARG_CONV_EXCL="/workspace-chat"

fail() {
  echo "NG: $*" >&2
  exit 1
}

environment="${1:-}"
case "$environment" in
  production) prefix="workspace-chat" ;;
  staging) prefix="workspace-chat-$environment" ;;
  *) fail "1つ目の引数に環境（production か staging）を渡す" ;;
esac

name="${2:-signing-1}"
parameter="/${prefix}/CLOUDFRONT_PRIVATE_KEY"
region="ap-northeast-1"
public_key="infra/production/keys/${environment}/${name}.pem"

[[ "$name" =~ ^[a-z0-9-]+$ ]] || fail "鍵の名前は英小文字・数字・- だけにする: $name"
[ ! -e "$public_key" ] || fail "$public_key が既にある（入れ替えは別の手順で行う）"

existing="$(aws ssm describe-parameters --region "$region" \
  --parameter-filters "Key=Name,Values=${parameter}" --query 'length(Parameters)' --output text)"
[ "$existing" = "0" ] || fail "$parameter が既にある（上書きしない。入れ替えは別の手順で行う）"

umask 077
workdir="$(mktemp -d)"
private_key="${workdir}/private.pem"
cleanup() {
  rm -f "$private_key"
  rmdir "$workdir"
}
trap cleanup EXIT

openssl genrsa -out "$private_key" 2048 2>/dev/null
mkdir -p "$(dirname "$public_key")"
openssl rsa -in "$private_key" -pubout -out "$public_key" 2>/dev/null

# AWS CLI（Windows 版）は Git Bash の /tmp の形のパスを読めない。Windows の形に直して渡す。
value_path="$private_key"
if command -v cygpath >/dev/null 2>&1; then
  value_path="$(cygpath -w "$private_key")"
fi
aws ssm put-parameter --region "$region" --name "$parameter" --type SecureString \
  --value "file://${value_path}" >/dev/null

echo "公開鍵を書いた: $public_key"
echo "秘密鍵を置いた: $parameter（SecureString）"
echo "次: 公開鍵を commit して PR にし、マージの後に terraform apply する"
