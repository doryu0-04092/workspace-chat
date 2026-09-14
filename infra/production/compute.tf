# 計算の土台（#452）。ECR・ECS クラスター・IAM のロール・内部の ALB・ターゲットグループ。
# 技術スタック「インフラ（AWS）」のコンテナ・ロードバランサの行と、「リソースのサイジング」の ALB の行。
#
# タスク定義・サービス・ロググループは、DATABASE_URL の形（#424）が決まってから足す。

# --- イメージ -----------------------------------------------------------------
#
# apps/api/Dockerfile の段ごとに置き場を分ける（runtime は api のサービス、migrate は run-task の一回きりのタスク）。

resource "aws_ecr_repository" "api" {
  name = "workspace-chat-api"
}

resource "aws_ecr_repository" "migrate" {
  name = "workspace-chat-migrate"
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

# タスクロール: 運用者が ECS Exec で api のタスクに入るための権限（#274 の決定。#458）。
resource "aws_iam_role" "task" {
  name               = "workspace-chat-task"
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
  role   = aws_iam_role.task.id
  policy = data.aws_iam_policy_document.task_exec_command.json
}

# --- ALB ----------------------------------------------------------------------
#
# プライベートサブネットに置き、CloudFront の VPC オリジンとして HTTP で受ける（TLS は終端しない）。
# アイドルタイムアウトは既定の 60 秒のまま（Socket.IO の ping の間隔 25 秒に依存する。技術スタックの「ALB のアイドルタイムアウト」）。

resource "aws_lb" "api" {
  name               = "workspace-chat-api"
  internal           = true
  load_balancer_type = "application"
  subnets            = aws_subnet.private[*].id
  security_groups    = [aws_security_group.alb.id]
}

# 踏むと壊れる: port の 3000 は api の既定の待ち受けポート（apps/api/src/port.ts）と、network.tf の ALB→タスクの規則と同じでなければならない。
# 食い違うとヘルスチェックに落ち、CI は緑のまま、デプロイ後に初めて気づく。
resource "aws_lb_target_group" "api" {
  name        = "workspace-chat-api"
  port        = 3000
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = aws_vpc.main.id

  health_check {
    path    = "/api/health"
    matcher = "200"
  }
}

resource "aws_lb_listener" "api_http" {
  load_balancer_arn = aws_lb.api.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }
}
