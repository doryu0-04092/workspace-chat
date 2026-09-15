# リリースの手順（scripts/release.sh）が読む値（#452）。web_url と web_bucket は delivery.tf にある。
# 踏むと壊れる: このファイルにも main.tf の冒頭の検査の条件が掛かる（apps/api/src/config/api-config-infra.test.ts）。

output "ecr_api_repository_url" {
  description = "api のイメージ（apps/api/Dockerfile の runtime 段）を push する先"
  value       = aws_ecr_repository.api.repository_url
}

output "ecr_migrate_repository_url" {
  description = "マイグレーション用のイメージ（apps/api/Dockerfile の migrate 段）を push する先"
  value       = aws_ecr_repository.migrate.repository_url
}

output "ecs_cluster_name" {
  description = "ECS のクラスター"
  value       = aws_ecs_cluster.main.name
}

output "ecs_service_name" {
  description = "api のサービス"
  value       = aws_ecs_service.api.name
}

output "migrate_task_definition_arn" {
  description = "マイグレーション用のタスク定義（run-task で1回動かす）"
  value       = aws_ecs_task_definition.migrate.arn
}

# マイグレーションの run-task は api のタスクと同じ置き場とセキュリティグループで動かす（決定・2026-09-14・作業側。#459）。
output "migrate_network_configuration" {
  description = "aws ecs run-task の --network-configuration に渡す JSON"
  value = jsonencode({
    awsvpcConfiguration = {
      subnets        = aws_subnet.public[*].id
      securityGroups = [aws_security_group.task.id]
      assignPublicIp = local.task_assign_public_ip ? "ENABLED" : "DISABLED"
    }
  })
}

output "cloudfront_distribution_id" {
  description = "web を置き換えた後にキャッシュを消すディストリビューション"
  value       = aws_cloudfront_distribution.main.id
}
