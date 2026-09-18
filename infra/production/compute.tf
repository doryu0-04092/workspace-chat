# 計算の土台（#452）。ECR・ECS クラスター・IAM のロール・内部の ALB・ターゲットグループ。
# 技術スタック「インフラ（AWS）」のコンテナ・ロードバランサの行と、「リソースのサイジング」の ALB の行。
#
# タスク定義・サービス・ロググループは service.tf にある。
# 踏むと壊れる: このファイルにも main.tf の冒頭の検査の条件が掛かる（apps/api/src/config/api-config-infra.test.ts）。

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

  # destroy のときに、イメージが入ったままのリポジトリも消す（決定と代償は要件定義書 4.2「バックアップ」の ECR の段落。
  # プロバイダーの文書「If `true`, will delete the repository even if it contains images.」）。
  ecr_force_delete = true

  # Terraform の外（scripts/cloudfront-signing-key.sh）で値を置くパラメータ（#427）。CloudFront の署名付き Cookie の秘密鍵。
  # Terraform は値を作らず読まず（state とプランに鍵を残さない）、名前から ARN を組み立てて secrets と ssm:GetParameters に渡すだけにする。
  # 踏むと壊れる: 名前を変えるときは、スクリプトの名前も同じに直す（apps/api/src/config/api-config-infra.test.ts の externalParameters が照合する）。
  # apply の前にパラメータが置かれていないと、api のタスクが起動しない（ECS が secrets を読めない）。
  cloudfront_private_key_parameter_name = "/workspace-chat/CLOUDFRONT_PRIVATE_KEY"
  cloudfront_private_key_parameter_arn  = "arn:aws:ssm:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:parameter${local.cloudfront_private_key_parameter_name}"
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

# 踏むと壊れる: **要件定義書 4.2「秘密の値が漏れた疑いがあるとき」の手順が、このクラスターを
# outputs.tf の ecs_cluster_name 経由で指す**（aws ecs update-service / list-tasks / wait の --cluster）。
resource "aws_ecs_cluster" "main" {
  name = "workspace-chat"
}

# --- IAM のロール ---------------------------------------------------------------
#
# 踏むと壊れる: この下のロール・ポリシー・結び付きは IAM の面に入る。足す・変えるときは、main.tf の冒頭の条件に従い、検査の iamSurface の表も直す。

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
# 踏むと壊れる: このロールに結び付けるのは、下の管理ポリシー（AmazonECSTaskExecutionRolePolicy）の付与と task_execution_parameters の2つだけにする。
# role はロールの参照（aws_iam_role.task_execution）で書き、ロール名の文字列で書かない。ロールのブロックに managed_policy_arns・inline_policy を書かない。
# パラメータを読む操作（ssm:GetParameters）は task_execution_parameters の1箇所だけに書く。apps/api/src/config/api-config-infra.test.ts が確かめる。
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
# 踏むと壊れる: statement は1つだけ、actions は ["ssm:GetParameters"] だけ、resources はその場に書いたリストで、要素は aws_ssm_parameter.<名前>.arn
# （Terraform が値を作る）か local.<名前>_arn（外で置く。検査の externalParameters にあるものだけ）にする
# （apps/api/src/config/api-config-infra.test.ts が確かめる。"*" やリストでない式を書くと検査が落ちる）。
data "aws_iam_policy_document" "task_execution_parameters" {
  statement {
    actions = ["ssm:GetParameters"]
    resources = [
      aws_ssm_parameter.database_url.arn,
      aws_ssm_parameter.redis_url.arn,
      aws_ssm_parameter.jwt_secret.arn,
      local.cloudfront_private_key_parameter_arn,
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
# 踏むと壊れる: このロールに ssmmessages の4つの操作のほかの権限を足さない。タスクロールの資格情報はコンテナに渡り、ECS Exec で入った
# 運用者がその権限を得る（要件定義書 4.2 手順 5 の「踏むと壊れる」）。この権限を api のタスクのタスクロールに付けない。api のタスクに入ると
# JWT_SECRET に届き、認証の外に出る。
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

# api のタスクのタスクロール: アップロードの確定の主体（機能一覧 11.1・1.3。技術スタックの添付ファイルの行）と、署名者のロールの引き受け（#427）。
# 確定は、隔離用のキーを検証した版に固定して読み（GetObjectVersion）、配信用のキーへコピーし（宛先の PutObject）、隔離用のキーを削除する。
# 踏むと壊れる: このロールに quarantine/ への PutObject を足さない。ブラウザに渡す署名付き URL は下の upload_signer で署名する——
# 同じプリンシパルで署名すると、ブラウザからの PUT が配信用のキーへも通る（署名付き URL への PUT は署名したプリンシパルとして認証される）。
# 踏むと壊れる: このロールに ssmmessages の権限を足さない・api のサービスで ECS Exec を有効にしない（service.tf の api_enable_execute_command）。
resource "aws_iam_role" "api_task" {
  name               = "workspace-chat-api-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

data "aws_iam_policy_document" "api_task_storage" {
  statement {
    actions = ["s3:GetObject", "s3:GetObjectVersion", "s3:DeleteObject"]
    resources = [
      "${aws_s3_bucket.attachments.arn}/quarantine/avatars/*",
      "${aws_s3_bucket.attachments.arn}/quarantine/workspace/*",
    ]
  }

  statement {
    actions = ["s3:PutObject"]
    resources = [
      "${aws_s3_bucket.attachments.arn}/avatars/*",
      "${aws_s3_bucket.attachments.arn}/workspace/*",
    ]
  }

  statement {
    actions   = ["sts:AssumeRole"]
    resources = [aws_iam_role.upload_signer.arn]
  }
}

resource "aws_iam_role_policy" "api_task_storage" {
  name   = "storage"
  role   = aws_iam_role.api_task.id
  policy = data.aws_iam_policy_document.api_task_storage.json
}

# アップロード用の署名付き URL の署名者（#427）。quarantine/ にだけ書ける。api のタスクロールが sts:AssumeRole で引き受け、
# その一時的な資格情報で URL に署名する（アクセスキーを作らない。api には S3_UPLOAD_ROLE_ARN で ARN を渡す）。
# 踏むと壊れる: このロールに quarantine/ の外への権限を足さない。信頼する相手を api のタスクロールの外へ広げない。
data "aws_iam_policy_document" "upload_signer_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "AWS"
      identifiers = [aws_iam_role.api_task.arn]
    }
  }
}

resource "aws_iam_role" "upload_signer" {
  name               = "workspace-chat-upload-signer"
  assume_role_policy = data.aws_iam_policy_document.upload_signer_assume.json
}

data "aws_iam_policy_document" "upload_signer" {
  statement {
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.attachments.arn}/quarantine/*"]
  }
}

resource "aws_iam_role_policy" "upload_signer" {
  name   = "quarantine-put"
  role   = aws_iam_role.upload_signer.id
  policy = data.aws_iam_policy_document.upload_signer.json
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
