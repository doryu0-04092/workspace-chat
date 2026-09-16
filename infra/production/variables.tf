# apply のときに渡す値（#452）。秘密ではないが、使う環境ごとに決まるためリポジトリに書かない。
# 踏むと壊れる: このファイルにも main.tf の冒頭の検査の条件が掛かる（apps/api/src/config/api-config-infra.test.ts）。

variable "image_tag" {
  description = "ECR に push した api のイメージとマイグレーション用のイメージのタグ。同じソースから作った2つのイメージに同じタグを付ける"
  type        = string
}

variable "alarm_email" {
  description = "アラートの通知先のメールアドレス（要件定義書 4.2「アラート」。購読の確認は依頼側が行う）"
  type        = string
}
