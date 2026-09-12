#!/usr/bin/env bash
# api のコンテナイメージ（apps/api/Dockerfile）を作り、実際に動かして確かめる（#271）。
#
# 1. マイグレーション用（migrate）のイメージを、空の PostgreSQL 17 に適用できる
# 2. 実行用（runtime）のイメージが起動し、/api/health が 200 を返す
# 3. 実行用のイメージのログが、1行1件の JSON で標準出力に出る（要件定義書 4.6）。標準エラーには何も出さない
# 4. どちらのイメージにも、秘密を置くファイル（.env と .env.*。.env.example を除く）・テストのコード・ソース・開発依存（代表として vitest と @nestjs/testing）が入っていない
# 5. どちらのイメージも root で動かない
# 6. 実行用のイメージの中で api の依存が解決される版が、package-lock.json の版と同じである
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

# テストで使う PostgreSQL のイメージは apps/api/src/testing/postgres.ts の POSTGRES_IMAGE の1箇所で決める（差し替えの時期は #34）。
postgres_image=$(sed -n "s/^export const POSTGRES_IMAGE = '\([^']*\)';$/\1/p" apps/api/src/testing/postgres.ts)
[ -n "$postgres_image" ] || fail "apps/api/src/testing/postgres.ts から POSTGRES_IMAGE を読めない"

echo "== イメージを作る"
# --pull: 土台（タグで指す）を毎回レジストリから取り直す。無いと手元に残った古い土台で作り、手元の緑が CI の緑と同じ意味を持たない（#281）。
# 代償: レジストリに届かない環境では、手元に土台があってもこの検査は通らない（下の docker pull も同じ）。
docker build --pull --file apps/api/Dockerfile --target migrate --tag "$migrate_image" . >/dev/null
docker build --pull --file apps/api/Dockerfile --target runtime --tag "$runtime_image" . >/dev/null

echo "== 1. マイグレーション用のイメージを空の PostgreSQL に適用する"
docker network create "$network" >/dev/null
# 土台（タグで指す）は毎回取り直す。docker run も手元に同じタグがあればレジストリを見ない（docker build の --pull と同じ性質）。
docker pull --quiet "$postgres_image" >/dev/null
# 値はこの検査の中だけで使う使い捨ての資格情報である。
docker run --detach --name "$postgres" --network "$network" \
  --env POSTGRES_PASSWORD=image-test --env POSTGRES_DB=chat "$postgres_image" >/dev/null
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

echo "== 4. どちらのイメージにも .env・テストのコード・ソース・開発依存（代表として vitest と @nestjs/testing）が入っていない"
# 本番のタスクとして動く2つのイメージに同じ検査を当てる（#277。マイグレーション用だけ弱くしない）。
# 開発依存の代表として、テストの実行に要る vitest と @nestjs/testing が無いことを見る（--omit=dev を落とすと入る）。
# 調べる側（docker run・find）の失敗は名指しして止める——代入をパイプにせず（pipefail と set -e で無言に抜ける）、
# find の失敗を ls の || true で上書きしない（調べられなかったのに「無い」として通る）。
for image in "$runtime_image" "$migrate_image"; do
  leaked=$(docker run --rm --entrypoint sh "$image" -c \
    'find /app -name node_modules -prune -o \( \( -name ".env*" ! -name ".env.example" \) -o -name "*.test.js" -o -name "*.test.ts" -o -path "*/src/*" \) -print && { ls -d /app/node_modules/vitest /app/node_modules/@nestjs/testing 2>/dev/null || true; }') ||
    fail "$image の中を調べられない（docker run か find が失敗した）"
  [ -z "$leaked" ] || fail "$image に入れないはずのファイルがある: $(printf '%s\n' "$leaked" | head -n 5)"
done

echo "== 5. どちらのイメージも root で動かない"
for image in "$runtime_image" "$migrate_image"; do
  user=$(docker inspect --format "{{.Config.User}}" "$image") || fail "$image を inspect できない"
  if [ -z "$user" ] || [ "$user" = "root" ] || [ "$user" = "0" ]; then
    fail "$image の利用者が root である（${user:-未指定}）"
  fi
done

echo "== 6. イメージの中で api の依存が解決される版が、package-lock.json と同じ"
# 名前の一覧は apps/api/package.json の dependencies（ワークスペースの @workspace-chat/* を除く）。
# 期待する版は lock の apps/api/node_modules/<名前>、無ければ node_modules/<名前>（Node が api から探す順）。
# イメージの中では、api の入口（apps/api/dist/main.js）から Node が探す順に package.json を探す。
# 引数の JavaScript はテンプレートリテラルを使い、シェルに展開させない（SC2016 は意図どおり）。
# shellcheck disable=SC2016
expected=$(node -e '
  const lock = require("./package-lock.json").packages;
  const names = Object.keys(require("./apps/api/package.json").dependencies).filter((n) => !n.startsWith("@workspace-chat/"));
  console.log(names.map((n) => `${n}@${(lock[`apps/api/node_modules/${n}`] ?? lock[`node_modules/${n}`]).version}`).sort().join("\n"));
')
# shellcheck disable=SC2016
actual=$(docker run --rm --entrypoint node "$runtime_image" -e '
  const { existsSync, readFileSync } = require("node:fs");
  const { createRequire } = require("node:module");
  const { join } = require("node:path");
  const api = "/app/apps/api";
  const fromApi = createRequire(join(api, "dist", "main.js"));
  const names = Object.keys(JSON.parse(readFileSync(join(api, "package.json"), "utf8")).dependencies).filter((n) => !n.startsWith("@workspace-chat/"));
  console.log(names.map((n) => {
    const dir = fromApi.resolve.paths(n).find((p) => existsSync(join(p, n, "package.json")));
    return `${n}@${dir === undefined ? "（無い）" : JSON.parse(readFileSync(join(dir, n, "package.json"), "utf8")).version}`;
  }).sort().join("\n"));
')
[ "$expected" = "$actual" ] ||
  fail "イメージの中の依存の版が package-lock.json と違う: $(diff <(echo "$expected") <(echo "$actual") | grep '^[<>]' | tr '\n' ' ')"

echo "すべての確認を通過しました"
