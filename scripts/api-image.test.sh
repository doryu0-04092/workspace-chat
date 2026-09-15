#!/usr/bin/env bash
# api のコンテナイメージ（apps/api/Dockerfile）を作り、実際に動かして確かめる（#271）。
#
# 1. マイグレーション用（migrate）のイメージを、空の PostgreSQL 17 に適用できる
# 2. 実行用（runtime）のイメージが起動し、/api/health が 200 を返す
# 3. 実行用のイメージのログが、1行1件の JSON で標準出力に出る（要件定義書 4.6）。標準エラーには何も出さない
# 4. どちらのイメージにも、秘密を置くファイル（.env と .env.*。.env.example を除く）・テストのコード・`src/` 配下のソース・--omit=dev を落とすと入る開発依存（代表として vitest と @nestjs/testing）が入っていない
# 5. どちらのイメージも root で動かない
# 6. 実行用のイメージの中で api の依存が解決される版が、package-lock.json の版と同じである
# 7. 本番の DATABASE_URL の形（sslmode=verify-full&sslrootcert=<CA>）で、TLS だけを受け付ける PostgreSQL に対し、
#    マイグレーション用のイメージ（Prisma の CLI）も実行用のイメージの pg も、サーバー証明書を CA で検証する（別の CA では繋がらない）
# 8. どちらのイメージにも RDS の CA のバンドルがあり、本番のリージョンのルート CA を含む
# 9. マイグレーション用のイメージには psql 17 があり、7 と同じ形の URL で CA を検証して繋がる（別の CA では繋がらない）。実行用のイメージには psql が無い
#
# Docker と openssl が動いていることが前提。作ったコンテナとネットワークと証明書は終わりに消す（イメージは残す）。
set -euo pipefail

cd "$(dirname "$0")/.."

suffix="api-image-test-$$"
network="$suffix"
postgres="$suffix-postgres"
tls_postgres="$suffix-postgres-tls"
tls_client="$suffix-tls-client"
api="$suffix-api"
runtime_image="workspace-chat-api:test"
migrate_image="workspace-chat-api-migrate:test"
tls_dir=$(mktemp -d)

cleanup() {
  docker rm -f "$api" "$postgres" "$tls_postgres" "$tls_client" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
  rm -f "$tls_dir"/*
  rmdir "$tls_dir" 2>/dev/null || true
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
# **踏むと壊れる: 起動の待ち合わせは TCP（--host 127.0.0.1）で引く。** 公式イメージは初回に、ソケットだけで待ち受ける
# 一時のサーバー（listen_addresses=''）で初期化し、止めてから本来のサーバーを起動し直す。ソケットで引くと一時のサーバーに
# ready と答えられ、直後の停止の間に落ちる。TCP で答えるのは本来のサーバーだけである。
for _ in $(seq 1 60); do
  if docker exec "$postgres" pg_isready --host 127.0.0.1 --username postgres --dbname chat >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
docker exec "$postgres" pg_isready --host 127.0.0.1 --username postgres --dbname chat >/dev/null ||
  { docker logs "$postgres" >&2 || true; fail "PostgreSQL が起動しない"; }
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

echo "== 3. 実行用のイメージのログは1行1件の JSON で標準出力に出る（標準エラーには何も出さない）"
stdout=$(docker logs "$api" 2>/dev/null)
stderr=$(docker logs "$api" 2>&1 >/dev/null)
[ -n "$stdout" ] || fail "標準出力にログが無い"
[ -z "$stderr" ] || { echo "$stderr" >&2; fail "標準エラーに出力がある"; }
while IFS= read -r line; do
  [ -z "$line" ] && continue
  printf '%s' "$line" | node -e 'JSON.parse(require("fs").readFileSync(0, "utf8"))' 2>/dev/null ||
    fail "JSON でないログの行がある: $line"
done <<<"$stdout"

echo "== 4. どちらのイメージにも .env・テストのコード・\`src/\` 配下のソース・--omit=dev を落とすと入る開発依存（代表として vitest と @nestjs/testing）が入っていない"
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

echo "== 6. 実行用のイメージの中で api の依存が解決される版が、package-lock.json と同じ"
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

echo "== 7. 本番の DATABASE_URL の形で、マイグレーション用のイメージも実行用のイメージの pg も、サーバー証明書を CA で検証する"
# 本番の RDS は SSL でない接続を断る。ここでは TLS の接続（hostssl）だけを受け付ける PostgreSQL を立て、使い捨ての CA（ca）と、
# それとは別の CA（other-ca）を作る。サーバー証明書は ca が署名し、名前はコンテナの名前にする。
# **別の CA で繋がらないことまで見る**——Prisma の CLI は sslmode=verify-full を prefer に読み替えて sslrootcert を捨て、
# 証明書を検証せずに TLS だけを張る（#424）。正しい CA で繋がることだけを見ると、その形でも通る。
# MSYS_NO_PATHCONV は、Git Bash が -subj の /CN=… をパスに書き換えないようにする（Linux では何もしない）。
(
  cd "$tls_dir" &&
    MSYS_NO_PATHCONV=1 openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=image-test-ca" \
      -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign" \
      -keyout ca.key -out ca.pem 2>/dev/null &&
    MSYS_NO_PATHCONV=1 openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=image-test-other-ca" \
      -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign" \
      -keyout other-ca.key -out other-ca.pem 2>/dev/null &&
    MSYS_NO_PATHCONV=1 openssl req -newkey rsa:2048 -nodes -subj "/CN=$tls_postgres" \
      -keyout server.key -out server.csr 2>/dev/null &&
    printf 'subjectAltName=DNS:%s\n' "$tls_postgres" >server.ext &&
    openssl x509 -req -in server.csr -CA ca.pem -CAkey ca.key -CAcreateserial -days 1 \
      -extfile server.ext -out server.pem 2>/dev/null
) || fail "検査用の証明書を作れない（openssl）"
# PostgreSQL は他人が読める鍵を拒むため、起動の前に postgres の持ち物・0600 で置き直す。
docker create --name "$tls_postgres" --network "$network" \
  --env POSTGRES_PASSWORD=image-test --env POSTGRES_DB=chat --entrypoint bash "$postgres_image" -c '
    install -d -o postgres -m 700 /tmp/ssl &&
    install -o postgres -m 600 /tls/server.pem /tls/server.key /tmp/ssl/ &&
    printf "local all all trust\nhostssl all all all scram-sha-256\n" >/tmp/ssl/pg_hba.conf &&
    exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/tmp/ssl/server.pem \
      -c ssl_key_file=/tmp/ssl/server.key -c hba_file=/tmp/ssl/pg_hba.conf' >/dev/null
docker cp "$tls_dir/." "$tls_postgres:/tls" >/dev/null
docker start "$tls_postgres" >/dev/null
for _ in $(seq 1 60); do
  if docker exec "$tls_postgres" pg_isready --host 127.0.0.1 --username postgres --dbname chat >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
docker exec "$tls_postgres" pg_isready --host 127.0.0.1 --username postgres --dbname chat >/dev/null ||
  { docker logs "$tls_postgres" >&2 || true; fail "TLS の PostgreSQL が起動しない"; }
tls_url="postgresql://postgres:image-test@$tls_postgres:5432/chat?sslmode=verify-full&sslrootcert=/tmp/ca.pem"

# イメージを、指定の CA を /tmp/ca.pem に置いて1回動かす。引数: CA のファイル名・DATABASE_URL・docker create に続ける引数。
run_with_ca() {
  local ca_file=$1 url=$2
  shift 2
  docker rm -f "$tls_client" >/dev/null 2>&1 || true
  docker create --name "$tls_client" --network "$network" --env DATABASE_URL="$url" "$@" >/dev/null &&
    docker cp "$tls_dir/$ca_file" "$tls_client:/tmp/ca.pem" >/dev/null &&
    docker start --attach "$tls_client"
}

out=$(run_with_ca ca.pem "$tls_url" "$migrate_image" 2>&1) ||
  { echo "$out" >&2; fail "正しい CA で、マイグレーションを適用できない"; }
if out=$(run_with_ca other-ca.pem "$tls_url" "$migrate_image" 2>&1); then
  echo "$out" >&2
  fail "別の CA でも、マイグレーションを適用できた（Prisma の CLI が証明書を検証していない）"
fi
grep -q 'certificate verify failed' <<<"$out" ||
  { echo "$out" >&2; fail "別の CA で、マイグレーションが証明書の検証以外の理由で落ちた"; }
if out=$(run_with_ca ca.pem "${tls_url%&sslrootcert=*}" "$migrate_image" 2>&1); then
  echo "$out" >&2
  fail "sslrootcert の無い verify-full でも、マイグレーションを適用できた（検証する CA が無いまま繋がった）"
fi
grep -q 'sslrootcert' <<<"$out" ||
  { echo "$out" >&2; fail "sslrootcert の無い verify-full で、sslrootcert が要ると知らせずに落ちた"; }
# TLS を受け付けない PostgreSQL（1 で使った $postgres）には、平文に落ちて繋がってはならない。Prisma の CLI の prefer は
# 平文に落ちるため、読み替えで sslmode=require にしないと、TLS を断る接続先（成りすまし）にパスワードの交換を始める。
if out=$(run_with_ca ca.pem "${tls_url/@$tls_postgres:/@$postgres:}" "$migrate_image" 2>&1); then
  echo "$out" >&2
  fail "TLS を受け付けない PostgreSQL に、マイグレーションが平文で繋がった"
fi

# api は PrismaPg に DATABASE_URL をそのまま渡す（apps/api/src/prisma.service.ts）。同じ pg で繋ぐ。
# 出力が true の1行だけであることまで見る——pg は sslmode=require などに SECURITY WARNING を標準エラーに出す（3 の検査に掛かる）。
# shellcheck disable=SC2016
pg_probe='
  const pg = require(require("node:module").createRequire("/app/apps/api/dist/main.js").resolve("pg"));
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  client.connect()
    .then(() => client.query("SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()"))
    .then((result) => { console.log(result.rows[0].ssl); return client.end(); })
    .catch((error) => { console.error(error.code ?? error.message); process.exit(1); });'
out=$(run_with_ca ca.pem "$tls_url" --entrypoint node "$runtime_image" -e "$pg_probe" 2>&1) ||
  { echo "$out" >&2; fail "正しい CA で、実行用のイメージの pg が繋がらない"; }
[ "$out" = "true" ] || fail "実行用のイメージの pg の出力が TLS の接続の true の1行ではない: $out"
if out=$(run_with_ca other-ca.pem "$tls_url" --entrypoint node "$runtime_image" -e "$pg_probe" 2>&1); then
  fail "別の CA でも、実行用のイメージの pg が繋がった（証明書を検証していない）"
fi
grep -q 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' <<<"$out" ||
  fail "別の CA で、実行用のイメージの pg が証明書の検証以外の理由で落ちた: $out"

echo "== 8. どちらのイメージにも RDS の CA のバンドルがあり、本番のリージョンのルート CA を含む"
# リージョンは infra/production/main.tf の provider "aws" の1箇所から、RDS の CA は infra/production/database.tf の db_ca_cert_identifier から、
# バンドルのパスは同じファイルの db_url_tls_parameters の sslrootcert（本番の DATABASE_URL が指すパス）から読む。
region=$(sed -n 's/^  region = "\([^"]*\)"$/\1/p' infra/production/main.tf)
[ -n "$region" ] || fail "infra/production/main.tf から provider のリージョンを読めない"
ca_identifier=$(sed -n 's/^  db_ca_cert_identifier = "\([^"]*\)"$/\1/p' infra/production/database.tf)
[ -n "$ca_identifier" ] || fail "infra/production/database.tf から db_ca_cert_identifier を読めない"
bundle_path=$(sed -n 's/^  db_url_tls_parameters = ".*sslrootcert=\([^"&]*\).*"$/\1/p' infra/production/database.tf)
[ -n "$bundle_path" ] || fail "infra/production/database.tf の db_url_tls_parameters から sslrootcert のパスを読めない"
for image in "$runtime_image" "$migrate_image"; do
  # shellcheck disable=SC2016
  docker run --rm --entrypoint node --env REGION="$region" --env CA_IDENTIFIER="$ca_identifier" --env BUNDLE_PATH="$bundle_path" "$image" -e '
    const { X509Certificate } = require("node:crypto");
    const pem = require("node:fs").readFileSync(process.env.BUNDLE_PATH, "utf8");
    const subjects = pem.split(/(?=-----BEGIN CERTIFICATE-----)/).filter((block) => block.includes("BEGIN"))
      .map((block) => new X509Certificate(block).subject.split("\n"));
    const kind = /^rds-ca-(rsa2048|rsa4096|ecc384)-g1$/.exec(process.env.CA_IDENTIFIER);
    if (kind === null) { console.error(`CA の識別子の形が想定と違う: ${process.env.CA_IDENTIFIER}`); process.exit(1); }
    const want = `CN=Amazon RDS ${process.env.REGION} Root CA ${kind[1].toUpperCase()} G1`;
    if (!subjects.some((lines) => lines.includes(want))) { console.error(`${want} が無い（${subjects.length} 件）`); process.exit(1); }' ||
    fail "$image の RDS の CA のバンドルに、$region のルート CA が無い"
done

echo "== 9. マイグレーション用のイメージには psql 17 があり、本番の DATABASE_URL の形で CA を検証して繋がる。実行用のイメージには psql が無い"
# 運用者が ECS Exec で入る先は、マイグレーション用のイメージのタスクであり api のタスクではない（技術スタックのコンテナの行。#457）。
# psql の文書「psql works best with servers of the same or an older major version.」——RDS は 17 のため、17 の psql を入れる。
version=$(docker run --rm --entrypoint psql "$migrate_image" --version) ||
  fail "マイグレーション用のイメージで psql を起動できない"
[[ "$version" == "psql (PostgreSQL) 17."* ]] || fail "マイグレーション用のイメージの psql が 17 ではない: $version"
out=$(run_with_ca ca.pem "$tls_url" --entrypoint psql "$migrate_image" "$tls_url" \
  --tuples-only --no-align --command "SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()" 2>&1) ||
  { echo "$out" >&2; fail "正しい CA で、マイグレーション用のイメージの psql が繋がらない"; }
[ "$out" = "t" ] || fail "マイグレーション用のイメージの psql の出力が TLS の接続の t の1行ではない: $out"
if out=$(run_with_ca other-ca.pem "$tls_url" --entrypoint psql "$migrate_image" "$tls_url" --command "SELECT 1" 2>&1); then
  fail "別の CA でも、マイグレーション用のイメージの psql が繋がった（証明書を検証していない）"
fi
grep -q 'certificate verify failed' <<<"$out" ||
  fail "別の CA で、マイグレーション用のイメージの psql が証明書の検証以外の理由で落ちた: $out"
# 運用の道具を api のタスクに持たせない。調べる側（docker run）の失敗を「無い」として通さないよう、無いときの印を返させる。
found=$(docker run --rm --entrypoint sh "$runtime_image" -c 'command -v psql || echo absent') ||
  fail "実行用のイメージの中を調べられない"
[ "$found" = "absent" ] || fail "実行用のイメージに psql がある: $found"

echo "すべての確認を通過しました"
