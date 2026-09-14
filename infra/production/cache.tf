# ElastiCache for Valkey と、api が secret: true と宣言した設定のうち REDIS_URL・JWT_SECRET のパラメータ（#452）。
# 技術スタック「本番の HTTPS・秘密情報・state の置き場」の秘密情報の行と、「リソースのサイジング」の ElastiCache の行。
#
# 秘密の値は state とプランに残さない: 乱数は ephemeral の random_password で作り、write-only 引数でだけ渡す。
#
# 踏むと壊れる: write-only 引数で渡した値は、*_wo_version を上げるまで入れ替わらない。
# REDIS_URL の value_wo_version と ElastiCache の auth_token_wo_version は必ず一緒に上げる
# （片方だけ上げると、api が Valkey に繋がらない。技術スタックの秘密情報の行）。
# 版を上げた apply の後も、ECS のタスクを入れ替えるまで動いているコンテナは古い値を持つ。

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
  port               = 6379

  subnet_group_name  = aws_elasticache_subnet_group.valkey.name
  security_group_ids = [aws_security_group.valkey.id]

  transit_encryption_enabled = true
  auth_token_wo              = ephemeral.random_password.valkey_auth_token.result
  auth_token_wo_version      = 1
}

resource "aws_ssm_parameter" "redis_url" {
  name             = "/workspace-chat/REDIS_URL"
  type             = "SecureString"
  tier             = "Standard"
  value_wo         = "rediss://:${ephemeral.random_password.valkey_auth_token.result}@${aws_elasticache_replication_group.valkey.primary_endpoint_address}:6379"
  value_wo_version = 1
}

resource "aws_ssm_parameter" "jwt_secret" {
  name             = "/workspace-chat/JWT_SECRET"
  type             = "SecureString"
  tier             = "Standard"
  value_wo         = ephemeral.random_password.jwt_secret.result
  value_wo_version = 1
}
