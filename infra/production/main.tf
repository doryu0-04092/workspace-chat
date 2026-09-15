# 本番の構成（#452）。state は infra/bootstrap が作るバケットに置く。
#
# バケット名はアカウント ID を含むため構成に書かず、init のときに渡す:
#   terraform -chdir=infra/production init -backend-config="bucket=$(terraform -chdir=infra/bootstrap output -raw state_bucket)"
#
# 踏むと壊れる: この構成を module に分けず、.tf.json を置かない。apps/api/src/config/api-config-infra.test.ts はこのディレクトリの直下の .tf を読んで
# 秘密の渡し方を確かめるため、module や .tf.json に置いた構成は読めずに検査が落ちる。
# 踏むと壊れる: resource・data のブロックは terraform fmt の形（行頭の `resource "型" "名前" {` から行頭の `}` まで。中身の無いブロックは `{}` の1行）で書く。検査は、書き方を問わずに
# 数えたブロックの数と、この形で読めたブロックの数を突き合わせる。

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
