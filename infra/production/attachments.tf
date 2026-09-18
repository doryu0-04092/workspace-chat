# 添付ファイルとアバター画像の S3 バケット（#452）。技術スタックの「添付ファイル」の行と、機能一覧 11.1・1.3。
#
# 配信は CloudFront 経由だけ、アップロードはブラウザから署名付き URL で `quarantine/` へ直接 PUT する。
# 書く主体は compute.tf のロールで分ける（署名者 upload_signer は quarantine/ だけ、確定の api_task は配信用の接頭辞だけ。#427）。
# 踏むと壊れる: このファイルにも main.tf の冒頭の検査の条件が掛かる（apps/api/src/config/api-config-infra.test.ts）。
# バケットポリシーは IAM の面に入る——変えるときは、その条件に従い、検査の iamSurface の表も直す。

# 踏むと壊れる: 技術スタックと要件定義書が決めた値は、この locals にだけ書く（下のブロックには、名前・識別子・説明のほかに
# リテラルの値を書かない）。どの値も、変えても validate も plan も CI も落ちない。変えるときは、文書の行を先に直す。
locals {
  # ブラウザから S3 へ直接送るのは、隔離用のキーへの署名付き URL の PUT だけである（機能一覧 11.1）。
  # 送るヘッダーは、署名に含めた Content-Type と If-None-Match（同 11.1）。
  attachments_cors_allowed_methods = ["PUT"]
  attachments_cors_allowed_headers = ["content-type", "if-none-match"]
  # プリフライトの結果をブラウザが覚える秒数（作業側の決定。アップロードのたびにプリフライトを重ねない長さ）。
  attachments_cors_max_age_seconds = 600
}

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

# 踏むと壊れる: このバケットを「CloudFront の OAC からのみ」に閉じない（読み出し・書き込みを CloudFront の他に Deny する形にしない）。
# 閉じると、ブラウザから quarantine/ への署名付き URL の PUT が通らない（要件定義書 4.3 のアップロードの行・技術スタックの添付ファイルの行。#176・#427）。
# この誤りは validate でも plan でも落ちず、apply の後にアップロードが通らなくなって初めて分かる。
#
# 1つ目: CloudFront（このディストリビューション）は、配信用の接頭辞（avatars/・workspace/）だけを読める。quarantine/ は配信 URL を持たない。
# 2つ目: 配信用の接頭辞へ書けるのは、確定の主体（api のタスクロール）だけ。ロールのポリシーを誤って広げても、署名者やほかの主体からは書けない
#        （書く主体で分ける。接頭辞だけで閉じると、確定のコピーも宛先の PutObject が拒否される。技術スタックの添付ファイルの行）。
data "aws_iam_policy_document" "attachments_bucket" {
  statement {
    actions = ["s3:GetObject"]
    resources = [
      "${aws_s3_bucket.attachments.arn}/avatars/*",
      "${aws_s3_bucket.attachments.arn}/workspace/*",
    ]

    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.main.arn]
    }
  }

  statement {
    effect  = "Deny"
    actions = ["s3:PutObject"]
    resources = [
      "${aws_s3_bucket.attachments.arn}/avatars/*",
      "${aws_s3_bucket.attachments.arn}/workspace/*",
    ]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    condition {
      test     = "ArnNotEquals"
      variable = "aws:PrincipalArn"
      values   = [aws_iam_role.api_task.arn]
    }
  }
}

resource "aws_s3_bucket_policy" "attachments" {
  bucket = aws_s3_bucket.attachments.id
  policy = data.aws_iam_policy_document.attachments_bucket.json
}

# ブラウザからの PUT を、web の origin（CloudFront の既定のドメイン）にだけ許す。
resource "aws_s3_bucket_cors_configuration" "attachments" {
  bucket = aws_s3_bucket.attachments.id

  cors_rule {
    allowed_methods = local.attachments_cors_allowed_methods
    allowed_origins = [local.web_origin]
    allowed_headers = local.attachments_cors_allowed_headers
    max_age_seconds = local.attachments_cors_max_age_seconds
  }
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
