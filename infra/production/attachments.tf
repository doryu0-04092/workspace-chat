# 添付ファイルとアバター画像の S3 バケット（#452）。技術スタックの「添付ファイル」の行と、機能一覧 11.1・1.3。
#
# 配信は CloudFront 経由だけ、アップロードはブラウザから署名付き URL で `quarantine/` へ直接 PUT する。
# バケットポリシー（書く主体の分け方）と CORS は、添付とアバターのアップロードと確定を実装するときに足す（F-29・F-04。#427）。

data "aws_caller_identity" "current" {}

resource "aws_s3_bucket" "attachments" {
  # バケット名はすべての AWS アカウントで一意である。アカウント ID を含めて衝突を避ける。
  bucket = "workspace-chat-attachments-${data.aws_caller_identity.current.account_id}"

  # destroy で旧バージョンとデリートマーカーごと消す（要件定義書 4.2。個人情報を destroy の外に残さない）。
  force_destroy = true
}

# 誤削除に備える（要件定義書 4.2「バックアップ」）。
resource "aws_s3_bucket_versioning" "attachments" {
  bucket = aws_s3_bucket.attachments.id

  versioning_configuration {
    status = "Enabled"
  }
}

# パブリックアクセスを全面的に遮断する（要件定義書 4.3 のストレージの行）。
resource "aws_s3_bucket_public_access_block" "attachments" {
  bucket = aws_s3_bucket.attachments.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# ライフサイクルは `quarantine/` にだけ置く（機能一覧 11.1。要件定義書 4.2 の「ライフサイクルは置かない」の例外）。
# 確定されずに放置されたものと、上書き・削除で古くなった版を失効させる。
#
# 踏むと壊れる: フィルターの接頭辞を広げない・消さない。ライフサイクルの削除はバケットポリシーでは止められず、
# 配信用のキー（`workspace/`・`avatars/`）に掛かると、投稿済みの添付とアバターが消える。
resource "aws_s3_bucket_lifecycle_configuration" "attachments" {
  bucket = aws_s3_bucket.attachments.id

  rule {
    id     = "quarantine"
    status = "Enabled"

    filter {
      prefix = "quarantine/"
    }

    expiration {
      days = 1
    }

    noncurrent_version_expiration {
      noncurrent_days = 1
    }
  }
}
