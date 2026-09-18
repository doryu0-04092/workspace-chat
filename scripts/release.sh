#!/usr/bin/env bash
# 本番へのリリース（#452）。AWS の資格情報が入った端末で流す。**費用が発生し、AWS にリソースを作る。**
#
#   1. ECR のリポジトリを作る（イメージの置き場。初回はまだ無い）
#   2. api とマイグレーション用のイメージを linux/arm64 で作り、同じタグで ECR に push する（ECS のタスクは ARM64。技術スタックのコンテナの行）
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
# 使い方:
#   TF_STATE_BUCKET=$(terraform -chdir=infra/bootstrap output -raw state_bucket) \
#     IMAGE_TAG=$(git rev-parse --short HEAD) ALARM_EMAIL=<通知先> bash scripts/release.sh
#   アラートのメールの購読は、届く確認のメールのリンクを開くまで有効にならない。
#
# 前提: aws（資格情報と ap-northeast-1）・terraform・docker（buildx で linux/arm64 を作れること——x86 の端末では QEMU の登録が要る）・node と npm。
#
# **秘密の値を入れ替えるときは、この手順ではない。** 要件定義書 4.2「秘密の値が漏れた疑いがあるとき」の手順による
# （前置きの形——init -backend-config と TF_VAR_* の渡し方——は同じだが、**api を止める段と、入れ替わったことを確かめる段がある**）。
#
#   **レジストリ（Docker Hub）へ届くこと。** 手順 2 は土台を --pull で取り直すため、手元にイメージがあっても届かなければ落ちる
#   （同じ代償は scripts/api-image.test.sh と apps/api/src/testing/postgres.ts にもある）。
#   **落ちるのは手順 1 の apply が済んだ後である**（ECR のリポジトリは作られた状態で止まる）。
set -euo pipefail

cd "$(dirname "$0")/.."

fail() {
  echo "NG: $*" >&2
  exit 1
}

: "${TF_STATE_BUCKET:?state のバケット名を TF_STATE_BUCKET に渡す}"
: "${IMAGE_TAG:?イメージのタグを IMAGE_TAG に渡す（例: git rev-parse --short HEAD）}"
: "${ALARM_EMAIL:?アラートの通知先を ALARM_EMAIL に渡す}"

export TF_VAR_image_tag="$IMAGE_TAG"
export TF_VAR_alarm_email="$ALARM_EMAIL"

tf() {
  terraform -chdir=infra/production "$@"
}

tf init -input=false -backend-config="bucket=$TF_STATE_BUCKET" >/dev/null

echo "== 1. ECR のリポジトリ"
tf apply -input=false -target=aws_ecr_repository.api -target=aws_ecr_repository.migrate
api_repository=$(tf output -raw ecr_api_repository_url)
migrate_repository=$(tf output -raw ecr_migrate_repository_url)
registry=${api_repository%%/*}
aws ecr get-login-password | docker login --username AWS --password-stdin "$registry" >/dev/null

echo "== 2. イメージ（linux/arm64）を作り、ARM64 で動くことを確かめてから push する"
# ARM64 で動くことは CI では確かめていない（CI の code は amd64 のイメージで scripts/api-image.test.sh を回す）。
# push の前にここで、ネイティブモジュール（argon2）・Prisma の CLI・psql が ARM64 のイメージの中で動くことを見る。
# --pull: 土台（apps/api/Dockerfile の NODE_IMAGE。タグで指す）を毎回レジストリから取り直す。無いと手元に残った古い土台で本番のイメージを作り、
# CI（scripts/api-image.test.sh も --pull）が確かめた土台とずれる。
# **土台は Dependabot で追わず、同じタグの中の更新をこの --pull で取り込むと決めている**（理由は .github/dependabot.yml の末尾）。
docker buildx build --pull --platform linux/arm64 --file apps/api/Dockerfile --target runtime \
  --tag "$api_repository:$IMAGE_TAG" --load .
docker buildx build --pull --platform linux/arm64 --file apps/api/Dockerfile --target migrate \
  --tag "$migrate_repository:$IMAGE_TAG" --load .
docker run --rm --platform linux/arm64 --entrypoint node "$api_repository:$IMAGE_TAG" \
  -e 'require(require("node:module").createRequire("/app/apps/api/dist/main.js").resolve("argon2"))' ||
  fail "ARM64 の api のイメージで argon2 を読めない"
docker run --rm --platform linux/arm64 --entrypoint node "$migrate_repository:$IMAGE_TAG" \
  node_modules/prisma/build/index.js --version >/dev/null ||
  fail "ARM64 のマイグレーション用のイメージで Prisma の CLI が動かない"
docker run --rm --platform linux/arm64 --entrypoint psql "$migrate_repository:$IMAGE_TAG" --version ||
  fail "ARM64 のマイグレーション用のイメージで psql が動かない"
docker push "$api_repository:$IMAGE_TAG"
docker push "$migrate_repository:$IMAGE_TAG"

echo "== 3. マイグレーション用のタスク定義を新しいタグにし、run-task に要るものを揃える"
# -target はそのリソースと依存だけを作る。マイグレーション用のタスク定義の依存（ロール・ECR・ロググループ・DATABASE_URL →
# RDS）に入らないものも並べる: クラスター・パブリックサブネットとその経路（イメージの取得）・タスクのセキュリティグループと
# 送信の規則・RDS への受信の規則・ロールにぶら下がるポリシー（実行ロールの ECR とログの管理ポリシー・パラメータの読み出し、
# マイグレーションのタスクロールの ECS Exec）。初回のリリースでは、これが無いと手順 4 の run-task が成り立たない。
# api のタスク定義とサービスは手順 5 に残す（マイグレーションの前に新しいタスク定義へ切り替えない）。
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
