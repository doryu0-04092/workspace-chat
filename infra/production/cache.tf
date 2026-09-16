# ElastiCache for Valkey と、api が secret: true と宣言した設定のうち REDIS_URL・JWT_SECRET のパラメータ（#452）。
# 技術スタック「本番の HTTPS・秘密情報・state の置き場」の秘密情報の行と、「リソースのサイジング」の ElastiCache の行。
#
# 秘密の値は state とプランに残さない: 乱数は ephemeral の random_password で作り、write-only 引数でだけ渡す。
# 踏むと壊れる: このファイルにも main.tf の冒頭の検査の条件が掛かる（apps/api/src/config/api-config-infra.test.ts）。秘密の値の渡し方の条件もそこにある。
#
# 踏むと壊れる: write-only 引数で渡した値は、*_wo_version を上げるまで入れ替わらない。
# REDIS_URL の value_wo_version と ElastiCache の auth_token_wo_version は同じ乱数を渡すため、下の locals の
# valkey_auth_token_version だけで上げる（片方だけ上げると、api が Valkey に繋がらない。技術スタックの秘密情報の行）。
# 版を上げた apply の後も、ECS のタスクを入れ替えるまで動いているコンテナは古い値を持つ。
#
# 踏むと壊れる: **漏えいの疑いで入れ替えるときは、この版を上げても漏れたトークンは通用したまま残る**。
# 要件定義書 4.2「秘密の値が漏れた疑いがあるとき」の手順による（レプリケーショングループを -replace で作り直す）。
# **既存のクラスタのトークンを変える経路（ROTATE・SET）は使わない**——ROTATE は古いトークンを残し、
# 古いトークンを外す SET には最後のトークンと同じ値が要るが、乱数は ephemeral で手元に置かないため渡せない。
# 版を上げただけで「入れ替えた」と判断すると、漏れた値が通用する状態が残る。

# 踏むと壊れる: 技術スタックが決めた値は、この locals にだけ書く（下のブロックには、名前と説明のほかにリテラルの値を書かない）。
# どの値も、変えても validate も plan も CI も落ちない（apply が落ちるのは AWS の制約の外に出たときだけ）。
# 変えるときは、技術スタックの行を先に直す。
locals {
  # Valkey の待ち受けポート。ElastiCache・REDIS_URL・network.tf の受信の規則はこの値だけを使う
  # （食い違うと api が Valkey に繋がらず、5xx もアラートも出ない。要件定義書 4.2「アラート」）。
  valkey_port = 6379

  # REDIS_URL の value_wo_version と ElastiCache の auth_token_wo_version が一緒に使う版。
  valkey_auth_token_version = 1

  # JWT_SECRET の value_wo_version。上げると、発行済みのアクセストークンがすべて無効になる（要件定義書 4.2 の「Parameter Store の値」の行）。
  # 代償: **止めずにローリングで入れ替えると、新旧の鍵を持つタスクが同時に動く区間ができる**。
  # ALB にスティッキーセッションを置いていないため、発行済みのトークンを持つ利用者の要求が、当たったタスクによって通ったり 401 になったりする
  # （リフレッシュで取り直せるが、その間は失敗が見える）。
  # 踏むと壊れる: **漏えいの疑いで入れ替えるときは、api を止めてから行う**
  # （要件定義書 4.2「秘密の値が漏れた疑いがあるとき」の JWT_SECRET の行）。
  # 止めずに版を上げると、タスクを入れ替えるまで**古いタスクが漏れた鍵を持ち、偽造したトークンを受理し続ける**。
  jwt_secret_version = 1

  # 乱数の長さ。下げても AWS の制約（AUTH トークンは 16–128 文字）の内側なら、トークンと鍵の強さだけが下がる。
  # JWT_SECRET の 64 は、HS256 の鍵は 256 ビット以上（RFC 7518 3.2）による（英数字 64 文字でおよそ 381 ビット）。
  # api の下限（apps/api/src/config/api-config.ts の JWT_SECRET_MIN_BYTES）は 32 バイトで、32 に下げても api の起動は落ちない。
  valkey_auth_token_length = 32
  jwt_secret_length        = 64

  # 乱数は英数字だけにする。AUTH トークンは REDIS_URL の中に埋めるため、記号を許すと乱数しだいで apply が落ちるか
  # （ElastiCache が許す記号は一部だけ）、URL が壊れる（ElastiCache が許す # は URL では断片の始まりになる）。
  random_password_special = false

  valkey_engine             = "valkey"
  valkey_engine_version     = "8.2"
  valkey_node_type          = "cache.t4g.micro"
  valkey_num_cache_clusters = 1

  # 転送時暗号化。REDIS_URL の rediss:// と auth_token_wo は、これを前提にする。
  valkey_transit_encryption_enabled = true

  # Parameter Store の暗号化パラメータ（標準の区分）。String にすると、値が暗号化されずに置かれる。
  parameter_type = "SecureString"
  parameter_tier = "Standard"
}

ephemeral "random_password" "valkey_auth_token" {
  length  = local.valkey_auth_token_length
  special = local.random_password_special
}

ephemeral "random_password" "jwt_secret" {
  length  = local.jwt_secret_length
  special = local.random_password_special
}

resource "aws_elasticache_subnet_group" "valkey" {
  name       = "workspace-chat-valkey"
  subnet_ids = aws_subnet.private[*].id
}

resource "aws_elasticache_replication_group" "valkey" {
  replication_group_id = "workspace-chat"
  description          = "workspace-chat realtime adapter and rate limit counters"

  engine             = local.valkey_engine
  engine_version     = local.valkey_engine_version
  node_type          = local.valkey_node_type
  num_cache_clusters = local.valkey_num_cache_clusters
  port               = local.valkey_port

  subnet_group_name  = aws_elasticache_subnet_group.valkey.name
  security_group_ids = [aws_security_group.valkey.id]

  transit_encryption_enabled = local.valkey_transit_encryption_enabled
  auth_token_wo              = ephemeral.random_password.valkey_auth_token.result
  auth_token_wo_version      = local.valkey_auth_token_version
}

# 踏むと壊れる: secrets で渡すパラメータ（ここの2つと database.tf の database_url）の name は、渡す設定の名前（/REDIS_URL など）で終わらせ、
# type は local.parameter_type（SecureString）にする。apps/api/src/config/api-config-infra.test.ts が確かめる。
resource "aws_ssm_parameter" "redis_url" {
  name             = "/workspace-chat/REDIS_URL"
  type             = local.parameter_type
  tier             = local.parameter_tier
  value_wo         = "rediss://:${ephemeral.random_password.valkey_auth_token.result}@${aws_elasticache_replication_group.valkey.primary_endpoint_address}:${local.valkey_port}"
  value_wo_version = local.valkey_auth_token_version
}

resource "aws_ssm_parameter" "jwt_secret" {
  name             = "/workspace-chat/JWT_SECRET"
  type             = local.parameter_type
  tier             = local.parameter_tier
  value_wo         = ephemeral.random_password.jwt_secret.result
  value_wo_version = local.jwt_secret_version
}
