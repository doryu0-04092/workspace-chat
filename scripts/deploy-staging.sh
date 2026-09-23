#!/usr/bin/env bash
# ステージングへのデプロイ（#688）。CD（.github/workflows/cd.yml）が main へのマージのたびに流す。
#
#   bash scripts/deploy-staging.sh exists   # ステージングが立っていれば true、無ければ false を出す（どちらも exit 0）
#   IMAGE_TAG=<CD が push したタグ> WEB_DIST=<ビルド済みの web> bash scripts/deploy-staging.sh deploy
#
# deploy の流れ（本番の scripts/release.sh の手順 4〜6 と同じ順）:
#   1. マイグレーション用のタスク定義を、イメージのタグだけ替えて新しい版として登録し、run-task で流す
#   2. api のタスク定義を同じく登録し、サービスをその版に切り替えて、安定するまで待つ
#   3. web を置き、CloudFront のキャッシュを消す
#
# **Terraform は流さない**（apply は常に人が行う）。ステージングの資源（クラスター・ロール・バケットなど）は、
# 人が `ENVIRONMENT=staging bash scripts/release.sh` で作る。ステージングは検証のときだけ立てるため、立っていなければ飛ばす。
#
# 代償: 人がステージングに apply するとき、TF_VAR_image_tag（release.sh の IMAGE_TAG）に古いタグを渡すと、
# ここで登録した版より古いイメージのタスク定義に戻る。ステージングへの apply では main の HEAD のタグを渡す。
#
# 踏むと壊れる: 名前は infra/production/main.tf の local.name（staging の workspace）の規則と揃える。
# CD のデプロイ用ロール（infra/shared）の権限も、この名前で絞っている。
set -euo pipefail

cd "$(dirname "$0")/.."
# shellcheck source=scripts/lib/deploy.sh
source scripts/lib/deploy.sh

name="workspace-chat-staging"
cluster="$name"
service="${name}-api"
migrate_family="${name}-migrate"

mode="${1:-}"

# クラスターの状態（無ければ None）。
# 踏むと壊れる: この呼び出しを if の条件式や $(...) の中の比較に入れない。そこでは set -e が効かず、権限不足や通信の失敗が
# 「立っていない」と同じに扱われ、デプロイ用のロールが壊れても CD が緑のまま飛ばし続ける。代入の形で呼び、失敗はその場で落とす。
cluster_status() {
  aws ecs describe-clusters --clusters "$cluster" --query 'clusters[0].status' --output text
}

# タスク定義（family か ARN）を、イメージのタグだけ替えて新しい版として登録し、その ARN を出す。
register_with_image() {
  local source=$1 work input
  work=$(mktemp -d)
  input="$work/input.json"
  aws ecs describe-task-definition --task-definition "$source" --include TAGS --output json |
    node scripts/lib/task-definition-with-image.mjs "$IMAGE_TAG" >"$input" ||
    deploy_fail "$source のイメージを差し替えられない"
  # AWS CLI（Windows 版）は Git Bash の /tmp の形のパスを読めない。手元で流すときのために Windows の形に直す。
  if command -v cygpath >/dev/null 2>&1; then
    input=$(cygpath -w "$input")
  fi
  aws ecs register-task-definition --cli-input-json "file://$input" \
    --query 'taskDefinition.taskDefinitionArn' --output text
}

case "$mode" in
  exists)
    status=$(cluster_status)
    if [ "$status" = "ACTIVE" ]; then echo true; else echo false; fi
    ;;
  deploy)
    : "${IMAGE_TAG:?イメージのタグを IMAGE_TAG に渡す（CD が push したタグ）}"
    : "${WEB_DIST:?ビルド済みの web のディレクトリを WEB_DIST に渡す}"
    status=$(cluster_status)
    if [ "$status" != "ACTIVE" ]; then
      echo "ステージングが立っていない（クラスター $cluster が無い）。デプロイを飛ばす"
      exit 0
    fi

    account=$(aws sts get-caller-identity --query Account --output text)
    api_task_definition=$(aws ecs describe-services --cluster "$cluster" --services "$service" \
      --query 'services[0].taskDefinition' --output text)
    network_configuration=$(aws ecs describe-services --cluster "$cluster" --services "$service" \
      --query 'services[0].networkConfiguration' --output json)

    echo "== 1. マイグレーション（$IMAGE_TAG）"
    migrate_task_definition=$(register_with_image "$migrate_family")
    # マイグレーションは api のサービスと同じネットワークの設定で動かす（release.sh が使う出力 migrate_network_configuration と同じ値）。
    run_migration "$cluster" "$migrate_task_definition" "$network_configuration"

    echo "== 2. api のサービスを切り替える"
    new_api_task_definition=$(register_with_image "$api_task_definition")
    aws ecs update-service --cluster "$cluster" --service "$service" \
      --task-definition "$new_api_task_definition" >/dev/null
    aws ecs wait services-stable --cluster "$cluster" --services "$service"

    echo "== 3. web を置く"
    distribution=$(aws cloudfront list-distributions \
      --query "DistributionList.Items[?Comment=='$name'].Id" --output text)
    deploy_web "${name}-web-${account}" "$distribution" "$WEB_DIST"

    echo "ステージングへ出した: $IMAGE_TAG"
    ;;
  *)
    deploy_fail "1つ目の引数に exists か deploy を渡す"
    ;;
esac
