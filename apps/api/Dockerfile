# api のコンテナイメージ（#271）。ECS Fargate で動かす（技術スタック）。
#
# ビルドの文脈はリポジトリの根である（npm workspaces のため）:
#   docker build --file apps/api/Dockerfile --target runtime .
#
# 段:
#   runtime … api を動かす。本番の依存だけを持つ
#   migrate … `prisma migrate deploy` を1回流して終わる（ECS の一回きりのタスクで使う）。本番の依存とスキーマだけを持つ
#
# 起動に要る環境変数は README「動かす」と apps/api/src/config/api-config.ts にある。**イメージに値を焼き込まない**
# （.dockerignore が .env を文脈から外す）。scripts/api-image.test.sh が、実際に作って動かして確かめる。

# glibc の土台にする。argon2 はビルド済みのネイティブモジュールを使い、Alpine（musl）では入れ方が変わる。
#
# **土台はダイジェストではなくタグで指す**（docker/postgres/Dockerfile と同じ扱い）。
# 代償: タグの指す先が変わると、同じ Dockerfile から違うイメージができる。
# それでもタグにするのは、依存の自動更新（dependabot.yml）が Dockerfile を見ておらず（#38）、
# ダイジェストで固定すると誰かが手で上げるまで古いままになるためである。
# **ただしタグにしただけでは、手元には届かない。** Docker は同じ名前のイメージが手元にあればレジストリを見ないため、
# 取り直すには `docker build --pull` が要る。
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
# タスクとして動くことになる。prod-deps の /app に、prisma.config.ts（接続先を DATABASE_URL から読む）とスキーマ・マイグレーションだけを足す。
# prisma の CLI は prod-deps に入っている——@prisma/client が peerDependencies に持ち（任意）、package-lock.json で devOptional のため
# --omit=dev でも lock の版で入る。ここで npm install しない（lock と違う版に解決される経路を作らない）。
# 踏むと壊れる: @prisma/client が prisma を peer から外すと CLI が消える。scripts/api-image.test.sh の 1 が落ちて気づく。
FROM ${NODE_IMAGE} AS migrate
ENV NODE_ENV=production
WORKDIR /app
COPY --from=prod-deps /app ./
COPY prisma.config.ts ./
COPY apps/api/prisma apps/api/prisma
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
USER node
EXPOSE 3000
CMD ["node", "apps/api/dist/main.js"]
