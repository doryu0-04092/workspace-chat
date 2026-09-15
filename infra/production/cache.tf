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

# 踏むと壊れる: AUTH トークンは英数字だけにする（special = false）。REDIS_URL の中に埋めるため、記号を許すと値によって
# apply が落ちるか（ElastiCache が許す記号は一部だけ）、URL が壊れる（ElastiCache が許す # は URL では断片の始まりになる）。
# どちらになるかは乱数しだいで、validate も plan も落ちない。技術スタックの秘密情報の行。
ephemeral "random_password" "valkey_auth_token" {
  length  = 32
  special = false
}

# 踏むと壊れる: JWT_SECRET は長さ 64 で作る。HS256 の鍵は 256 ビット以上（RFC 7518 3.2）で、英数字 64 文字でおよそ 381 ビット。
# api の下限（apps/api/src/config/api-config.ts の JWT_SECRET_MIN_BYTES）は 32 バイトで、32 に下げても起動も validate も plan も
# CI も落ちず、署名の鍵の強さだけが下がる。変えるときは同じ apply で下の jwt_secret の value_wo_version を上げ、ECS のタスクを
# 入れ替える（発行済みのアクセストークンはすべて無効になる。要件定義書 4.2 の「Parameter Store の値」の行）。
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
