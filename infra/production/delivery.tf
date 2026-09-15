# CloudFront の配信（#452）。技術スタックのフロント配信の行・「HTTPS とドメイン」と、「リソースのサイジング」の CloudFront の行。
# 踏むと壊れる: このファイルにも main.tf の冒頭の検査の条件が掛かる（apps/api/src/config/api-config-infra.test.ts）。
#
# 最初のリリースのビヘイビアは、既定（web の静的配信のバケット）と /api/*（ALB。VPC オリジン）の2つである。
# /files/*・/avatars/*（添付のバケット）は、添付とアバターの配信（F-29・F-04。署名付き Cookie の鍵は #427）を実装するときに足す。

# 踏むと壊れる: 技術スタックと要件定義書が決めた値は、この locals にだけ書く（下のブロックには、名前・識別子・説明のほかに
# リテラルの値を書かない）。どの値も、変えても validate も plan も CI も落ちない。変えるときは、文書の行を先に直す。
locals {
  # 閲覧者から CloudFront までは HTTPS を必須にする（技術スタックの「HTTPS とドメイン」）。
  # 画面は http を https に振り替え、api は https だけを受ける（POST を振り替えると本体が落ちるため）。
  web_viewer_protocol_policy = "redirect-to-https"
  api_viewer_protocol_policy = "https-only"

  # api は /api の下にある（#77。apps/api/src/app-setup.ts の setGlobalPrefix）。WebSocket（/api/socket.io/）も同じビヘイビアに載る。
  api_path_pattern = "/api/*"

  # CloudFront から ALB までは HTTP（技術スタックの「HTTPS とドメイン」）。VPC オリジンは https のポートも要するが使わない。
  api_origin_protocol_policy = "http-only"
  api_origin_https_port      = 443
  api_origin_ssl_protocols   = ["TLSv1.2"]

  web_default_root_object = "index.html"

  # web のバケットはビルドの成果物だけを持ち、destroy で中身ごと消す（ソースから作り直せる）。
  web_force_destroy       = true
  web_block_public_access = true
}

# --- web の静的配信のバケット ------------------------------------------------------

resource "aws_s3_bucket" "web" {
  # バケット名はすべての AWS アカウントで一意である。アカウント ID を含めて衝突を避ける。
  bucket        = "workspace-chat-web-${data.aws_caller_identity.current.account_id}"
  force_destroy = local.web_force_destroy
}

resource "aws_s3_bucket_public_access_block" "web" {
  bucket = aws_s3_bucket.web.id

  block_public_acls       = local.web_block_public_access
  block_public_policy     = local.web_block_public_access
  ignore_public_acls      = local.web_block_public_access
  restrict_public_buckets = local.web_block_public_access
}

resource "aws_cloudfront_origin_access_control" "web" {
  name                              = "workspace-chat-web"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# CloudFront（このディストリビューション）からの読み出しだけを許す。
# 踏むと壊れる: この文書とバケットのポリシーは IAM の面に入る。変えるときは、main.tf の冒頭の条件に従い、検査の iamSurface の表も直す。
data "aws_iam_policy_document" "web_bucket" {
  statement {
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.web.arn}/*"]

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
}

resource "aws_s3_bucket_policy" "web" {
  bucket = aws_s3_bucket.web.id
  policy = data.aws_iam_policy_document.web_bucket.json
}

# 画面の URL（拡張子の無いパス）を web の入口（/index.html）に書き換える。コードと検査は functions/spa-rewrite.js と
# scripts/cloudfront-functions.test.mjs。/api/* はこの関数を通らない（既定のビヘイビアにだけ付ける）。
resource "aws_cloudfront_function" "spa_rewrite" {
  name    = "workspace-chat-spa-rewrite"
  runtime = "cloudfront-js-2.0"
  publish = true
  code    = file("${path.module}/functions/spa-rewrite.js")
}

# --- api（ALB。VPC オリジン） ------------------------------------------------------

resource "aws_cloudfront_vpc_origin" "api" {
  vpc_origin_endpoint_config {
    name                   = "workspace-chat-api"
    arn                    = aws_lb.api.arn
    http_port              = local.alb_listener_port
    https_port             = local.api_origin_https_port
    origin_protocol_policy = local.api_origin_protocol_policy

    origin_ssl_protocols {
      items    = local.api_origin_ssl_protocols
      quantity = length(local.api_origin_ssl_protocols)
    }
  }
}

# VPC オリジンを作ると、AWS が CloudFront-VPCOrigins-Service-SG を作る。ALB の受信はそこからだけにする
# （AWS の文書「Allow traffic from the CloudFront service-managed security group (`CloudFront-VPCOrigins-Service-SG`).
# This can be done only after the VPC origin is created」）。depends_on で、読み出しを VPC オリジンの作成の後に遅らせる。
data "aws_security_group" "cloudfront_vpc_origin" {
  vpc_id = aws_vpc.main.id

  filter {
    name   = "group-name"
    values = ["CloudFront-VPCOrigins-Service-SG"]
  }

  depends_on = [aws_cloudfront_vpc_origin.api]
}

# 踏むと壊れる: ALB への受信は CloudFront の VPC オリジンからだけにする。広げると CloudFront を経ずに api へ届き、
# X-Forwarded-For を偽ってレート制限を迂回できる（技術スタックの代償。TRUST_PROXY_HOPS=2 の前提）。
resource "aws_vpc_security_group_ingress_rule" "alb_from_cloudfront" {
  security_group_id            = aws_security_group.alb.id
  referenced_security_group_id = data.aws_security_group.cloudfront_vpc_origin.id
  ip_protocol                  = "tcp"
  from_port                    = local.alb_listener_port
  to_port                      = local.alb_listener_port
}

# --- ディストリビューション ----------------------------------------------------------

data "aws_cloudfront_cache_policy" "caching_optimized" {
  name = "Managed-CachingOptimized"
}

data "aws_cloudfront_cache_policy" "caching_disabled" {
  name = "Managed-CachingDisabled"
}

# WebSocket のハンドシェイクのヘッダー（Sec-WebSocket-Key など）を含め、閲覧者の要求のヘッダーをすべて ALB へ渡す
# （AWS の文書「You can use the AllViewer managed origin request policy」）。
data "aws_cloudfront_origin_request_policy" "all_viewer" {
  name = "Managed-AllViewer"
}

resource "aws_cloudfront_distribution" "main" {
  enabled             = true
  default_root_object = local.web_default_root_object

  origin {
    origin_id                = "web"
    domain_name              = aws_s3_bucket.web.bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.web.id
  }

  origin {
    origin_id   = "api"
    domain_name = aws_lb.api.dns_name

    vpc_origin_config {
      vpc_origin_id = aws_cloudfront_vpc_origin.api.id
    }
  }

  default_cache_behavior {
    target_origin_id       = "web"
    viewer_protocol_policy = local.web_viewer_protocol_policy
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    cache_policy_id        = data.aws_cloudfront_cache_policy.caching_optimized.id

    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.spa_rewrite.arn
    }
  }

  ordered_cache_behavior {
    path_pattern             = local.api_path_pattern
    target_origin_id         = "api"
    viewer_protocol_policy   = local.api_viewer_protocol_policy
    allowed_methods          = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
    cached_methods           = ["GET", "HEAD"]
    cache_policy_id          = data.aws_cloudfront_cache_policy.caching_disabled.id
    origin_request_policy_id = data.aws_cloudfront_origin_request_policy.all_viewer.id
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  # 独自ドメインを持たず、CloudFront の既定のドメインの証明書を使う（技術スタックの「HTTPS とドメイン」）。
  viewer_certificate {
    cloudfront_default_certificate = true
  }
}

output "web_url" {
  description = "公開する URL（CloudFront の既定のドメイン）"
  value       = "https://${aws_cloudfront_distribution.main.domain_name}"
}

output "web_bucket" {
  description = "web のビルドの成果物（apps/web/dist）を置くバケット"
  value       = aws_s3_bucket.web.bucket
}
