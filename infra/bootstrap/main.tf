# Terraform の state を置く S3 バケット（#452）。本体の構成（infra/production）の外で先に作る
# （技術スタック「本番の HTTPS・秘密情報・state の置き場」）。
#
# この構成の state は手元のファイルに置く（.gitignore の *.tfstate）。作る前のバケットは置き場にできない。

terraform {
  required_version = ">= 1.11"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 6.62"
    }
  }
}

provider "aws" {
  region = "ap-northeast-1"
}

data "aws_caller_identity" "current" {}

resource "aws_s3_bucket" "state" {
  # バケット名はすべての AWS アカウントで一意である。アカウント ID を含めて衝突を避ける。
  bucket = "workspace-chat-tfstate-${data.aws_caller_identity.current.account_id}"

  # destroy の対象外として残す（要件定義書 4.2「バックアップ」）。
  lifecycle {
    prevent_destroy = true
  }
}

# パブリックアクセスを全面的に遮断する（要件定義書 4.3 のストレージの行）。
resource "aws_s3_bucket_public_access_block" "state" {
  bucket = aws_s3_bucket.state.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# 誤削除と誤った書き込みから state を戻す（要件定義書 4.2「バックアップ」・「復旧手順」）。
resource "aws_s3_bucket_versioning" "state" {
  bucket = aws_s3_bucket.state.id

  versioning_configuration {
    status = "Enabled"
  }
}

# 踏むと壊れる: **要件定義書 4.2「秘密の値が漏れた疑いがあるとき」の共通の前置きが、この出力を state_bucket という名前で読む**
# （terraform -chdir=infra/bootstrap output -raw state_bucket）。名前を変えると、その段の init が backend を初期化できない。
output "state_bucket" {
  value = aws_s3_bucket.state.bucket
}
