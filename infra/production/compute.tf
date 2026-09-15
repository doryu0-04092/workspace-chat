# 計算の土台（#452）。ECR・ECS クラスター・IAM のロール・内部の ALB・ターゲットグループ。
# 技術スタック「インフラ（AWS）」のコンテナ・ロードバランサの行と、「リソースのサイジング」の ALB の行。
#
# タスク定義・サービス・ロググループは、DATABASE_URL の形（#424）が決まってから足す。

# 踏むと壊れる: 技術スタックと要件定義書が決めた値は、この locals にだけ書く（下のブロックには、名前・識別子・説明のほかに
# リテラルの値を書かない）。どの値も、変えても validate も plan も CI も落ちない。変えるときは、文書の行を先に直す。
locals {
  # api の既定の待ち受けポート（apps/api/src/port.ts）。ターゲットグループと network.tf の ALB→タスクの規則はこの値だけを使う
  # （port.ts と食い違うとヘルスチェックに落ち、CI は緑のまま、デプロイ後に初めて気づく）。
  api_port = 3000

  # 死活確認（F-39）のパスと応答。api の前置き（apps/api/src/app-setup.ts の setGlobalPrefix）と health.controller.ts による。
  api_health_check_path    = "/api/health"
  api_health_check_matcher = "200"

  # タスクは ENI のプライベート IP で登録し、ALB からタスクまでは HTTP にする（技術スタックの「ECS のタスクの置き場」・「HTTPS とドメイン」）。
  api_target_type     = "ip"
  api_target_protocol = "HTTP"

  # ALB はプライベートサブネットに置き、CloudFront の VPC オリジンから HTTP で受ける（TLS は終端しない。技術スタックの「HTTPS とドメイン」）。
  # アイドルタイムアウトは既定の 60 秒のまま（Socket.IO の ping の間隔 25 秒に依存する。技術スタックの「ALB のアイドルタイムアウト」）。
  alb_internal          = true
  alb_type              = "application"
  alb_listener_port     = 80
  alb_listener_protocol = "HTTP"

  # destroy のときに、イメージが入ったままのリポジトリも消す（要件定義書 4.2 の「デモ後は terraform destroy する運用」。
  # 添付のバケットの force_destroy と同じ。プロバイダーの文書「If `true`, will delete the repository even if it contains images.」）。
  # イメージはソースから作り直せる。
  ecr_force_delete = true
}

# --- イメージ -----------------------------------------------------------------
#
# apps/api/Dockerfile の段ごとに置き場を分ける（runtime は api のサービス、migrate は run-task の一回きりのタスク）。

resource "aws_ecr_repository" "api" {
  name         = "workspace-chat-api"
  force_delete = local.ecr_force_delete
}

resource "aws_ecr_repository" "migrate" {
  name         = "workspace-chat-migrate"
  force_delete = local.ecr_force_delete
}

resource "aws_ecs_cluster" "main" {
  name = "workspace-chat"
}

# --- IAM のロール ---------------------------------------------------------------

data "aws_iam_policy_document" "ecs_tasks_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

# タスク実行ロール: イメージの取得・ログの送信と、secrets に渡すパラメータの読み出し。
resource "aws_iam_role" "task_execution" {
  name               = "workspace-chat-task-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

resource "aws_iam_role_policy_attachment" "task_execution_managed" {
  role       = aws_iam_role.task_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# 踏むと壊れる: secret: true の設定のパラメータを足したら、ここの resources にも足す（足さないとタスクが起動しない）。
# 既定の鍵（aws/ssm）で暗号化するため kms:Decrypt は要らない（ECS の文書「Required only if your secret uses a custom KMS key」）。
data "aws_iam_policy_document" "task_execution_parameters" {
  statement {
    actions = ["ssm:GetParameters"]
    resources = [
      aws_ssm_parameter.database_url.arn,
      aws_ssm_parameter.redis_url.arn,
      aws_ssm_parameter.jwt_secret.arn,
    ]
  }
}

resource "aws_iam_role_policy" "task_execution_parameters" {
  name   = "parameters"
  role   = aws_iam_role.task_execution.id
  policy = data.aws_iam_policy_document.task_execution_parameters.json
}

# マイグレーションのタスクのタスクロール: 運用者が ECS Exec で入るための権限（#274 の決定。入る先は api のタスクではなく、
# マイグレーションのイメージを run-task で動かしたタスク——要件定義書 4.2「RDS の障害から復旧するとき」手順 5 の代償。#452・#458）。
# 踏むと壊れる: この権限を api のタスクのタスクロールに付けない。api のタスクに入ると JWT_SECRET に届き、認証の外に出る。
resource "aws_iam_role" "migrate_task" {
  name               = "workspace-chat-migrate-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

data "aws_iam_policy_document" "task_exec_command" {
  statement {
    actions = [
      "ssmmessages:CreateControlChannel",
      "ssmmessages:CreateDataChannel",
      "ssmmessages:OpenControlChannel",
      "ssmmessages:OpenDataChannel",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "task_exec_command" {
  name   = "exec-command"
  role   = aws_iam_role.migrate_task.id
  policy = data.aws_iam_policy_document.task_exec_command.json
}

# --- ALB ----------------------------------------------------------------------

resource "aws_lb" "api" {
  name               = "workspace-chat-api"
  internal           = local.alb_internal
  load_balancer_type = local.alb_type
  subnets            = aws_subnet.private[*].id
  security_groups    = [aws_security_group.alb.id]
}

resource "aws_lb_target_group" "api" {
  name        = "workspace-chat-api"
  port        = local.api_port
  protocol    = local.api_target_protocol
  target_type = local.api_target_type
  vpc_id      = aws_vpc.main.id

  health_check {
    path    = local.api_health_check_path
    matcher = local.api_health_check_matcher
  }
}

resource "aws_lb_listener" "api_http" {
  load_balancer_arn = aws_lb.api.arn
  port              = local.alb_listener_port
  protocol          = local.alb_listener_protocol

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }
}
