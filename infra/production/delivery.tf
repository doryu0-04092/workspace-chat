# CloudFront の配信（#452）。技術スタックのフロント配信の行・「HTTPS とドメイン」と、「リソースのサイジング」の CloudFront の行。
# 踏むと壊れる: このファイルにも main.tf の冒頭の検査の条件が掛かる（apps/api/src/config/api-config-infra.test.ts）。
#
# ビヘイビアは4つ: 既定（web の静的配信のバケット）・/api/*（ALB。VPC オリジン）・/files/* と /avatars/*（添付のバケット。署名付き Cookie を要求する。
# 添付とアバターの配信。機能一覧 11.2・1.3。鍵は #427）。

# 踏むと壊れる: 技術スタックと要件定義書が決めた値は、この locals にだけ書く（下のブロックには、名前・識別子・説明のほかに
# リテラルの値を書かない）。どの値も、変えても validate も plan も CI も落ちない。変えるときは、文書の行を先に直す。
locals {
  # web の origin（api の WEB_ORIGIN と、添付のバケットの CORS が許す origin）。独自ドメインを持たない（技術スタックの「HTTPS とドメイン」）。
  web_origin = "https://${aws_cloudfront_distribution.main.domain_name}"

  # 添付とアバターの配信（要件定義書 4.3 の表。機能一覧 11.2・1.3）。どちらも署名付き Cookie を要求し、添付のバケットへ渡す。
  # /files/* は /files を剥がして渡し（functions/strip-files-prefix.js）、/avatars/* は剥がさない（キーが avatars/ で始まる）。
  # 踏むと壊れる: どちらのパスも /* に広げない。署名を要求しない既定のビヘイビアを添付のバケットへ向けない（/files を外した URL で取得できてしまう）。
  files_path_pattern                 = "/files/*"
  avatars_path_pattern               = "/avatars/*"
  attachments_viewer_protocol_policy = "redirect-to-https"

  # 署名付き Cookie の公開鍵（#427）。鍵の対は Terraform の外で作り（scripts/cloudfront-signing-key.sh）、公開鍵を keys/<名前>.pem に置く。
  # keys/ の PEM はすべてキーグループに入る（入れ替えの間は新旧の2つを置き、配信を止めない）。
  cloudfront_public_key_names = toset([for file in fileset("${path.module}/keys", "*.pem") : trimsuffix(file, ".pem")])
  # api が署名に使う鍵の名前（keys/<名前>.pem）。Parameter Store の秘密鍵（compute.tf の cloudfront_private_key_parameter_name）と対のもの。
  # 踏むと壊れる: スクリプトの既定の名前と揃える（検査が照合する）。この名前と Parameter Store の秘密鍵が対でないと、
  # api は起動するが、発行した Cookie がすべて署名の検査に落ちる（validate も plan も CI も落ちない）。
  cloudfront_signing_key_name = "signing-1"

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

# --- 添付とアバターの配信（添付のバケット。署名付き Cookie） ------------------------------------
#
# バケットとそのポリシーは attachments.tf にある。

resource "aws_cloudfront_origin_access_control" "attachments" {
  name                              = "workspace-chat-attachments"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# 公開鍵は秘密ではない。秘密鍵は Terraform の外で Parameter Store に置き、ここでは読まない（#427）。
resource "aws_cloudfront_public_key" "signing" {
  for_each = local.cloudfront_public_key_names

  name        = "workspace-chat-${each.key}"
  encoded_key = file("${path.module}/keys/${each.key}.pem")
}

resource "aws_cloudfront_key_group" "signed_cookies" {
  name  = "workspace-chat-signed-cookies"
  items = [for key in aws_cloudfront_public_key.signing : key.id]

  lifecycle {
    precondition {
      condition     = contains(local.cloudfront_public_key_names, local.cloudfront_signing_key_name)
      error_message = "keys/ に api が署名に使う公開鍵（cloudfront_signing_key_name の PEM）が無い。scripts/cloudfront-signing-key.sh で鍵の対を作る"
    }
  }
}

# /files/* の要求から /files を剥がし、S3 のキーと同じ形にする（要件定義書 4.3。剥がせるのは viewer-request で URI を書き換える手段だけ）。
# コードと検査は functions/strip-files-prefix.js と scripts/cloudfront-functions.test.mjs。
resource "aws_cloudfront_function" "strip_files_prefix" {
  name    = "workspace-chat-strip-files-prefix"
  runtime = "cloudfront-js-2.0"
  publish = true
  code    = file("${path.module}/functions/strip-files-prefix.js")
}

# すべての応答に X-Content-Type-Options: nosniff を返す（機能一覧 11.1・1.3）。
data "aws_cloudfront_response_headers_policy" "security_headers" {
  name = "Managed-SecurityHeadersPolicy"
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
    origin_id                = "attachments"
    domain_name              = aws_s3_bucket.attachments.bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.attachments.id
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

  # 添付（機能一覧 11.2）。Cookie の対象は /files/workspace/{ws}/channel/{ch}/*、Path 属性は /files（api が発行する）。
  # 署名付き Cookie は CloudFront が確かめ、オリジンへは渡さない（キャッシュキーに Cookie を含めない CachingOptimized でよい）。
  ordered_cache_behavior {
    path_pattern               = local.files_path_pattern
    target_origin_id           = "attachments"
    viewer_protocol_policy     = local.attachments_viewer_protocol_policy
    allowed_methods            = ["GET", "HEAD"]
    cached_methods             = ["GET", "HEAD"]
    cache_policy_id            = data.aws_cloudfront_cache_policy.caching_optimized.id
    response_headers_policy_id = data.aws_cloudfront_response_headers_policy.security_headers.id
    trusted_key_groups         = [aws_cloudfront_key_group.signed_cookies.id]

    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.strip_files_prefix.arn
    }
  }

  # アバター（機能一覧 1.3）。Cookie の対象は /avatars/*、Path 属性は /avatars（ログインしている利用者に発行する）。パスは剥がさない。
  ordered_cache_behavior {
    path_pattern               = local.avatars_path_pattern
    target_origin_id           = "attachments"
    viewer_protocol_policy     = local.attachments_viewer_protocol_policy
    allowed_methods            = ["GET", "HEAD"]
    cached_methods             = ["GET", "HEAD"]
    cache_policy_id            = data.aws_cloudfront_cache_policy.caching_optimized.id
    response_headers_policy_id = data.aws_cloudfront_response_headers_policy.security_headers.id
    trusted_key_groups         = [aws_cloudfront_key_group.signed_cookies.id]
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
  value       = local.web_origin
}

output "web_bucket" {
  description = "web のビルドの成果物（apps/web/dist）を置くバケット"
  value       = aws_s3_bucket.web.bucket
}
