# ElastiCache for Valkey と、api が secret: true と宣言した設定のうち REDIS_URL・JWT_SECRET のパラメータ（#452）。
# 技術スタック「本番の HTTPS・秘密情報・state の置き場」の秘密情報の行と、「リソースのサイジング」の ElastiCache の行。
#
# 秘密の値は state とプランに残さない: 乱数は ephemeral の random_password で作り、write-only 引数でだけ渡す。
#
# 踏むと壊れる: write-only 引数で渡した値は、*_wo_version を上げるまで入れ替わらない。
# REDIS_URL の value_wo_version と ElastiCache の auth_token_wo_version は同じ乱数を渡すため、下の locals の
# valkey_auth_token_version だけで上げる（片方だけ上げると、api が Valkey に繋がらない。技術スタックの秘密情報の行）。
# 版を上げた apply の後も、ECS のタスクを入れ替えるまで動いているコンテナは古い値を持つ。

locals {
  # Valkey の待ち受けポート。ElastiCache・REDIS_URL・network.tf の受信の規則はこの値だけを使う
  # （食い違うと api が Valkey に繋がらず、validate も plan も落ちず、5xx もアラートも出ない。要件定義書 4.2「アラート」）。
  valkey_port = 6379

  # REDIS_URL の value_wo_version と ElastiCache の auth_token_wo_version が一緒に使う版。
  valkey_auth_token_version = 1
}

ephemeral "random_password" "valkey_auth_token" {
  length  = 32
  special = false
}

ephemeral "random_password" "jwt_secret" {
  length  = 64
  special = false
}

resource "aws_elasticache_subnet_group" "valkey" {
  name       = "workspace-chat-valkey"
  subnet_ids = aws_subnet.private[*].id
}

resource "aws_elasticache_replication_group" "valkey" {
  replication_group_id = "workspace-chat"
  description          = "workspace-chat realtime adapter and rate limit counters"

  engine             = "valkey"
  engine_version     = "8.2"
  node_type          = "cache.t4g.micro"
  num_cache_clusters = 1
  port               = local.valkey_port

  subnet_group_name  = aws_elasticache_subnet_group.valkey.name
  security_group_ids = [aws_security_group.valkey.id]

  transit_encryption_enabled = true
  auth_token_wo              = ephemeral.random_password.valkey_auth_token.result
  auth_token_wo_version      = local.valkey_auth_token_version
}

resource "aws_ssm_parameter" "redis_url" {
  name             = "/workspace-chat/REDIS_URL"
  type             = "SecureString"
  tier             = "Standard"
  value_wo         = "rediss://:${ephemeral.random_password.valkey_auth_token.result}@${aws_elasticache_replication_group.valkey.primary_endpoint_address}:${local.valkey_port}"
  value_wo_version = local.valkey_auth_token_version
}

resource "aws_ssm_parameter" "jwt_secret" {
  name             = "/workspace-chat/JWT_SECRET"
  type             = "SecureString"
  tier             = "Standard"
  value_wo         = ephemeral.random_password.jwt_secret.result
  value_wo_version = 1
}
