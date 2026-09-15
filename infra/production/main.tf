# 本番の構成（#452）。state は infra/bootstrap が作るバケットに置く。
#
# バケット名はアカウント ID を含むため構成に書かず、init のときに渡す:
#   terraform -chdir=infra/production init -backend-config="bucket=$(terraform -chdir=infra/bootstrap output -raw state_bucket)"

terraform {
  # 1.11 以上: S3 バックエンドの use_lockfile と write-only 引数（技術スタック「インフラ（AWS）」の IaC の行）。
  required_version = ">= 1.11"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 6.62"
    }
    # 3.7.1 以上: ephemeral の random_password（技術スタック「インフラ（AWS）」の IaC の行）。
    random = {
      source  = "hashicorp/random"
      version = ">= 3.7.1"
    }
  }

  backend "s3" {
    key          = "production/terraform.tfstate"
    region       = "ap-northeast-1"
    use_lockfile = true
  }
}

provider "aws" {
  region = "ap-northeast-1"
}
