# api のコンテナイメージ（#271）。ECS Fargate で動かす（技術スタック）。
#
# ビルドの文脈はリポジトリの根である（npm workspaces のため）。作る手順は scripts/api-image.test.sh が持つ。
#
# 段:
#   runtime … api を動かす。`npm ci --omit=dev` で入る依存と、build 段のビルド済みの dist・openapi と、RDS の CA のバンドルだけを持つ
#   migrate … `prisma migrate deploy` を1回流して終わる（ECS の一回きりのタスクと、運用者が ECS Exec で入るタスクで使う。下の migrate 段の注記）。`npm ci --omit=dev` で入る依存と、prisma.config.ts・スキーマ・マイグレーションと、RDS の CA のバンドルだけを持つ
#
# 起動に要る環境変数は README「動かす」と apps/api/src/config/api-config.ts にある。**イメージに値を焼き込まない**
# （.dockerignore が .env を文脈から外す）。scripts/api-image.test.sh が、実際に作って動かして確かめる。
#
# RDS の CA のバンドル（apps/api/certs/rds-global-bundle.pem → /app/certs/rds-global-bundle.pem。技術スタックの「DB への接続の暗号化」。#424）は、
# AWS が配る https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem をそのまま置いたもの
# （2026-09-15 に取得。Last-Modified: Thu, 24 Jul 2025 21:38:09 GMT。sha256 e5bb2084ccf45087bda1c9bffdea0eb15ee67f0b91646106e466714f9de3c7e3）。
# 公開の証明書であり秘密ではない。ビルドのたびに取りに行かないのは、AWS が中身を足すたびに同じ Dockerfile から違うイメージができるためである。
# 入れ替えるときは同じ URL から取り直して置き換え、scripts/api-image.test.sh の 8 を通す。
# 踏むと壊れる: 本番の DATABASE_URL の sslrootcert がこのパスを指す。パスを変えると、api もマイグレーションも RDS に繋がらない。

# glibc の土台にする。argon2 はビルド済みのネイティブモジュールを使い、Alpine（musl）では入れ方が変わる。
#
# **土台はダイジェストではなくタグで指す**（docker/postgres/Dockerfile と同じ扱い）。
# 代償: タグの指す先が変わると、同じ Dockerfile から違うイメージができる。
# それでもタグにするのは、依存の自動更新（dependabot.yml）が Dockerfile を見ておらず（#38）、
# ダイジェストで固定すると誰かが手で上げるまで古いままになるためである。
# 取り直しは scripts/api-image.test.sh の `docker build --pull` が行う（手元のイメージがあってもレジストリを見る）。
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
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --omit=dev --no-audit --no-fund

# マイグレーション用の段は build 段を継がない（#277）。build 段はソース・テストのコード・開発依存を全部持ち、それが本番の
# タスクとして動くことになる。prod-deps の /app に、prisma.config.ts（接続先を DATABASE_URL から読む）とスキーマ・マイグレーションと、RDS の CA のバンドルだけを足す。
# prisma の CLI は prod-deps に入っている——@prisma/client が peerDependencies に持ち（任意）、package-lock.json で devOptional のため
# --omit=dev でも lock の版で入る。ここで npm install しない（lock と違う版に解決される経路を作らない）。
# 踏むと壊れる: @prisma/client が prisma を peer から外すと CLI が消える。scripts/api-image.test.sh の 1 が落ちて気づく。
# 踏むと壊れる: 運用者が ECS Exec で RDS に入る先もこの段のイメージである（技術スタックのコンテナの行・要件定義書 4.2 手順 5 の代償）。
# 入る手順はまだ書いていない（実際に入って確かめてから書く。#458）。問い合わせの手段（psql）もまだこの段に無い（#457）。
# CMD のまま起動すると、入る先が残らず、本番の DB に migrate deploy が走る。
FROM ${NODE_IMAGE} AS migrate
ENV NODE_ENV=production
WORKDIR /app
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
EXPOSE 3000
CMD ["node", "apps/api/dist/main.js"]
