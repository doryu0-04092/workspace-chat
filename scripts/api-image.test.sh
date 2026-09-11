#!/usr/bin/env bash
# api のコンテナイメージ（apps/api/Dockerfile）を作り、実際に動かして確かめる（#271）。
#
# 1. マイグレーション用（migrate）のイメージを、空の PostgreSQL 17 に適用できる
# 2. 実行用（runtime）のイメージが起動し、/api/health が 200 を返す
# 3. 実行用のイメージのログが、1行1件の JSON で標準出力に出る（要件定義書 4.6）。標準エラーには何も出さない
# 4. 実行用のイメージに、秘密を置くファイル（.env）とテストのコードが入っていない。マイグレーション用のイメージにも .env が入っていない
# 5. 実行用のイメージは root で動かない
#
# Docker が動いていることが前提。作ったコンテナとネットワークは終わりに消す（イメージは残す）。
set -euo pipefail

cd "$(dirname "$0")/.."

suffix="api-image-test-$$"
network="$suffix"
postgres="$suffix-postgres"
api="$suffix-api"
runtime_image="workspace-chat-api:test"
migrate_image="workspace-chat-api-migrate:test"

cleanup() {
  docker rm -f "$api" "$postgres" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
}
trap cleanup EXIT

fail() {
  echo "NG: $1" >&2
  exit 1
}

echo "== イメージを作る"
docker build --file apps/api/Dockerfile --target migrate --tag "$migrate_image" . >/dev/null
docker build --file apps/api/Dockerfile --target runtime --tag "$runtime_image" . >/dev/null

echo "== 1. マイグレーション用のイメージを空の PostgreSQL に適用する"
docker network create "$network" >/dev/null
# 値はこの検査の中だけで使う使い捨ての資格情報である。
docker run --detach --name "$postgres" --network "$network" \
  --env POSTGRES_PASSWORD=image-test --env POSTGRES_DB=chat postgres:17 >/dev/null
for _ in $(seq 1 60); do
  if docker exec "$postgres" pg_isready --username postgres --dbname chat >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
docker exec "$postgres" pg_isready --username postgres --dbname chat >/dev/null ||
  fail "PostgreSQL が起動しない"
database_url="postgresql://postgres:image-test@$postgres:5432/chat"
docker run --rm --network "$network" --env DATABASE_URL="$database_url" "$migrate_image" ||
  fail "マイグレーションを適用できない"
tables=$(docker exec "$postgres" psql --username postgres --dbname chat --tuples-only --no-align \
  --command "SELECT count(*) FROM information_schema.tables WHERE table_name = 'RefreshToken'")
[ "$tables" = "1" ] || fail "マイグレーションの後に RefreshToken の表が無い"

echo "== 2. 実行用のイメージが起動し、/api/health が 200 を返す"
jwt_secret=$(head -c 32 /dev/urandom | base64)
docker run --detach --name "$api" --network "$network" --publish 127.0.0.1::3000 \
  --env DATABASE_URL="$database_url" \
  --env REDIS_URL="redis://127.0.0.1:9" \
  --env TRUST_PROXY_HOPS=0 \
  --env JWT_SECRET="$jwt_secret" \
  --env WEB_ORIGIN="http://web.test" \
  "$runtime_image" >/dev/null
port=$(docker port "$api" 3000/tcp | head -n 1 | sed 's/.*://')
status=""
for _ in $(seq 1 60); do
  status=$(curl --silent --output /dev/null --write-out '%{http_code}' "http://127.0.0.1:$port/api/health" || true)
  [ "$status" = "200" ] && break
  if [ "$(docker inspect --format '{{.State.Running}}' "$api")" != "true" ]; then
    docker logs "$api" >&2 || true
    fail "api のコンテナが止まった"
  fi
  sleep 1
done
[ "$status" = "200" ] || { docker logs "$api" >&2 || true; fail "/api/health が 200 を返さない（$status）"; }

echo "== 3. ログは1行1件の JSON で標準出力に出る"
stdout=$(docker logs "$api" 2>/dev/null)
stderr=$(docker logs "$api" 2>&1 >/dev/null)
[ -n "$stdout" ] || fail "標準出力にログが無い"
[ -z "$stderr" ] || { echo "$stderr" >&2; fail "標準エラーに出力がある"; }
while IFS= read -r line; do
  [ -z "$line" ] && continue
  printf '%s' "$line" | node -e 'JSON.parse(require("fs").readFileSync(0, "utf8"))' 2>/dev/null ||
    fail "JSON でないログの行がある: $line"
done <<<"$stdout"

echo "== 4. 実行用のイメージに .env とテストのコードが入っていない"
leaked=$(docker run --rm --entrypoint sh "$runtime_image" -c \
  'find /app -path /app/node_modules -prune -o \( -name ".env" -o -name "*.test.js" -o -name "*.test.ts" -o -path "*/src/*" \) -print' |
  head -n 5)
[ -z "$leaked" ] || fail "イメージに入れないはずのファイルがある: $leaked"
leaked_env=$(docker run --rm --entrypoint sh "$migrate_image" -c 'find /app -path /app/node_modules -prune -o -name ".env" -print' | head -n 5)
[ -z "$leaked_env" ] || fail "マイグレーション用のイメージに .env がある: $leaked_env"

echo "== 5. 実行用のイメージは root で動かない"
user=$(docker inspect --format "{{.Config.User}}" "$runtime_image")
if [ -z "$user" ] || [ "$user" = "root" ] || [ "$user" = "0" ]; then
  fail "実行用のイメージの利用者が root である（${user:-未指定}）"
fi

echo "すべての確認を通過しました"
