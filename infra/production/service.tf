# ECS のタスク定義・サービス・ロググループ（#452）。技術スタックのコンテナの行・「ECS のタスクの置き場」と、
# 「リソースのサイジング」の ECS Fargate の行。
# 踏むと壊れる: このファイルにも main.tf の冒頭の検査の条件が掛かる（apps/api/src/config/api-config-infra.test.ts）。
#
# マイグレーションはサービスの外で、マイグレーション用のタスク定義を aws ecs run-task で1回動かし、新しいタスク定義に
# 切り替える前に流す（技術スタックのコンテナの行。#274）。運用者が ECS Exec で入る先も、そのタスク定義を run-task で動かしたタスクである。

# 踏むと壊れる: 技術スタックと要件定義書が決めた値は、この locals にだけ書く（下のブロックには、名前・識別子・説明のほかに
# リテラルの値を書かない）。どの値も、変えても validate も plan も CI も落ちない。変えるときは、文書の行を先に直す。
locals {
  # 0.25 vCPU / 0.5 GB × 2 タスク（技術スタックの「リソースのサイジング」の ECS Fargate の行）。
  # api_task_count は API_TASK_COUNT にも渡す（apps/api/src/rate-limit/rate-limit-config.ts。Valkey が止まっている間、上限をこの数で割る）。
  #
  # 踏むと壊れる: **秘密の値の入れ替えで api を止めるときに、この値を 0 にしない**
  # （要件定義書 4.2「秘密の値が漏れた疑いがあるとき」の、**api を止める箇条（DATABASE_URL と JWT_SECRET）**。
  # 止めるのは Terraform の外である）。ここを 0 にして apply すると、対象を絞る段の理由が消え、
  # **サービスを戻す段の対象を絞らない apply でも構成が 0 のままで戻らない**（どちらの箇条でも全断が続く）。
  # API_TASK_COUNT も 0 になり、レート制限の数え方まで巻き込む。
  api_task_cpu    = 256
  api_task_memory = 512
  api_task_count  = 2

  migrate_task_cpu    = 256
  migrate_task_memory = 512

  # CPU アーキテクチャは ARM64（技術スタックのコンテナの行。#274）。イメージも linux/arm64 で作る。
  task_cpu_architecture = "ARM64"
  task_os_family        = "LINUX"

  # タスクはパブリックサブネットに公開 IP 付きで置く（イメージの取得の経路。技術スタックの「ECS のタスクの置き場」）。
  task_assign_public_ip = true

  # ロググループの保持期間（決定・2026-09-14・作業側。依頼側の委任による。#452 のコメント）。
  log_retention_days = 30

  # 本番は CloudFront → ALB → タスクの2段（apps/api/src/rate-limit/rate-limit-config.ts の resolveTrustProxyHops）。
  trust_proxy_hops = 2

  # 新しいタスクが起動してヘルスチェックに通るまで、ALB の失敗を数えない秒数。
  api_health_check_grace_seconds = 60

  # 踏むと壊れる: api のサービスで ECS Exec を有効にしない。api のタスクは JWT_SECRET を持ち、入ると認証の外に出る
  # （要件定義書 4.2「RDS の障害から復旧するとき」手順 5 の「踏むと壊れる」）。
  api_enable_execute_command = false

  # 新しいタスクが起動に失敗し続けたら、デプロイを止めて前のタスク定義に戻す（壊れたイメージのリリースを本番に居座らせない。
  # 決定・2026-09-16・作業側。依頼側の委任による。PR #482 第0巡の設計の提案）。
  api_deployment_circuit_breaker_rollback = true
}

data "aws_region" "current" {}

resource "aws_cloudwatch_log_group" "api" {
  name              = "/ecs/workspace-chat-api"
  retention_in_days = local.log_retention_days
}

resource "aws_cloudwatch_log_group" "migrate" {
  name              = "/ecs/workspace-chat-migrate"
  retention_in_days = local.log_retention_days
}

resource "aws_ecs_task_definition" "api" {
  family                   = "workspace-chat-api"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = local.api_task_cpu
  memory                   = local.api_task_memory
  execution_role_arn       = aws_iam_role.task_execution.arn

  runtime_platform {
    cpu_architecture        = local.task_cpu_architecture
    operating_system_family = local.task_os_family
  }

  # secret: true の設定（apps/api/src/config/api-config.ts の API_SETTINGS）は secrets で渡し、environment に書かない
  # （技術スタックの秘密情報の行）。踏むと壊れる: secret: true の設定を足したら、ここと compute.tf の ssm:GetParameters の両方に足す。
  # 踏むと壊れる: apps/api/src/config/api-config-infra.test.ts がこのファイルを読んで秘密の渡し方を確かめる。タスク定義は api と migrate の2つだけにし、
  # container_definitions は jsonencode([ … ]) の1つだけで、その要素はその場に書いたオブジェクトにする（local・merge・for で作ると、中身を読めずに検査が落ちる）。
  # コンテナの属性は name・image・essential・portMappings・environment・secrets・logConfiguration だけ（logConfiguration の中は logDriver・options だけ）。
  # 属性を足すときは、秘密を渡す別の経路（environmentFiles・secretOptions など）でないことを確かめてから、検査の許可リストにも足す。
  # environment・secrets はその場に書いたリスト（[ … ]）にし、要素の name は文字列、secrets の valueFrom は aws_ssm_parameter.<名前>.arn の形で書く。
  # api のコンテナの environment を空にしない（検査の「数え上げる対象がある」の下限で落ちる。空にするなら、その下限も直す）。
  container_definitions = jsonencode([
    {
      # 踏むと壊れる: **要件定義書 4.2「秘密の値が漏れた疑いがあるとき」の前置きが、
      # このコンテナを containerDefinitions[0] という位置で、image を <URL>:<タグ> という形で読み、
      # 末尾のタグを TF_VAR_image_tag に採る。** 並びを変える・image の形を変えると、
      # **採るタグが別のものになるか採れなくなり、対象を絞らない apply が別のイメージを本番へ出す。**
      # validate も plan も CI も落ちない。
      name         = "api"
      image        = "${aws_ecr_repository.api.repository_url}:${var.image_tag}"
      essential    = true
      portMappings = [{ containerPort = local.api_port, protocol = "tcp" }]
      environment = [
        { name = "TRUST_PROXY_HOPS", value = tostring(local.trust_proxy_hops) },
        { name = "API_TASK_COUNT", value = tostring(local.api_task_count) },
        { name = "WEB_ORIGIN", value = "https://${aws_cloudfront_distribution.main.domain_name}" },
      ]
      secrets = [
        { name = "DATABASE_URL", valueFrom = aws_ssm_parameter.database_url.arn },
        { name = "REDIS_URL", valueFrom = aws_ssm_parameter.redis_url.arn },
        { name = "JWT_SECRET", valueFrom = aws_ssm_parameter.jwt_secret.arn },
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.api.name
          "awslogs-region"        = data.aws_region.current.region
          "awslogs-stream-prefix" = "api"
        }
      }
    }
  ])
}

# 踏むと壊れる: マイグレーション用のタスク定義の secrets には DATABASE_URL だけを置き、タスクロールは compute.tf の migrate_task にする
# （運用者が ECS Exec で入る先であり、JWT_SECRET などを足すと認証の外に出る。要件定義書 4.2 手順 5 の「踏むと壊れる」）。
resource "aws_ecs_task_definition" "migrate" {
  family                   = "workspace-chat-migrate"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = local.migrate_task_cpu
  memory                   = local.migrate_task_memory
  execution_role_arn       = aws_iam_role.task_execution.arn
  task_role_arn            = aws_iam_role.migrate_task.arn

  runtime_platform {
    cpu_architecture        = local.task_cpu_architecture
    operating_system_family = local.task_os_family
  }

  container_definitions = jsonencode([
    {
      name      = "migrate"
      image     = "${aws_ecr_repository.migrate.repository_url}:${var.image_tag}"
      essential = true
      secrets = [
        { name = "DATABASE_URL", valueFrom = aws_ssm_parameter.database_url.arn },
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.migrate.name
          "awslogs-region"        = data.aws_region.current.region
          "awslogs-stream-prefix" = "migrate"
        }
      }
    }
  ])
}

resource "aws_ecs_service" "api" {
  name            = "workspace-chat-api"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.api.arn
  # 踏むと壊れる: **この desired_count に lifecycle { ignore_changes } を置かない。**
  # 要件定義書 4.2「秘密の値が漏れた疑いがあるとき」の **api を止める箇条（DATABASE_URL と JWT_SECRET）の
  # サービスを戻す段**は、**止めるときに Terraform の外から 0 にした drift を、対象を絞らない apply が
  # 構成の値に戻すこと**に依存している。置くと Terraform がその drift を無視し、
  # **どちらの箇条でも api を止めたまま全断が続く。** validate も plan も CI も落ちない。
  desired_count                     = local.api_task_count
  launch_type                       = "FARGATE"
  health_check_grace_period_seconds = local.api_health_check_grace_seconds
  enable_execute_command            = local.api_enable_execute_command

  network_configuration {
    subnets          = aws_subnet.public[*].id
    security_groups  = [aws_security_group.task.id]
    assign_public_ip = local.task_assign_public_ip
  }

  deployment_circuit_breaker {
    enable   = local.api_deployment_circuit_breaker_rollback
    rollback = local.api_deployment_circuit_breaker_rollback
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.api.arn
    container_name   = "api"
    container_port   = local.api_port
  }

  # ターゲットグループがリスナーに付いてからでないと、サービスの作成が失敗する。
  depends_on = [aws_lb_listener.api_http]
}
