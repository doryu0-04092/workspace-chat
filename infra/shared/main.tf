# 環境（production / staging）をまたいで1つだけ持つもの（#685）。state は infra/bootstrap が作るバケットの shared/ に置く:
#   terraform -chdir=infra/shared init -backend-config="bucket=$(terraform -chdir=infra/bootstrap output -raw state_bucket)"
#
# ここに置くもの
# - GitHub Actions の OIDC プロバイダー: URL ごとにアカウントに1つしか作れない。環境ごとの構成に置くと、2つ目の環境の apply でぶつかる
# - ECR: CD（.github/workflows/cd.yml）がイメージを1回だけ作ってここへ push し、ステージングで検証したのと同じイメージを本番へ出す
# - CD のビルド用ロール: ECR への push だけ
# - CD のステージングへのデプロイ用ロール: ステージングの名前とタグに絞った、アプリの更新だけ（#688）
#
# 踏むと壊れる: この構成は環境の destroy の対象にしない。消すと、両方の環境がイメージを取れなくなり、CD が認証に失敗する。
#
# 踏むと壊れる（検査の条件）: apps/api/src/config/api-config-infra.test.ts の「共有の層（infra/shared）の IAM の面」が、このファイルを読む。
# - 構成はこの main.tf だけに書き、ほかの .tf・.tf.json を置かず、module を呼ばない（検査はこのファイルしか読まない）
# - IAM の面（aws_iam_ で始まるブロックと、policy・assume_role_policy を持つブロック）は、検査の表とちょうど同じかで照合する。
#   足す・変えるときは、引き受けられる相手と、できる操作が広がらないことを確かめてから、表も直す。ポリシーは aws_iam_policy_document で書き、
#   policy・assume_role_policy には data.aws_iam_policy_document.<名前>.json だけを渡す
# - 信頼条件の値（github_actions_*・github_repo_main_subject）は、検査が値そのものを照合する

terraform {
  # 1.11 以上: S3 バックエンドの use_lockfile（技術スタック「インフラ（AWS）」の IaC の行）。
  required_version = ">= 1.11"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 6.62"
    }
  }

  backend "s3" {
    key          = "shared/terraform.tfstate"
    region       = "ap-northeast-1"
    use_lockfile = true
  }
}

provider "aws" {
  region = "ap-northeast-1"
}

locals {
  # CD（GitHub Actions）の OIDC 連携（#671）。このロールを引き受けられるのは、この repo の main ブランチへの
  # push で動くワークフローだけに絞る（GitHub の文書「configuring-openid-connect-in-amazon-web-services」が
  # sub 条件でリポジトリ・ブランチを絞ることを勧める）。
  #
  # 踏むと壊れる: sub の値は owner_id・repo_id を含む不変形式にする（#679）。GitHub は 2026-04-23 に
  # 「Immutable subject claims for GitHub Actions OIDC tokens」を導入し、2026-07-15 以降に作成した
  # リポジトリ（このリポジトリは 2026-09-03 作成）は既定でこの形になる
  # （https://github.blog/changelog/2026-04-23-immutable-subject-claims-for-github-actions-oidc-tokens/）。
  # owner_id=292095077・repo_id=1355868496 は `gh api repos/doryu0-04092/workspace-chat` の
  # owner.id・id で確認済み。**ID を外した従来形式（repo:doryu0-04092/workspace-chat:...）には戻さない**
  # ——不変 ID は、リポジトリ名の再利用によるなりすましを防ぐための仕組みであり、外すと導入の意図を打ち消す。
  github_actions_oidc_url  = "https://token.actions.githubusercontent.com"
  github_actions_audience  = "sts.amazonaws.com"
  github_repo_main_subject = "repo:doryu0-04092@292095077/workspace-chat@1355868496:ref:refs/heads/main"

  # OIDC プロバイダーの thumbprint_list は Terraform のリソーススキーマ上は必須だが、AWS はもう検証に使わない
  # （GitHub と AWS が 2024 年末に、証明書チェーンでの検証に切り替えたため）。広く知られている値を置く。
  github_actions_oidc_thumbprint = "6938fd4d98bab03faadb97b34396831e3780aea1"

  # 踏むと壊れる: 名前を変えるときは、infra/production の locals（ecr_*_repository_name）と cd.yml も同じに直す。
  ecr_api_repository_name     = "workspace-chat-api"
  ecr_migrate_repository_name = "workspace-chat-migrate"

  # destroy のときに、イメージが入ったままのリポジトリも消す
  # （プロバイダーの文書「If `true`, will delete the repository even if it contains images.」）。
  ecr_force_delete = true
}

# 踏むと壊れる: 数や日数で古いイメージを消すライフサイクルポリシーを置かない（決定・2026-09-23・作業側。#685）。
# 本番が動かしているイメージは release ブランチのコミットのもので、main へのマージが続くと「古い側」に入る。
# 消えていると、タスクの入れ替え（再起動・秘密の値の入れ替え・サーキットブレーカーのロールバック）でイメージを取れず、本番が止まる。
# 代償: main へのマージのたびにイメージが積み上がり、保管の費用が増え続ける。要らなくなったものは人が消す（要件定義書 4.2「バックアップ」）。

# --- イメージ -----------------------------------------------------------------
#
# apps/api/Dockerfile の段ごとに置き場を分ける（runtime は api のサービス、migrate は run-task の一回きりのタスク）。

resource "aws_ecr_repository" "api" {
  name         = local.ecr_api_repository_name
  force_delete = local.ecr_force_delete
}

resource "aws_ecr_repository" "migrate" {
  name         = local.ecr_migrate_repository_name
  force_delete = local.ecr_force_delete
}

# --- CD（GitHub Actions。#671） ---------------------------------------------------
#
# 長期のアクセスキーを GitHub Secrets に置かない。OIDC でこのロールを引き受け、ECR への push だけを行う。
# 踏むと壊れる: このロールに ECR の push 以外の権限を足さない。秘密のパラメータ（DATABASE_URL 等）には触れさせない。

resource "aws_iam_openid_connect_provider" "github_actions" {
  url             = local.github_actions_oidc_url
  client_id_list  = [local.github_actions_audience]
  thumbprint_list = [local.github_actions_oidc_thumbprint]
}

data "aws_iam_policy_document" "cd_assume" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github_actions.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = [local.github_actions_audience]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = [local.github_repo_main_subject]
    }
  }
}

resource "aws_iam_role" "cd" {
  name               = "workspace-chat-cd"
  assume_role_policy = data.aws_iam_policy_document.cd_assume.json
}

data "aws_iam_policy_document" "cd_ecr" {
  statement {
    # ecr:GetAuthorizationToken はリソースレベルの権限指定に対応しない操作であり、"*" にする
    # （AWS の文書「Amazon ECR EBS direct APIs」の Actions 一覧、GetAuthorizationToken の Resource types は "All resources"）。
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:PutImage",
      "ecr:InitiateLayerUpload",
      "ecr:UploadLayerPart",
      "ecr:CompleteLayerUpload",
    ]
    resources = [aws_ecr_repository.api.arn, aws_ecr_repository.migrate.arn]
  }
}

resource "aws_iam_role_policy" "cd_ecr" {
  name   = "ecr-push"
  role   = aws_iam_role.cd.id
  policy = data.aws_iam_policy_document.cd_ecr.json
}

# --- CD のステージングへのデプロイ（#688） ------------------------------------------------
#
# scripts/deploy-staging.sh が、main へのマージのたびに引き受ける。Terraform は流さず、ステージングのアプリだけを更新する
# （タスク定義の新しい版の登録・マイグレーションの run-task・サービスの更新・web の配置・CloudFront の無効化）。
#
# 踏むと壊れる: 権限は、ステージングの名前（staging_name）とタグ（Environment=staging）に絞る。同じアカウントに本番があり、
# 絞りを外すと、main へのマージが人の確認なしに本番を書き換えうる。名前は infra/production/main.tf の local.name の規則と、
# scripts/deploy-staging.sh の name と揃える。
# 資源を指定できない操作（DescribeTaskDefinition・ListDistributions）は読み取りだけである
# （AWS の Service Reference の ecs.json・cloudfront.json で、この2つの Resources が空であることを確かめた。2026-09-23）。

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

locals {
  staging_name = "workspace-chat-staging"
  ecs_arn      = "arn:aws:ecs:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}"
}

resource "aws_iam_role" "staging_deploy" {
  name               = "${local.staging_name}-deploy"
  assume_role_policy = data.aws_iam_policy_document.cd_assume.json
}

data "aws_iam_policy_document" "staging_deploy" {
  statement {
    sid       = "FindStaging"
    actions   = ["ecs:DescribeClusters"]
    resources = ["${local.ecs_arn}:cluster/${local.staging_name}"]
  }

  statement {
    sid       = "ReadTaskDefinitions"
    actions   = ["ecs:DescribeTaskDefinition", "cloudfront:ListDistributions"]
    resources = ["*"]
  }

  statement {
    sid = "RegisterStagingTaskDefinitions"
    # ListTagsForResource は、describe-task-definition --include TAGS でタグを読むため（要るかは未確認。読み取りだけに絞って付ける）。
    actions   = ["ecs:RegisterTaskDefinition", "ecs:ListTagsForResource"]
    resources = ["${local.ecs_arn}:task-definition/${local.staging_name}-*:*"]
  }

  statement {
    # 登録のときにタグ（default_tags の Project・Environment）を付けるには TagResource も要る。登録と同時の付与だけに絞る。
    sid       = "TagOnRegister"
    actions   = ["ecs:TagResource"]
    resources = ["${local.ecs_arn}:task-definition/${local.staging_name}-*:*"]

    condition {
      test     = "StringEquals"
      variable = "ecs:CreateAction"
      values   = ["RegisterTaskDefinition"]
    }
  }

  statement {
    sid       = "RunStagingMigration"
    actions   = ["ecs:RunTask"]
    resources = ["${local.ecs_arn}:task-definition/${local.staging_name}-migrate:*"]

    condition {
      test     = "ArnEquals"
      variable = "ecs:cluster"
      values   = ["${local.ecs_arn}:cluster/${local.staging_name}"]
    }
  }

  statement {
    sid       = "WatchStagingTasks"
    actions   = ["ecs:DescribeTasks"]
    resources = ["${local.ecs_arn}:task/${local.staging_name}/*"]
  }

  statement {
    sid       = "UpdateStagingService"
    actions   = ["ecs:DescribeServices", "ecs:UpdateService"]
    resources = ["${local.ecs_arn}:service/${local.staging_name}/${local.staging_name}-api"]
  }

  statement {
    sid       = "PassStagingRoles"
    actions   = ["iam:PassRole"]
    resources = ["arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/${local.staging_name}-*"]

    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["ecs-tasks.amazonaws.com"]
    }
  }

  statement {
    sid       = "ListStagingWeb"
    actions   = ["s3:ListBucket"]
    resources = ["arn:aws:s3:::${local.staging_name}-web-${data.aws_caller_identity.current.account_id}"]
  }

  statement {
    sid       = "WriteStagingWeb"
    actions   = ["s3:PutObject", "s3:DeleteObject"]
    resources = ["arn:aws:s3:::${local.staging_name}-web-${data.aws_caller_identity.current.account_id}/*"]
  }

  statement {
    sid       = "InvalidateStagingCache"
    actions   = ["cloudfront:CreateInvalidation", "cloudfront:GetInvalidation"]
    resources = ["arn:aws:cloudfront::${data.aws_caller_identity.current.account_id}:distribution/*"]

    # ディストリビューションの ARN は ID だけで名前を含まないため、タグで絞る（infra/production の default_tags）。
    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/Environment"
      values   = ["staging"]
    }
  }
}

resource "aws_iam_role_policy" "staging_deploy" {
  name   = "staging-deploy"
  role   = aws_iam_role.staging_deploy.id
  policy = data.aws_iam_policy_document.staging_deploy.json
}

output "staging_deploy_role_arn" {
  description = "CD のステージングへのデプロイ（cd.yml の deploy-staging）が引き受けるロール。値を AWS_STAGING_DEPLOY_ROLE_ARN という名前の GitHub の Secret に手動で設定する（#688）"
  value       = aws_iam_role.staging_deploy.arn
}

output "ecr_api_repository_url" {
  description = "api のイメージ（apps/api/Dockerfile の runtime 段）を push する先"
  value       = aws_ecr_repository.api.repository_url
}

output "ecr_migrate_repository_url" {
  description = "マイグレーション用のイメージ（apps/api/Dockerfile の migrate 段）を push する先"
  value       = aws_ecr_repository.migrate.repository_url
}

output "cd_role_arn" {
  description = "GitHub Actions の CD（cd.yml）が OIDC で引き受けるロール。値を AWS_CD_ROLE_ARN という名前の GitHub の Secret に手動で設定する（#671・#672）"
  value       = aws_iam_role.cd.arn
}
