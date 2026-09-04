#!/usr/bin/env bash
# ESLint の走査範囲を検証する。
#
# エージェントが作る git のワークツリーが .claude/worktrees/ に置かれる。
# そこには apps/api などの複製がまるごと入るため、ESLint が走査すると
# 「複数の tsconfig 候補がある」という解析エラーで落ちる。
#
# **CI では起きない。** .claude/ は追跡していないので、CI のチェックアウトには無い。
# 手元でだけ落ちるため、「CI が緑だから良い」で見過ごされ、
# **手元で lint を回す習慣のほうが先に失われる。**
#
# この検査は、走査対象から外れていることを機械で確かめる。
set -euo pipefail

cd "$(dirname "$0")/.."

PROBE_DIR='.claude/worktrees/__lint_scope_probe__/apps/api/src'
PROBE="$PROBE_DIR/probe.ts"

# 後片付け。途中で落ちても消す。
#
# rm -rf は使わない（CLAUDE.md の禁止事項）。置いた1ファイルを消し、
# あとは rmdir で空のディレクトリだけを下から畳む。
# **rmdir は中身のあるディレクトリを消せない**ため、
# 取り違えても実体のあるものを壊しようがない。
cleanup() {
  rm -f "$PROBE"
  d="$PROBE_DIR"
  while [ "$d" != '.claude/worktrees' ] && [ "$d" != '.' ] && [ "$d" != '/' ]; do
    rmdir "$d" 2>/dev/null || true
    d="$(dirname "$d")"
  done
}

# 既存物があれば、何もせずに止まる。
#
# **この確認は trap を仕掛ける前に行う。** 後に置くと、ここで exit したときに
# EXIT トラップが発火し、cleanup の rm -f が「触らないと決めたはずの既存ファイル」を
# 消してしまう。rmdir は空でないディレクトリを消せないが、rm -f はその保護を受けない。
if [ -e '.claude/worktrees/__lint_scope_probe__' ]; then
  echo "NG: 検査用の場所に何かが既にある: .claude/worktrees/__lint_scope_probe__" >&2
  exit 1
fi

# ここから先は自分が置いたものしか無い。後片付けを仕掛けてよい。
trap cleanup EXIT

mkdir -p "$PROBE_DIR"

# **わざと ESLint と Prettier の両方に引っかかるものを置く。**
# - any と未使用の変数 → ESLint が必ず指摘する
# - 詰めた空白と末尾のセミコロン無し → Prettier が必ず整形崩れとして指摘する
# 走査されていれば、出力にこのファイルの名前が必ず現れる。
cat > "$PROBE" <<'PROBE_EOF'
const    使われない変数:any   =    1
PROBE_EOF

# 合否は「道具の終了コード」ではなく「**出力に probe の名前が現れるか**」で判定する。
#
# 終了コードで判定すると、.claude/ と無関係な lint エラーが1件でもあるだけで
# 「.claude/ を走査して落ちた」という**事実と違う診断**を出す。
# eslint.config.js を見に行った人は、そこに原因が無いので迷う。
contains_probe() {
  printf '%s' "$1" | grep -q '__lint_scope_probe__'
}

echo "1. .claude/ の中は ESLint の走査対象から外れている"

set +e
ESLINT_OUT="$(npx eslint . -f unix 2>&1)"
set -e

if contains_probe "$ESLINT_OUT"; then
  echo "  NG: .claude/ の中を走査している" >&2
  echo "      eslint.config.js の ignores に .claude/** が入っているか確かめる。" >&2
  printf '%s\n' "$ESLINT_OUT" | grep '__lint_scope_probe__' | head -5 >&2
  exit 1
fi

echo "  OK: 走査対象から外れている"

# Prettier にも同じ根本原因が残りうる。Prettier は .gitignore を既定では読まないため、
# .prettierignore に書かなければ .claude/ の中の作業中ファイルまで対象に入る。
# ESLint 側だけ直しても、format:check が手元でだけ落ちる状態が残る。
echo "2. .claude/ の中は Prettier の走査対象から外れている"

set +e
PRETTIER_OUT="$(npx prettier --check . 2>&1)"
set -e

if contains_probe "$PRETTIER_OUT"; then
  echo "  NG: .claude/ の中を走査している" >&2
  echo "      .prettierignore に .claude/ が入っているか確かめる。" >&2
  printf '%s\n' "$PRETTIER_OUT" | grep '__lint_scope_probe__' | head -5 >&2
  exit 1
fi

echo "  OK: 走査対象から外れている"
echo
echo "走査範囲の確認を 2 通りすべて通過しました"
