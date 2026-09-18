# api のコンテナイメージ（#271）。ECS Fargate で動かす（技術スタック）。
#
# ビルドの文脈はリポジトリの根である（npm workspaces のため）。作る手順は scripts/api-image.test.sh が持つ。
#
# 段:
#   runtime … api を動かす。`npm ci --omit=dev` で入る依存と、build 段のビルド済みの dist・openapi と、RDS の CA のバンドルだけを持つ
#   migrate … `prisma migrate deploy` を1回流して終わる（ECS の一回きりのタスクと、運用者が ECS Exec で入るタスクで使う。下の migrate 段の注記）。`npm ci --omit=dev` で入る依存と、prisma.config.ts・スキーマ・マイグレーションと、RDS の CA のバンドルと、psql だけを持つ
#
# 起動に要る環境変数は README「動かす」と apps/api/src/config/api-config.ts にある。**イメージに値を焼き込まない**
# （.dockerignore が .env を文脈から外す）。scripts/api-image.test.sh が、実際に作って動かして確かめる。
#
# RDS の CA のバンドル（apps/api/certs/rds-global-bundle.pem → /app/certs/rds-global-bundle.pem。技術スタックの「DB への接続の暗号化」。#424）は、
# AWS が配る https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem の証明書を、並びだけ変えて置いたもの
# （2026-09-15 に取得。Last-Modified: Thu, 24 Jul 2025 21:38:09 GMT。取得したままのファイルの sha256 は e5bb2084ccf45087bda1c9bffdea0eb15ee67f0b91646106e466714f9de3c7e3）。
# 踏むと壊れる: **東京の `Amazon RDS ap-northeast-1 Root CA RSA2048 G1` を先頭に置く**（infra/production/database.tf の db_ca_cert_identifier と対）。
# Prisma の CLI（マイグレーション）は、渡した PEM の先頭の証明書しか信頼の起点にしない（#600 で確かめた）。取得したままの並び（先頭は sa-east-1）では、
# 本番のマイグレーションが certificate verify failed で RDS に繋がらない。api の pg と psql はバンドルの全部を読むので、並びに左右されない。
# 公開の証明書であり秘密ではない。ビルドのたびに取りに行かないのは、AWS が中身を足すたびに同じ Dockerfile から違うイメージができるためである。
# 入れ替えるときは同じ URL から取り直して置き換え、東京の RSA2048 G1 のルートを先頭に移してから、scripts/api-image.test.sh の 8 を通す。
# 踏むと壊れる: 本番の DATABASE_URL の sslrootcert がこのパスを指す。パスを変えると、api もマイグレーションも RDS に繋がらない。

# glibc の土台にする。argon2 はビルド済みのネイティブモジュールを使い、Alpine（musl）では入れ方が変わる。
#
# **土台はダイジェストではなくタグで指す**（docker/postgres/Dockerfile と同じ扱い）。
# 代償: タグの指す先が変わると、同じ Dockerfile から違うイメージができる。
# それでもタグにするのは、**この土台を Dependabot で追わないと決めているため**である
# （決定・2026-09-16・依頼側。理由は .github/dependabot.yml の末尾）。追う経路が無い以上、
# ダイジェストで固定すると誰かが手で上げるまで古いままになる。
# **同じタグの中の更新は、イメージを作るたびに --pull で取り込む**（下の行）。
# 取り直しは scripts/api-image.test.sh の `docker build --pull` と、scripts/release.sh の `docker buildx build --pull` が行う（手元のイメージがあってもレジストリを見る）。
ARG NODE_IMAGE=node:24-bookworm-slim

FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --no-audit --no-fund

FROM deps AS build
COPY tsconfig.base.json prisma.config.ts ./
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN npm run generate \
  && npm run build -w @workspace-chat/shared \
  && npm run build -w @workspace-chat/api

FROM ${NODE_IMAGE} AS prod-deps
WORKDIR /app
# Prisma の CLI のスキーマエンジンは、npm ci のときに、その場の OpenSSL の版を見て種類を選んで取る（@prisma/engines の postinstall）。
# migrate 段は psql のために OpenSSL 3 を入れるため、ここにも openssl を入れて、同じ種類のエンジンを取らせる。
# 踏むと壊れる: ここと migrate 段で OpenSSL の有無が食い違うと、prisma migrate deploy が実行時に別の種類のエンジンを取りに行き、
# 「Can't write to /app/node_modules/@prisma/engines」で落ちる（scripts/api-image.test.sh の 1 が落ちて気づく）。
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl \
  && rm -r /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --omit=dev --no-audit --no-fund

# マイグレーション用の段は build 段を継がない（#277）。build 段はソース・テストのコード・開発依存を全部持ち、それが本番の
# タスクとして動くことになる。prod-deps の /app に、prisma.config.ts（接続先を DATABASE_URL から読む）とスキーマ・マイグレーションと、RDS の CA のバンドルと、psql だけを足す。
# prisma の CLI は prod-deps に入っている——@prisma/client が peerDependencies に持ち（任意）、package-lock.json で devOptional のため
# --omit=dev でも lock の版で入る。ここで npm install しない（lock と違う版に解決される経路を作らない）。
# 踏むと壊れる: @prisma/client が prisma を peer から外すと CLI が消える。scripts/api-image.test.sh の 1 が落ちて気づく。
# 踏むと壊れる: 運用者が ECS Exec で RDS に入る先もこの段のイメージである（技術スタックのコンテナの行・要件定義書 4.2 手順 5 の代償）。
# 入る手順はまだ書いていない（実際に入って確かめてから書く。#458）。問い合わせの手段は、下で入れる psql である。
# CMD のまま起動すると、入る先が残らず、本番の DB に migrate deploy が走る。
FROM ${NODE_IMAGE} AS migrate
ENV NODE_ENV=production
WORKDIR /app
# psql を、PostgreSQL の公式の apt リポジトリ（PGDG）から入れる（#457。技術スタックのコンテナの行）。この段にだけ置き、
# api のイメージには入れない（scripts/api-image.test.sh の 9）。手順は https://www.postgresql.org/download/linux/debian/ の
# 「Manual Repository Configuration」で、Suites は土台の Debian の版（/etc/os-release の VERSION_CODENAME）から作る。
# 署名鍵（apps/api/pgdg/apt.postgresql.org.asc）は https://www.postgresql.org/media/keys/ACCC4CF8.asc をそのまま置いたもの
# （2026-09-15 に取得。指紋 B97B 0AFC AA1A 47F0 44F2 44A0 7FCC 7D46 ACCC 4CF8。sha256 0144068502a1eddd2a0280ede10ef607d1ec592ce819940991203941564e8e76。
# Debian bookworm の postgresql-common 248+deb12u1 が同じ置き場に同梱する鍵と、バイト列が一致した）。
# openssl は prod-deps 段と揃えるために明示して入れる（prod-deps 段の注記）。
# 踏むと壊れる: psql の版は RDS の版（技術スタックの DB の行。PostgreSQL 17）と揃える（psql の文書「psql works best with servers of the
# same or an older major version.」）。RDS の版を上げるときは、ここの postgresql-client-17 と scripts/api-image.test.sh の 9 も上げる。
COPY apps/api/pgdg/apt.postgresql.org.asc /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates openssl \
  && . /etc/os-release \
  && printf 'Types: deb\nURIs: https://apt.postgresql.org/pub/repos/apt\nSuites: %s-pgdg\nComponents: main\nSigned-By: /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc\n' "$VERSION_CODENAME" \
    > /etc/apt/sources.list.d/pgdg.sources \
  && apt-get update \
  && apt-get install -y --no-install-recommends postgresql-client-17 \
  && rm -r /var/lib/apt/lists/*
COPY --from=prod-deps /app ./
COPY prisma.config.ts ./
COPY apps/api/prisma apps/api/prisma
COPY apps/api/certs/rds-global-bundle.pem certs/
USER node
CMD ["node", "node_modules/prisma/build/index.js", "migrate", "deploy"]

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app
# prod-deps の /app をまるごと持ち込む。npm は版がぶつかる依存をワークスペースの下（apps/api/node_modules など）に置くため、
# 根の node_modules だけを複写すると、イメージの中だけ package-lock.json と違う版に解決される。
COPY --from=prod-deps /app ./
COPY --from=build /app/packages/shared/dist packages/shared/dist
# api は起動時に REST の仕様を読む（apps/api/src/openapi-validation.ts）。
COPY --from=build /app/packages/shared/openapi packages/shared/openapi
COPY --from=build /app/apps/api/dist apps/api/dist
COPY apps/api/certs/rds-global-bundle.pem certs/
USER node
# 3000 は apps/api/src/port.ts の既定のポート（infra/production/compute.tf の api_port）の写しである。
EXPOSE 3000
# --no-warnings: Node の警告の既定の出力（素のテキストで標準エラー）を止める。警告は api が 'warning' を受けて構造化ログに残す
# （apps/api/src/bootstrap.ts の installWarningLog。要件定義書 4.6）。マイグレーション用の段には付けない——Prisma の CLI は警告を残す先を持たない。
CMD ["node", "--no-warnings", "apps/api/dist/main.js"]
