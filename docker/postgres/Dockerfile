# PostgreSQL 17 に pg_bigm を足したイメージ。開発環境（compose.yaml）だけが使う。
#
# なぜ自分でビルドするか。
#   1. 公式の postgres:17 に pg_bigm は入っていない
#   2. PGDG の apt リポジトリにも pg_bigm のパッケージが無い（bookworm / trixie の
#      Packages を実際に取得して検索し、0 件であることを確認した。2026-09-04）
#   3. Docker Hub には第三者が作った pg_bigm 入りイメージがあるが、供給元が個人であり
#      更新が続く保証が無い。DB は最も差し替えの効かない層であるため、
#      ここで素性の分からないイメージに依存しない
#
# 代償: 初回の `docker compose up` がビルドのぶん遅くなる。
# 2回目以降は Docker のレイヤキャッシュが効く。
# また pg_bigm の更新に自動で追随しない（ARG を手で上げる）。

# 土台は1箇所で決める。ビルド段と実行段で違う版を使うと、
# ビルドした .so が動かない組み合わせを黙って作れてしまう。
#
# **土台はダイジェストではなくタグで指す。下の pg_bigm とは扱いが違う。**
# 代償: PostgreSQL のマイナー更新でタグの指す先が変わるため、
# **同じ Dockerfile が別の版をビルドしうる。** docs/tech-stack.md に書いた
# 確認結果（17.11）も、その時点で確認した版という意味しか持たない。
#
# それでもタグにするのは、**固定するとマイナーの修正が届かなくなるため**である。
# 依存の自動更新（dependabot.yml）は Dockerfile を見ていないので（#38）、
# ダイジェストで固定すると誰かが手で上げるまで古いままになる。
# pg_bigm を SHA-1 で固定するのは、**取得元が上流のソースであり、
# タグが動けばビルドする中身が変わる**ためで、性質が違う。
ARG POSTGRES_IMAGE=postgres:17-bookworm

FROM ${POSTGRES_IMAGE} AS build

# タグは付け替えられるが、コミットの SHA-1 は中身から決まるため動かせない。
# タグだけを指すと、同じ Dockerfile が別の中身をビルドしうる。
ARG PG_BIGM_TAG=v1.2-20250903
ARG PG_BIGM_COMMIT=735dceba0ecdd8ac1aaaaa207226a7102b6bbd71

# PG_MAJOR は postgres イメージが持つ環境変数（17）。ここで版を書き直さない。
# DESTDIR に出すのは、pg_bigm が入れたファイルだけを実行段へ運ぶため。
# インストール先を直接書くと、PostgreSQL の版を上げたときに黙って空振りする。
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      build-essential \
      ca-certificates \
      git \
      "postgresql-server-dev-$PG_MAJOR"; \
    git clone --depth 1 --branch "$PG_BIGM_TAG" https://github.com/pgbigm/pg_bigm.git /tmp/pg_bigm; \
    cd /tmp/pg_bigm; \
    test "$(git rev-parse HEAD)" = "$PG_BIGM_COMMIT"; \
    make USE_PGXS=1; \
    make USE_PGXS=1 install DESTDIR=/staging

FROM ${POSTGRES_IMAGE}

# ビルド道具（build-essential / git）は実行段に持ち込まない。
COPY --from=build /staging/ /

# COPY は /staging が空でも成功する。ここで実体を確かめる。
# 見つからなければイメージのビルドが落ちる。起動してから
# 「shared_preload_libraries を読めない」で落ちるより原因が近い。
RUN test -f "$(pg_config --pkglibdir)/pg_bigm.so" \
 && test -f "$(pg_config --sharedir)/extension/pg_bigm.control"
