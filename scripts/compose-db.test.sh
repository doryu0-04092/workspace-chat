#!/usr/bin/env bash
# 開発環境の compose（compose.yaml・docker/postgres/Dockerfile）の db を、実際に作って動かして確かめる（#28）。
#
#   1. compose.yaml の構文が通る（docker compose config --quiet）
#   2. db のイメージがビルドできる（pg_bigm のビルドを含む）
#   3. db が起動してヘルスチェックを通り、CREATE EXTENSION pg_bigm が通る
#   4. gin_bigm_ops の索引が、LIKE '%…%' の検索で使われ、正しい件数を返す
#
# compose.yaml の値（${VAR:?…}）は環境変数から渡す。**秘密ではない使い捨ての値**を、未設定のものだけここで作る
# （.env を置かない CI 向け。手元で .env があっても、環境変数が優先される）。
# 手元の開発用 DB に触れないよう、別のプロジェクト名（コンテナ・ボリュームの名前が変わる）と別のポートで起動し、
# 終わりにコンテナとボリュームを消す（イメージは残す）。Docker が動いていることが前提。
set -euo pipefail

cd "$(dirname "$0")/.."

fail() {
  echo "NG: $*" >&2
  exit 1
}

export POSTGRES_USER="${POSTGRES_USER:-compose_test}"
export POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')}"
export POSTGRES_DB="${POSTGRES_DB:-compose_test}"
export POSTGRES_PORT="${POSTGRES_PORT:-55432}"
export REDIS_PORT="${REDIS_PORT:-56379}"
project="workspace-chat-compose-test-$$"

compose() {
  docker compose -p "$project" "$@"
}

cleanup() {
  compose down -v --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT

sql() {
  compose exec -T db psql -v ON_ERROR_STOP=1 -q -A -t -U "$POSTGRES_USER" -d "$POSTGRES_DB" "$@"
}

echo "== 1. compose.yaml の構文"
compose config --quiet || fail "compose.yaml の構文が通らない"

echo "== 2. db のイメージのビルド（pg_bigm を含む）"
compose build db || fail "db のイメージをビルドできない"

echo "== 3. db の起動と CREATE EXTENSION pg_bigm"
compose up -d --wait db || fail "db が起動してヘルスチェックを通らない"
sql -c 'CREATE EXTENSION pg_bigm' || fail "CREATE EXTENSION pg_bigm が通らない"

echo "== 4. gin_bigm_ops の索引が LIKE '%…%' で使われる"
# 順に走らせる索引を使わない経路（seqscan）を切り、索引で引けるかだけを見る。
plan=$(
  sql <<'SQL'
CREATE TABLE bigm_probe (body text NOT NULL);
INSERT INTO bigm_probe SELECT 'message number ' || g FROM generate_series(1, 2000) AS g;
INSERT INTO bigm_probe VALUES ('the bigm-probe row');
CREATE INDEX bigm_probe_body ON bigm_probe USING gin (body gin_bigm_ops);
ANALYZE bigm_probe;
SET enable_seqscan = off;
EXPLAIN SELECT body FROM bigm_probe WHERE body LIKE '%bigm-probe%';
SQL
) || fail "索引の確かめの SQL が通らない"
echo "$plan" | grep -q 'Bitmap Index Scan on bigm_probe_body' ||
  fail "gin_bigm_ops の索引が使われない: $(echo "$plan" | tr '\n' ' ')"
hits=$(sql -c "SET enable_seqscan = off; SELECT count(*) FROM bigm_probe WHERE body LIKE '%bigm-probe%'")
[ "$hits" = "1" ] || fail "索引で引いた件数が 1 でない: $hits"

echo "compose の db が通った"
