#!/usr/bin/env bash
# 本番へのリリース（#452。ビルド・push を CD へ移した分割は #673）。AWS の資格情報が入った端末で流す。
# **費用が発生し、AWS にリソースを作る。**
#
#   1. ECR のリポジトリと、CD（.github/workflows/cd.yml）用の IAM ロール一式を作る（初回はまだ無い。#671）
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
# 前段（初回だけ）: 手順 1 で workspace-chat-cd ロールができたら、`terraform -chdir=infra/production output -raw cd_role_arn`
# の値を、GitHub の Secrets に AWS_CD_ROLE_ARN という名前で設定する。設定するまで CD（cd.yml）は動かない。
#
# 使い方:
#   TF_STATE_BUCKET=$(terraform -chdir=infra/bootstrap output -raw state_bucket) \
#     IMAGE_TAG=<release ブランチで CD が push した短い SHA> bash scripts/release.sh
#   IMAGE_TAG は release ブランチの `git rev-parse --short HEAD`、または CD（cd.yml）の実行結果から読む。
#
# 前提: aws（資格情報と ap-northeast-1）・terraform・node と npm。
# **docker は要らない**——ビルド・push は CD（GitHub Actions）が行うため、この端末に arm64 のクロスビルド環境は不要になった（#673）。
#
# **秘密の値を入れ替えるときは、この手順ではない。** 要件定義書 4.2「秘密の値が漏れた疑いがあるとき」の手順による
# （前置きの形——init -backend-config と TF_VAR_* の渡し方——は同じだが、**api を止める段と、入れ替わったことを確かめる段がある**）。
set -euo pipefail

cd "$(dirname "$0")/.."

fail() {
  echo "NG: $*" >&2
  exit 1
}

: "${TF_STATE_BUCKET:?state のバケット名を TF_STATE_BUCKET に渡す}"
: "${IMAGE_TAG:?イメージのタグを IMAGE_TAG に渡す（release ブランチで CD が push したタグ）}"

export TF_VAR_image_tag="$IMAGE_TAG"

tf() {
  terraform -chdir=infra/production "$@"
}

tf init -input=false -backend-config="bucket=$TF_STATE_BUCKET" >/dev/null

echo "== 1. ECR のリポジトリと CD 用の IAM ロール一式"
tf apply -input=false \
  -target=aws_ecr_repository.api \
  -target=aws_ecr_repository.migrate \
  -target=aws_iam_openid_connect_provider.github_actions \
  -target=aws_iam_role_policy.cd_ecr
api_repository=$(tf output -raw ecr_api_repository_url)
migrate_repository=$(tf output -raw ecr_migrate_repository_url)
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
migrate_task_definition=$(tf output -raw migrate_task_definition_arn)
network_configuration=$(tf output -raw migrate_network_configuration)
task=$(aws ecs run-task --cluster "$cluster" --task-definition "$migrate_task_definition" --launch-type FARGATE \
  --network-configuration "$network_configuration" --query 'tasks[0].taskArn' --output text)
if [ -z "$task" ] || [ "$task" = "None" ]; then
  fail "マイグレーションのタスクを起動できない"
fi
aws ecs wait tasks-stopped --cluster "$cluster" --tasks "$task"
exit_code=$(aws ecs describe-tasks --cluster "$cluster" --tasks "$task" \
  --query 'tasks[0].containers[0].exitCode' --output text)
[ "$exit_code" = "0" ] || fail "マイグレーションが終了コード $exit_code で終わった（ロググループ /ecs/workspace-chat-migrate を見る）"

echo "== 5. 残りを apply し、api のサービスが安定するまで待つ"
tf apply -input=false
aws ecs wait services-stable --cluster "$cluster" --services "$(tf output -raw ecs_service_name)"

echo "== 6. web を置く"
npm ci --no-audit --no-fund
npm run build -w @workspace-chat/shared
npm run build -w @workspace-chat/web
# 踏むと壊れる: 置く順番を変えない（#604）。古い資産を消すのは、index.html を no-cache で置き直し、無効化が終わった後にする。
# 先に消すと、ブラウザや CloudFront に残った古い index.html が消えた /assets/index-<hash>.js を読みに行き、画面が出ない。
# index.html に Cache-Control を付けないと、ブラウザが Last-Modified から推定した間だけ古いものを使い回す（RFC 9111 4.2.2）。
web_bucket=$(tf output -raw web_bucket)
aws s3 sync apps/web/dist "s3://$web_bucket" --exclude index.html
aws s3 cp apps/web/dist/index.html "s3://$web_bucket/index.html" --cache-control no-cache --content-type text/html
invalidation=$(aws cloudfront create-invalidation --distribution-id "$(tf output -raw cloudfront_distribution_id)" --paths '/*'   --query 'Invalidation.Id' --output text)
aws cloudfront wait invalidation-completed --distribution-id "$(tf output -raw cloudfront_distribution_id)" --id "$invalidation"
aws s3 sync apps/web/dist "s3://$web_bucket" --delete --exclude index.html

echo "公開した: $(tf output -raw web_url)"
