# 本番のリリース（scripts/release.sh）とステージングへのデプロイ（scripts/deploy-staging.sh）が共に使う手順（#688）。
# source して使う。呼ぶ側が set -euo pipefail を掛けている前提で書く。

deploy_fail() {
  echo "NG: $*" >&2
  exit 1
}

# マイグレーションを run-task で1回動かし、止まるまで待って終了コードを確かめる。
# 新しいタスク定義に切り替える前に流す（技術スタックのコンテナの行。#274）。
#   run_migration <クラスター> <マイグレーション用のタスク定義> <--network-configuration に渡す JSON>
run_migration() {
  local cluster=$1 task_definition=$2 network_configuration=$3 task exit_code
  task=$(aws ecs run-task --cluster "$cluster" --task-definition "$task_definition" --launch-type FARGATE \
    --network-configuration "$network_configuration" --query 'tasks[0].taskArn' --output text)
  if [ -z "$task" ] || [ "$task" = "None" ]; then
    deploy_fail "マイグレーションのタスクを起動できない"
  fi
  aws ecs wait tasks-stopped --cluster "$cluster" --tasks "$task"
  exit_code=$(aws ecs describe-tasks --cluster "$cluster" --tasks "$task" \
    --query 'tasks[0].containers[0].exitCode' --output text)
  [ "$exit_code" = "0" ] || deploy_fail "マイグレーションが終了コード $exit_code で終わった（ロググループ /ecs/<名前>-migrate を見る）"
}

# ビルド済みの web（dist）をバケットに置き、CloudFront のキャッシュを消す。
#   deploy_web <バケット> <ディストリビューションの ID> <dist のディレクトリ>
#
# 踏むと壊れる: 置く順番を変えない（#604）。古い資産を消すのは、index.html を no-cache で置き直し、無効化が終わった後にする。
# 先に消すと、ブラウザや CloudFront に残った古い index.html が消えた /assets/index-<hash>.js を読みに行き、画面が出ない。
# index.html に Cache-Control を付けないと、ブラウザが Last-Modified から推定した間だけ古いものを使い回す（RFC 9111 4.2.2）。
deploy_web() {
  local bucket=$1 distribution=$2 dist=$3 invalidation
  [ -f "$dist/index.html" ] || deploy_fail "$dist に index.html が無い（web をビルドしてから置く）"
  [ -n "$distribution" ] && [ "$distribution" != "None" ] || deploy_fail "CloudFront のディストリビューションが見つからない"
  aws s3 sync "$dist" "s3://$bucket" --exclude index.html
  aws s3 cp "$dist/index.html" "s3://$bucket/index.html" --cache-control no-cache --content-type text/html
  invalidation=$(aws cloudfront create-invalidation --distribution-id "$distribution" --paths '/*' \
    --query 'Invalidation.Id' --output text)
  aws cloudfront wait invalidation-completed --distribution-id "$distribution" --id "$invalidation"
  aws s3 sync "$dist" "s3://$bucket" --delete --exclude index.html
}
