#!/usr/bin/env bash
# 本番・ステージングへのリリース（#452。ビルド・push を CD へ移した分割は #673。環境の指定は #686）。AWS の資格情報が入った端末で流す。
# **費用が発生し、AWS にリソースを作る。**
#
# 環境は ENVIRONMENT（production か staging）で選ぶ。どちらも infra/production の同じ構成を当て、
# Terraform の workspace（production は default、staging は staging）で state と資源の名前が分かれる（main.tf の locals）。
# workspace は手元に残らない TF_WORKSPACE で選ぶ（`terraform workspace select` は .terraform/ に残り、
# その後に流す本番の手順——要件定義書 4.2——をステージングに当ててしまうため）。
#
#   1. 共有の層（infra/shared。OIDC・ECR・CD（.github/workflows/cd.yml）のロール）を apply する（初回は作る。2回目以降は差分が無い。#685）
#   2. IMAGE_TAG のイメージが ECR に既に push されていることを確かめる
#      （ビルド・push は CD が main への push をトリガーに自動で行う。#672。このスクリプトはもう行わない）
#   3. マイグレーション用のタスク定義を新しいタグにする（apply -target。依存する RDS・パラメータなども、無ければここで作る）
#   4. マイグレーションを run-task で1回動かし、終わるまで待って終了コードを確かめる
#      ——新しいタスク定義に切り替える前に流す（技術スタックのコンテナの行。#274）
#   5. 残りをすべて apply する（api のタスク定義が替わり、サービスがタスクを入れ替える）。サービスが安定するまで待つ
#   6. web をビルドして web のバケットに置き、CloudFront のキャッシュを消す
#
# apply は -auto-approve を付けない。**毎回プランを見て yes と打ってから進む。**
#
# 前段（初回だけ）: state のバケットを作る。この構成の state は手元のファイル（infra/bootstrap/terraform.tfstate。追跡しない）に置くため、
# 流した端末の外に消さずに残す（失うとバケットを Terraform から操作できなくなり、取り込み直しが要る。要件定義書 4.2「復旧手順」）。
#   terraform -chdir=infra/bootstrap init
#   terraform -chdir=infra/bootstrap apply
#
# 前段（初回だけ）: 手順 1 で workspace-chat-cd ロールができたら、`terraform -chdir=infra/shared output -raw cd_role_arn`
# の値を、GitHub の Secrets に AWS_CD_ROLE_ARN という名前で設定する。設定するまで CD（cd.yml）は動かない。
# CD がイメージを push するのは、この設定の後に main へマージしたときである（手順 2 はそのイメージを探す）。
#
# 前段（環境ごとに初回だけ）: CloudFront の署名鍵の対を作る（`bash scripts/cloudfront-signing-key.sh <環境>`）。
#
# 使い方:
#   TF_STATE_BUCKET=$(terraform -chdir=infra/bootstrap output -raw state_bucket) \
#     ENVIRONMENT=production IMAGE_TAG=<release ブランチで CD が push した短い SHA> bash scripts/release.sh
#   本番の IMAGE_TAG は release ブランチの `git rev-parse --short HEAD`、または CD（cd.yml）の実行結果から読む。
#   ステージングの IMAGE_TAG は main の `git rev-parse --short HEAD` を渡す。
#   **ステージングは検証が終わったら destroy する**（費用。README の CD の節）。
#
# 前提: aws（資格情報と ap-northeast-1）・terraform・node と npm。
# **docker は要らない**——ビルド・push は CD（GitHub Actions）が行うため、この端末に arm64 のクロスビルド環境は不要になった（#673）。
#
# **秘密の値を入れ替えるときは、この手順ではない。** 要件定義書 4.2「秘密の値が漏れた疑いがあるとき」の手順による
# （前置きの形——init -backend-config と TF_VAR_* の渡し方——は同じだが、**api を止める段と、入れ替わったことを確かめる段がある**）。
set -euo pipefail

cd "$(dirname "$0")/.."
# shellcheck source=scripts/lib/deploy.sh
source scripts/lib/deploy.sh

fail() {
  echo "NG: $*" >&2
  exit 1
}

: "${TF_STATE_BUCKET:?state のバケット名を TF_STATE_BUCKET に渡す}"
: "${ENVIRONMENT:?環境（production か staging）を ENVIRONMENT に渡す}"
: "${IMAGE_TAG:?イメージのタグを IMAGE_TAG に渡す（CD が push したタグ）}"

# 踏むと壊れる: workspace と環境の対応は infra/production/main.tf の locals（environment）と揃える。
case "$ENVIRONMENT" in
  production) workspace=default ;;
  staging) workspace=staging ;;
  *) fail "ENVIRONMENT は production か staging にする: $ENVIRONMENT" ;;
esac

export TF_VAR_image_tag="$IMAGE_TAG"

tf() {
  TF_WORKSPACE="$workspace" terraform -chdir=infra/production "$@"
}

tf_shared() {
  terraform -chdir=infra/shared "$@"
}

# init は workspace を指定せずに流す（まだ無い workspace を TF_WORKSPACE で指すと init が進めない）。
terraform -chdir=infra/production init -input=false -backend-config="bucket=$TF_STATE_BUCKET" >/dev/null
tf_shared init -input=false -backend-config="bucket=$TF_STATE_BUCKET" >/dev/null

# ステージングの workspace は初回だけ作る。`workspace new` は作った workspace を選んだまま残すため、default に戻す。
if [ "$workspace" != default ] &&
  ! terraform -chdir=infra/production workspace list | sed 's/^[* ]*//' | grep -qx "$workspace"; then
  terraform -chdir=infra/production workspace new "$workspace" >/dev/null
  terraform -chdir=infra/production workspace select default >/dev/null
fi
[ "$(tf workspace show)" = "$workspace" ] || fail "workspace が $workspace にならない"
echo "== 環境: $ENVIRONMENT（workspace: $workspace）"

echo "== 1. 共有の層（OIDC・ECR・CD のロール）"
tf_shared apply -input=false
api_repository=$(tf_shared output -raw ecr_api_repository_url)
migrate_repository=$(tf_shared output -raw ecr_migrate_repository_url)
api_repository_name=${api_repository##*/}
migrate_repository_name=${migrate_repository##*/}

echo "== 2. IMAGE_TAG のイメージが ECR に push 済みであることを確かめる"
# ビルド・push は CD（main への push をトリガーに動く .github/workflows/cd.yml）が行う。#672。
# ここで見つからないのは、CD がまだ動いていない・失敗した・IMAGE_TAG を取り違えたのいずれかである。
aws ecr describe-images --repository-name "$api_repository_name" --image-ids "imageTag=$IMAGE_TAG" >/dev/null 2>&1 ||
  fail "ECR に $api_repository_name:$IMAGE_TAG が無い（CD（cd.yml）がこのタグを push し終えているか確かめる）"
aws ecr describe-images --repository-name "$migrate_repository_name" --image-ids "imageTag=$IMAGE_TAG" >/dev/null 2>&1 ||
  fail "ECR に $migrate_repository_name:$IMAGE_TAG が無い（CD（cd.yml）がこのタグを push し終えているか確かめる）"

echo "== 3. マイグレーション用のタスク定義を新しいタグにし、run-task に要るものを揃える"
# -target はそのリソースと依存だけを作る。マイグレーション用のタスク定義の依存（ロール・ECR・ロググループ・DATABASE_URL →
# RDS）に入らないものも並べる: クラスター・パブリックサブネットとその経路（イメージの取得）・タスクのセキュリティグループと
# 送信の規則・RDS への受信の規則・ロールにぶら下がるポリシー（実行ロールの ECR とログの管理ポリシー・パラメータの読み出し、
# マイグレーションのタスクロールの ECS Exec）。初回のリリースでは、これが無いと手順 4 の run-task が成り立たない。
# api のタスク定義とサービスは手順 5 に残す（マイグレーションの前に新しいタスク定義へ切り替えない）。
# 踏むと壊れる: run-task の前提（infra/production/network.tf のセキュリティグループの規則・compute.tf の
# IAM のロール・ポリシーなど）を足したら、この -target の一覧にも足す。足さないと、初回のリリースで
# 手順 4 の run-task が前提の無いまま失敗する。
tf apply -input=false \
  -target=aws_ecs_task_definition.migrate \
  -target=aws_ecs_cluster.main \
  -target=aws_route_table_association.public \
  -target=aws_vpc_security_group_egress_rule.task_all \
  -target=aws_vpc_security_group_ingress_rule.db_from_task \
  -target=aws_iam_role_policy_attachment.task_execution_managed \
  -target=aws_iam_role_policy.task_execution_parameters \
  -target=aws_iam_role_policy.task_exec_command

echo "== 4. マイグレーションを流す"
cluster=$(tf output -raw ecs_cluster_name)
run_migration "$cluster" "$(tf output -raw migrate_task_definition_arn)" "$(tf output -raw migrate_network_configuration)"

echo "== 5. 残りを apply し、api のサービスが安定するまで待つ"
tf apply -input=false
aws ecs wait services-stable --cluster "$cluster" --services "$(tf output -raw ecs_service_name)"

echo "== 6. web を置く"
npm ci --no-audit --no-fund
npm run build -w @workspace-chat/shared
npm run build -w @workspace-chat/web
# 置く順番の決まり（#604）は scripts/lib/deploy.sh の deploy_web にある。
deploy_web "$(tf output -raw web_bucket)" "$(tf output -raw cloudfront_distribution_id)" apps/web/dist

echo "公開した: $(tf output -raw web_url)"
