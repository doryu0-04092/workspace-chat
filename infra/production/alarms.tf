# アラート（#452・#477）。要件定義書 4.2「アラート」と 4.6 の監視項目。
# 通知先は SNS のメール購読（決定・2026-09-12・依頼側。送れるところまで作り、購読の確認は依頼側が行う）。夜間・休日の対応はしない。
# 踏むと壊れる: このファイルにも main.tf の冒頭の検査の条件が掛かる（apps/api/src/config/api-config-infra.test.ts）。
#
# 踏むと壊れる: **要件定義書 4.2「秘密の値が漏れた疑いがあるとき」の手順が、このファイルの3つの値を前提にしている。**
# どれも locals の外にあり、**変えても validate も plan も CI も落ちない。**
#  1. aws_sns_topic.alerts の name（workspace-chat-alerts）——**手順の共通の前置きが、この名前をリテラルで打って
#     TF_VAR_alarm_email を引く**。変えると引きが空になり、**空でも変数は「設定済み」になるため apply は聞き返さず、
#     endpoint = "" で落ちる**（前置きは空を弾く段を持つが、名前を変えたことに気づく経路はそこだけである）
#  2. 5xx 率の treat_missing_data = "notBreaching"——手順は「**要求の来ない時間帯なら、全断でも鳴らない**」と書いている。
#     breaching に変えると、その記述が逆になる
#  3. Valkey のメトリクス欠損の treat_missing_data = "breaching"——手順は「**鳴るのは作り直しの区間だけ**」
#     「アラートが収まったことを終わった合図と読まないこと」と書いている。この値でしか成り立たない

# 閾値は Terraform に置き、文書に数値を書かない（要件定義書 4.2「アラート」）。
# 踏むと壊れる: どの値も、変えても validate も plan も CI も落ちない。変えるときは要件定義書 4.2「アラート」の意図に照らす。
locals {
  alarm_period_seconds = 300

  # 5xx 率（ALB の 5xx とターゲットの 5xx を、要求の数で割った割合。単位は %）。タスクの全断は ALB が返す 503 で捕まえる——
  # 健全なターゲットが無いときの 503 は RequestCount に数えられない（AWS の ALB のメトリクスの文書「This metric is only incremented for
  # requests where the load balancer node was able to choose a target.」）ため、分母に ALB の 5xx を足し、全断のとき 100% にする。
  alarm_5xx_rate_threshold_percent  = 5
  alarm_5xx_rate_evaluation_periods = 2

  # RDS の CPU 使用率（%）。応答が遅くなる前に気づく。
  alarm_rds_cpu_threshold_percent  = 80
  alarm_rds_cpu_evaluation_periods = 3

  # Valkey のメトリクス欠損。CurrConnections の欠測を breaching として扱い、欠損そのものを発火条件にする。
  # 値の閾値は使わない（接続数は 0 未満にならないため、0 未満を条件にしておく）。
  alarm_valkey_evaluation_periods = 2
  alarm_valkey_value_never_below  = 0

  # 構造化ログの件数（どちらも正規の利用者でも起きるため、1件では鳴らさない）。
  alarm_rate_limit_exceeded_threshold = 20
  alarm_refresh_token_reuse_threshold = 3
  alarm_log_evaluation_periods        = 1

  # 構造化ログを数えるメトリクスの置き場。
  log_metric_namespace = "WorkspaceChat"
}

# トピックに発行を許すポリシー（aws_sns_topic_policy など）は IAM の面に入る——足すときは、main.tf の冒頭の条件に従い、検査の iamSurface の表も直す。
resource "aws_sns_topic" "alerts" {
  name = "workspace-chat-alerts"
}

resource "aws_sns_topic_subscription" "alerts_email" {
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.alarm_email
}

# --- 5xx 率（ALB のメトリクスから取る。要件定義書 4.2「アラート」の決定） -----------------

resource "aws_cloudwatch_metric_alarm" "alb_5xx_rate" {
  alarm_name          = "workspace-chat-alb-5xx-rate"
  alarm_description   = "5xx rate of the api ALB"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = local.alarm_5xx_rate_evaluation_periods
  threshold           = local.alarm_5xx_rate_threshold_percent
  # 要求が無い時間帯は割合が求まらない。鳴らさない。
  treat_missing_data = "notBreaching"
  alarm_actions      = [aws_sns_topic.alerts.arn]
  ok_actions         = [aws_sns_topic.alerts.arn]

  metric_query {
    id          = "rate"
    expression  = "100 * (FILL(elb5xx, 0) + FILL(target5xx, 0)) / (FILL(requests, 0) + FILL(elb5xx, 0))"
    label       = "5xx rate (%)"
    return_data = true
  }

  metric_query {
    id = "requests"
    metric {
      namespace   = "AWS/ApplicationELB"
      metric_name = "RequestCount"
      period      = local.alarm_period_seconds
      stat        = "Sum"
      dimensions  = { LoadBalancer = aws_lb.api.arn_suffix }
    }
  }

  metric_query {
    id = "elb5xx"
    metric {
      namespace   = "AWS/ApplicationELB"
      metric_name = "HTTPCode_ELB_5XX_Count"
      period      = local.alarm_period_seconds
      stat        = "Sum"
      dimensions  = { LoadBalancer = aws_lb.api.arn_suffix }
    }
  }

  metric_query {
    id = "target5xx"
    metric {
      namespace   = "AWS/ApplicationELB"
      metric_name = "HTTPCode_Target_5XX_Count"
      period      = local.alarm_period_seconds
      stat        = "Sum"
      dimensions  = { LoadBalancer = aws_lb.api.arn_suffix }
    }
  }
}

# --- RDS の CPU ------------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "rds_cpu" {
  alarm_name          = "workspace-chat-rds-cpu"
  alarm_description   = "CPU utilization of the RDS instance"
  namespace           = "AWS/RDS"
  metric_name         = "CPUUtilization"
  statistic           = "Average"
  period              = local.alarm_period_seconds
  dimensions          = { DBInstanceIdentifier = aws_db_instance.main.identifier }
  comparison_operator = "GreaterThanThreshold"
  threshold           = local.alarm_rds_cpu_threshold_percent
  evaluation_periods  = local.alarm_rds_cpu_evaluation_periods
  treat_missing_data  = "missing"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}

# --- Valkey のメトリクス欠損（決定。#140） ------------------------------------------------
#
# エンジンに到達できない間は CurrConnections の発行が止まり、値は 0 ではなく欠損になる（要件定義書 4.2「アラート」）。

resource "aws_cloudwatch_metric_alarm" "valkey_metrics_missing" {
  alarm_name          = "workspace-chat-valkey-metrics-missing"
  alarm_description   = "CurrConnections of Valkey is missing"
  namespace           = "AWS/ElastiCache"
  metric_name         = "CurrConnections"
  statistic           = "Average"
  period              = local.alarm_period_seconds
  dimensions          = { CacheClusterId = sort(tolist(aws_elasticache_replication_group.valkey.member_clusters))[0] }
  comparison_operator = "LessThanThreshold"
  threshold           = local.alarm_valkey_value_never_below
  evaluation_periods  = local.alarm_valkey_evaluation_periods
  treat_missing_data  = "breaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}

# --- 構造化ログを数える（rate_limit_exceeded・refresh_token_reuse） --------------------------
#
# api のログは1行1件の JSON で、logger.warn({ event: ... }) の中身は message に入る（apps/api/src/logging/json-logger.ts）。
# 踏むと壊れる: api のログのイベント名（apps/api/src/error-response.ts・channel-rooms.gateway.ts の rate_limit_exceeded、
# auth/session.service.ts の refresh_token_reuse）を変えると、数えられなくなってもどの検査も落ちない。

resource "aws_cloudwatch_log_metric_filter" "rate_limit_exceeded" {
  name           = "workspace-chat-rate-limit-exceeded"
  log_group_name = aws_cloudwatch_log_group.api.name
  pattern        = "{ $.message.event = \"rate_limit_exceeded\" }"

  metric_transformation {
    name      = "RateLimitExceeded"
    namespace = local.log_metric_namespace
    value     = "1"
  }
}

resource "aws_cloudwatch_metric_alarm" "rate_limit_exceeded" {
  alarm_name          = "workspace-chat-rate-limit-exceeded"
  alarm_description   = "rate_limit_exceeded in the api logs"
  namespace           = local.log_metric_namespace
  metric_name         = aws_cloudwatch_log_metric_filter.rate_limit_exceeded.metric_transformation[0].name
  statistic           = "Sum"
  period              = local.alarm_period_seconds
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = local.alarm_rate_limit_exceeded_threshold
  evaluation_periods  = local.alarm_log_evaluation_periods
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_log_metric_filter" "refresh_token_reuse" {
  name           = "workspace-chat-refresh-token-reuse"
  log_group_name = aws_cloudwatch_log_group.api.name
  pattern        = "{ $.message.event = \"refresh_token_reuse\" }"

  metric_transformation {
    name      = "RefreshTokenReuse"
    namespace = local.log_metric_namespace
    value     = "1"
  }
}

resource "aws_cloudwatch_metric_alarm" "refresh_token_reuse" {
  alarm_name          = "workspace-chat-refresh-token-reuse"
  alarm_description   = "refresh_token_reuse in the api logs"
  namespace           = local.log_metric_namespace
  metric_name         = aws_cloudwatch_log_metric_filter.refresh_token_reuse.metric_transformation[0].name
  statistic           = "Sum"
  period              = local.alarm_period_seconds
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = local.alarm_refresh_token_reuse_threshold
  evaluation_periods  = local.alarm_log_evaluation_periods
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
}
