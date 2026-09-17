# RDS for PostgreSQL と、api が secret: true と宣言した設定のうち DATABASE_URL のパラメータ（#452）。
# 技術スタック「本番の HTTPS・秘密情報・state の置き場」の秘密情報の行と DB への接続の暗号化の行、「リソースのサイジング」の RDS の行。
# 要件定義書 4.2 の「バックアップ」と「RDS の障害から復旧するとき」。
#
# 秘密の値は state とプランに残さない: マスターパスワードは ephemeral の random_password で作り、write-only 引数でだけ渡す。
# 踏むと壊れる: このファイルにも main.tf の冒頭の検査の条件が掛かる（apps/api/src/config/api-config-infra.test.ts）。秘密の値の渡し方の条件もそこにある。
#
# 踏むと壊れる: write-only 引数で渡した値は、*_wo_version を上げるまで入れ替わらない。
# DATABASE_URL の value_wo_version と RDS の password_wo_version は同じ乱数を渡すため、下の locals の db_password_version だけで上げる
# （片方だけ上げると、api が DB に繋がらない）。RDS を作り直す（復元を含む）apply でも、同じ apply でこの版を上げる（要件定義書 4.2 手順 3）。
# 版を上げた apply の後も、ECS のタスクを入れ替えるまで動いているコンテナは古い値を持つ。
#
# 踏むと壊れる: **漏えいの疑いで入れ替えるときは、この版を上げるだけでは足りない**。
# 要件定義書 4.2「秘密の値が漏れた疑いがあるとき」の手順による（api を止めてから入れ替える）。
# 止めずに版を上げると、変更が当たってから古いタスクが入れ替わるまで、**古いタスクが新しく張る接続が断られる**。
# 死活確認は DB を見ないため、その間も ALB は正常と判定し続ける。

# 踏むと壊れる: 技術スタックと要件定義書が決めた値は、この locals にだけ書く（下のブロックには、名前と説明のほかにリテラルの値を書かない）。
# どの値も、変えても validate も plan も CI も落ちない（apply が落ちるのは AWS の制約の外に出たときだけ）。
# 変えるときは、文書の行を先に直す。
locals {
  # PostgreSQL の待ち受けポート。RDS・DATABASE_URL・network.tf の受信の規則はこの値だけを使う（食い違うと api が DB に繋がらない）。
  db_port = 5432

  # DATABASE_URL の value_wo_version と RDS の password_wo_version が一緒に使う版。
  # 踏むと壊れる: **この版は上げるだけで、下げない**（要件定義書 4.2「秘密の値が漏れた疑いがあるとき」の共通の前置き）。
  # **下げても write-only の値は入れ替わる**——**戻したつもりで、また別の値になる**。
  # **上げたらコミットする**——このファイルは追跡下にあり、コミットしないまま git checkout や pull を踏むと版が戻る。
  db_password_version = 1

  # マスターパスワードは 32 文字。英数字だけにするのは cache.tf の random_password_special（DATABASE_URL の中に埋めるため、URL の区切りになる記号を含めない）。
  db_password_length = 32

  # 接続の形（技術スタックの「DB への接続の暗号化」）。sslrootcert は api のイメージの中の RDS の CA のバンドルのパス
  # （apps/api/Dockerfile）。パスが食い違うと、api もマイグレーションも RDS に繋がらない。
  # prisma.config.ts が、Prisma の CLI に渡すときだけこの形を読み替える。
  db_url_tls_parameters = "sslmode=verify-full&sslrootcert=/app/certs/rds-global-bundle.pem"

  # サーバー証明書の CA。api のイメージのバンドルがこの CA のルートを含むことを、scripts/api-image.test.sh の 8 が確かめる。
  db_ca_cert_identifier = "rds-ca-rsa2048-g1"

  db_engine = "postgres"
  # メジャー版だけを書き、マイナー版はメンテナンスの時間帯に上がる（プロバイダーの文書「If `auto_minor_version_upgrade` is enabled,
  # you can provide a prefix of the version such as `8.0` (for `8.0.36`).」。auto_minor_version_upgrade の既定は true）。
  db_engine_version         = "17"
  db_parameter_group_family = "postgres17"

  db_instance_class      = "db.t4g.micro"
  db_storage_type        = "gp3"
  db_allocated_storage   = 20
  db_multi_az            = false
  db_storage_encrypted   = true
  db_publicly_accessible = false

  # pg_bigm は共有ライブラリの事前読み込みを要する（pg_bigm の文書「must be set to 'pg_bigm'」）。RDS の postgres17 の既定（pg_stat_statements,pg_tle。
  # aws rds describe-engine-default-parameters で確かめた・2026-09-16）を残したまま足す。
  # 静的パラメータのため、作った後に変えたら再起動が要る。
  db_shared_preload_libraries = "pg_stat_statements,pg_tle,pg_bigm"
  db_static_parameter_apply   = "pending-reboot"

  # サーバー側でも SSL でない接続を断る（技術スタックの「DB への接続の暗号化」）。RDS for PostgreSQL 15 以降の既定は 1 だが、
  # カスタムのパラメータグループに付け替えても外れないよう明示する。
  # 踏むと壊れる: 下の parameter の apply_method は "pending-reboot" のままにする。値が既定と同じため、AWS から読み戻す
  # apply_method は pending-reboot になり、"immediate"（プロバイダーの既定）にすると plan に毎回変更が出る（#602）。
  # 値を既定と違うものに変えるときは、その apply で効かせるか再起動まで待つかを決め直す。
  db_force_ssl = "1"

  # 自動バックアップは取らない（保持期間 0 日）。決定・2026-09-17・依頼側（#598）: スクール課題の検証用の一時的な本番であり、
  # アカウントの無料プランでは保持期間 7 日を設定できない（RDS の作成が FreeTierRestrictionError で断られた）。
  # 代償: 任意の時点への復元はできない。誤ってデータを消したら戻せない。
  # 保持期間が 0 のときは取得時間帯を渡さない（取得しないため意味を持たない）。時刻は UTC。
  # 取得を戻すときの時間帯は日本時間の 03:00〜03:30、メンテナンスは月曜の日本時間 04:00〜04:30
  # （プロバイダーの文書「Must not overlap with `maintenance_window`.」）。
  db_backup_retention_period = 0
  db_backup_window           = "18:00-18:30"
  db_maintenance_window      = "sun:19:00-sun:19:30"

  # 変更をメンテナンスの時間帯まで待たせない（プロバイダーの文書「Specifies whether any database modifications are applied immediately,
  # or during the next maintenance window. Default is `false`.」）。DATABASE_URL のパラメータは apply ですぐ替わるため、
  # RDS の側だけ遅れると食い違う。
  # 踏むと壊れる: **要件定義書 4.2「秘密の値が漏れた疑いがあるとき」の RDS の箇条が、この値を前提にしている。**
  # 手順 3 は PendingModifiedValues から MasterUserPassword が消えるのを待つが、false にすると
  # **変更がメンテナンスの時間帯まで当たらず、待ちが明けない**——その間、手順 1 で止めた api は止まったままである。
  db_apply_immediately = true

  # destroy のときに最終スナップショットを取らず、削除保護も掛けない（要件定義書 4.2「バックアップ」。デモの後に destroy する運用）。
  db_skip_final_snapshot = true
  db_deletion_protection = false
}

ephemeral "random_password" "db_password" {
  length  = local.db_password_length
  special = local.random_password_special
}

resource "aws_db_subnet_group" "main" {
  name       = "workspace-chat-db"
  subnet_ids = aws_subnet.private[*].id
}

resource "aws_db_parameter_group" "main" {
  name   = "workspace-chat-postgres"
  family = local.db_parameter_group_family

  parameter {
    name         = "shared_preload_libraries"
    value        = local.db_shared_preload_libraries
    apply_method = local.db_static_parameter_apply
  }

  parameter {
    name         = "rds.force_ssl"
    value        = local.db_force_ssl
    apply_method = "pending-reboot"
  }
}

# 踏むと壊れる: **要件定義書 4.2「秘密の値が漏れた疑いがあるとき」の RDS の箇条が、
# このアドレス（aws_db_instance.main）を -target でリテラルで打っている。** 名前を変えるとその段が対象を絞れない。
resource "aws_db_instance" "main" {
  # 踏むと壊れる: **要件定義書 4.2「秘密の値が漏れた疑いがあるとき」の手順 3 が、この識別子をリテラルで打っている**
  # （aws rds describe-db-instances --db-instance-identifier workspace-chat）。変えるとその段が対象を見つけられない。
  identifier = "workspace-chat"
  db_name    = "workspace_chat"
  username   = "workspace_chat"

  engine               = local.db_engine
  engine_version       = local.db_engine_version
  instance_class       = local.db_instance_class
  storage_type         = local.db_storage_type
  allocated_storage    = local.db_allocated_storage
  storage_encrypted    = local.db_storage_encrypted
  multi_az             = local.db_multi_az
  port                 = local.db_port
  parameter_group_name = aws_db_parameter_group.main.name
  ca_cert_identifier   = local.db_ca_cert_identifier

  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.db.id]
  publicly_accessible    = local.db_publicly_accessible

  password_wo         = ephemeral.random_password.db_password.result
  password_wo_version = local.db_password_version

  backup_retention_period = local.db_backup_retention_period
  backup_window           = local.db_backup_retention_period > 0 ? local.db_backup_window : null
  maintenance_window      = local.db_maintenance_window
  apply_immediately       = local.db_apply_immediately
  skip_final_snapshot     = local.db_skip_final_snapshot
  deletion_protection     = local.db_deletion_protection
}

# 踏むと壊れる: name は渡す設定の名前（/DATABASE_URL）で終わらせ、type は local.parameter_type（SecureString）にする
# （apps/api/src/config/api-config-infra.test.ts が確かめる。cache.tf の redis_url・jwt_secret と同じ）。
# 踏むと壊れる: **接頭辞（/workspace-chat/）も、要件定義書 4.2「秘密の値が漏れた疑いがあるとき」の前置きと
# 確かめる段がリテラルで打っている。** 上の検査は**末尾しか見ない**ため、接頭辞を変えても CI は緑のまま、
# **4.2 の段だけが対象を見つけられなくなる**（落ちる位置は前置きの弾く段で、api を止める前ではある）。
# 踏むと壊れる: **4.2 の RDS の箇条が、このアドレス（aws_ssm_parameter.database_url）を -target で打っている。**
resource "aws_ssm_parameter" "database_url" {
  name             = "/workspace-chat/DATABASE_URL"
  type             = local.parameter_type
  tier             = local.parameter_tier
  value_wo         = "postgresql://${aws_db_instance.main.username}:${ephemeral.random_password.db_password.result}@${aws_db_instance.main.address}:${local.db_port}/${aws_db_instance.main.db_name}?${local.db_url_tls_parameters}"
  value_wo_version = local.db_password_version
}
