# リリースの手順（scripts/release.sh）が読む値（#452）。web_url と web_bucket は delivery.tf にある。
# 踏むと壊れる: **要件定義書 4.2「秘密の値が漏れた疑いがあるとき」の共通の前置きも、ecs_cluster_name と
# ecs_service_name をこの名前で読む**（terraform output -raw）。名前を変えると、その段が空になる。
# **空でも変数は「設定済み」になるため apply は聞き返さない**——前置きは空を弾く段を持つが、気づく経路はそこだけである。
# 踏むと壊れる: このファイルにも main.tf の冒頭の検査の条件が掛かる（apps/api/src/config/api-config-infra.test.ts）。

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
