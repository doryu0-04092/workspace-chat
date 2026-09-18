# 本番の構成（#452）。state は infra/bootstrap が作るバケットに置く。
#
# バケット名はアカウント ID を含むため構成に書かず、init のときに渡す:
#   terraform -chdir=infra/production init -backend-config="bucket=$(terraform -chdir=infra/bootstrap output -raw state_bucket)"
#
# 踏むと壊れる（検査の条件）: apps/api/src/config/api-config-infra.test.ts は、このディレクトリの直下の .tf を読んで秘密の渡し方を確かめる。
# どの .tf にも次の条件が掛かり、破ると apps/api のテストが落ちる（ファイルごとの条件は、そのファイルの注記にある）。
# - この構成を module に分けず、.tf.json を置かない（そこに置いた構成は読めない）
# - resource・data のブロックは terraform fmt の形（行頭の `resource "型" "名前" {` から行頭の `}` まで。中身の無いブロックは `{}` の1行）で書き、
#   ephemeral のブロックは行頭の `ephemeral "random_password" "名前" {` の形だけにする（書き方を問わずに数えた数と、この形で読めた数を突き合わせる）。
#   ヒアドキュメントの中に、行頭の `}` と閉じない括弧を書かない（ブロックの本文の終わりを、行頭の `}` と括弧の深さの2通りで求め、食い違えば落ちる）
# - IAM の面（aws_iam_ で始まるブロックと、policy・assume_role_policy を持つブロック。S3 のバケットポリシーや SNS のトピックのポリシーも入る）は、
#   検査の iamSurface の表とちょうど同じかで照合する。足す・変えるときは、秘密のパラメータを読める操作（ワイルドカードを含む）と、それを持つロールを
#   引き受けられる相手が増えないことを確かめてから、表も直す。ポリシーは aws_iam_policy_document のブロックで書き、policy・assume_role_policy には
#   data.aws_iam_policy_document.<名前>.json だけを渡す（jsonencode・ヒアドキュメントで書いたポリシーと dynamic の statement は、表と食い違って落ちる）。
#   入れ子のブロックの中に policy を書かない
# - 秘密の値は state とプランに残さない: 乱数は ephemeral の random_password だけで作る（resource・data の random_password・random_string と、
#   値を読むデータソース aws_ssm_parameter を使わない）。どのリソースでも password・secret・token を含むキーは write-only 引数（*_wo）と
#   その版（*_wo_version）だけにし、*_wo の値は ephemeral.random_password から作る。*_wo はリソースのブロックの中にだけ書く（locals・output に書かない）。
#   aws_ssm_parameter のキーは name・type・tier・value_wo・value_wo_version だけにする
# - Terraform の外で値を置くパラメータ（CloudFront の署名鍵。#427）は、検査の externalParameters に名指しし、locals の <名前>_name と
#   <名前>_arn（名前から組み立てた ARN）で渡す。aws_ssm_parameter のリソースもデータソースも作らない。値を置く手順は scripts/ のスクリプトにある
# - main.tf のほかの .tf には、この注記を指す1行（「このファイルにも main.tf の冒頭の検査の条件が掛かる」）を置く。新しい .tf を足すときも置く
#
# 踏むと壊れる: **要件定義書 4.2「秘密の値が漏れた疑いがあるとき」の手順は、この構成の名前・出力・設定を
# リテラルで打っている。どれも変えても validate も plan も CI も落ちない。**
# 名前や設定を変えるときは、その節も一緒に直す。
# **どの値が使われているかは、各ファイルの「踏むと壊れる」に書いてある**（ここには列挙しない——
# 前提が増えるたびに、この列挙だけが古くなるため）。

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
