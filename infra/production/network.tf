# ネットワーク（#452）。技術スタック「本番の HTTPS・秘密情報・state の置き場」の「ECS のタスクの置き場」と「HTTPS とドメイン」。
# 踏むと壊れる: このファイルにも main.tf の冒頭の検査の条件が掛かる（apps/api/src/config/api-config-infra.test.ts）。
#
#   パブリックサブネット  … ECS のタスク（公開 IP 付き。イメージの取得の経路）
#   プライベートサブネット … ALB（CloudFront の VPC オリジン）・RDS・ElastiCache
#
# NAT ゲートウェイとインターフェースエンドポイントは置かない。
# サブネットは2つの AZ に置く。ALB と RDS のサブネットグループが2つの AZ を要する（技術スタックの同じ行）。
# AZ の数は local.azs だけが決め、サブネットと経路表の関連付けはその数に従う。

# 通常の AZ だけを選ぶ（Local Zone・Wavelength Zone は、ALB と RDS のサブネットグループの前提を満たさない）。
data "aws_availability_zones" "available" {
  state = "available"

  filter {
    name   = "opt-in-status"
    values = ["opt-in-not-required"]
  }
}

locals {
  azs = slice(data.aws_availability_zones.available.names, 0, 2)
}

resource "aws_vpc" "main" {
  cidr_block = "10.0.0.0/16"

  tags = {
    Name = local.name
  }

  # 決めた環境の外の workspace（打ち間違いなど）では plan を失敗させる（前提条件は plan の段階で評価され、失敗すると何も apply されない）。
  lifecycle {
    precondition {
      condition     = contains(local.allowed_environments, local.environment)
      error_message = "workspace は default（本番）か staging にする（main.tf の locals）。"
    }
  }
}

# VPC オリジンを使う VPC にも要る（技術スタックの「HTTPS とドメイン」の行）。
resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id

  tags = {
    Name = local.name
  }
}

resource "aws_subnet" "public" {
  count = length(local.azs)

  vpc_id            = aws_vpc.main.id
  availability_zone = local.azs[count.index]
  cidr_block        = cidrsubnet(aws_vpc.main.cidr_block, 8, count.index)

  tags = {
    Name = "${local.name}-public-${local.azs[count.index]}"
  }
}

resource "aws_subnet" "private" {
  count = length(local.azs)

  vpc_id            = aws_vpc.main.id
  availability_zone = local.azs[count.index]
  cidr_block        = cidrsubnet(aws_vpc.main.cidr_block, 8, 10 + count.index)

  tags = {
    Name = "${local.name}-private-${local.azs[count.index]}"
  }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }

  tags = {
    Name = "${local.name}-public"
  }
}

resource "aws_route_table_association" "public" {
  count = length(aws_subnet.public)

  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

# プライベートサブネットは VPC の中だけに経路を持つ（外への経路を足さない）。
# route を空で明示する: 省くと、手で足された経路を Terraform が無視し、plan の差分にも出ない
# （プロバイダーの文書「omitting this argument is interpreted as ignoring any existing routes」）。
resource "aws_route_table" "private" {
  vpc_id = aws_vpc.main.id
  route  = []

  tags = {
    Name = "${local.name}-private"
  }
}

resource "aws_route_table_association" "private" {
  count = length(aws_subnet.private)

  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private.id
}

# --- セキュリティグループ -----------------------------------------------------
#
# 規則はここの規則のリソースだけで書く（aws_security_group のインラインの ingress / egress と混ぜない）。
# Terraform はセキュリティグループを作るときに AWS の既定の送信の規則（すべて許す）を消す。
#
# 踏むと壊れる: タスクへの受信を止めるのは、タスクのセキュリティグループの1層だけである（技術スタックの代償）。
# 送信元を ALB のセキュリティグループ以外に広げると、CloudFront を経ずに api へ直接届く。
# 広げる誤りは validate でも plan でも落ちないため、apply の後に、タスクのセキュリティグループの受信が
# ALB のセキュリティグループからの api のポート（compute.tf の local.api_port）だけであることを実物で確かめる（技術スタックの同じ代償）。
#
# 踏むと壊れる: マイグレーションの run-task が要る規則（例: db_from_task）を足したら、scripts/release.sh の
# 手順 3 の -target にも足す。足さないと、初回のリリースで手順 4 の run-task が規則の無いまま失敗する。

resource "aws_security_group" "alb" {
  name   = "${local.name}-alb"
  vpc_id = aws_vpc.main.id
}

resource "aws_security_group" "task" {
  name   = "${local.name}-task"
  vpc_id = aws_vpc.main.id
}

resource "aws_security_group" "db" {
  name   = "${local.name}-db"
  vpc_id = aws_vpc.main.id
}

resource "aws_security_group" "valkey" {
  name   = "${local.name}-valkey"
  vpc_id = aws_vpc.main.id
}

# ALB への受信（CloudFront から）は、VPC オリジンを作るときに足す。

# 踏むと壊れる: ポートは compute.tf の local.api_port（api の既定の待ち受けポート。apps/api/src/port.ts）だけを使う。
# port.ts と食い違うと ALB からタスクへ届かず、CI は緑のまま、デプロイ後のヘルスチェックで初めて落ちる。
resource "aws_vpc_security_group_egress_rule" "alb_to_task" {
  security_group_id            = aws_security_group.alb.id
  referenced_security_group_id = aws_security_group.task.id
  ip_protocol                  = "tcp"
  from_port                    = local.api_port
  to_port                      = local.api_port
}

resource "aws_vpc_security_group_ingress_rule" "task_from_alb" {
  security_group_id            = aws_security_group.task.id
  referenced_security_group_id = aws_security_group.alb.id
  ip_protocol                  = "tcp"
  from_port                    = local.api_port
  to_port                      = local.api_port
}

resource "aws_vpc_security_group_egress_rule" "task_all" {
  security_group_id = aws_security_group.task.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

resource "aws_vpc_security_group_ingress_rule" "db_from_task" {
  security_group_id            = aws_security_group.db.id
  referenced_security_group_id = aws_security_group.task.id
  ip_protocol                  = "tcp"
  from_port                    = local.db_port
  to_port                      = local.db_port
}

# 踏むと壊れる: この規則を壊しても api は止まらず、5xx も出ない（アラートも置かない。要件定義書 4.2「アラート」）。
# 配信の共有と在席だけが、api の warn ログを見ない限り気づかれないまま止まる。
resource "aws_vpc_security_group_ingress_rule" "valkey_from_task" {
  security_group_id            = aws_security_group.valkey.id
  referenced_security_group_id = aws_security_group.task.id
  ip_protocol                  = "tcp"
  from_port                    = local.valkey_port
  to_port                      = local.valkey_port
}
