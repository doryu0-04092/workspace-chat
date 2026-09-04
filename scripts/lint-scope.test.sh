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
trap cleanup EXIT

if [ -e '.claude/worktrees/__lint_scope_probe__' ]; then
  echo "NG: 検査用の場所に何かが既にある: .claude/worktrees/__lint_scope_probe__" >&2
  exit 1
fi

mkdir -p "$PROBE_DIR"

# **わざと lint に引っかかるものを置く。**
# 走査されていれば必ず落ちる。落ちなければ、走査対象から外れている。
cat > "$PROBE" <<'PROBE_EOF'
const 使われない変数: any = 1;
PROBE_EOF

echo "1. .claude/ の中は ESLint の走査対象から外れている"

set +e
OUT="$(npx eslint . 2>&1)"
CODE=$?
set -e

if [ "$CODE" -ne 0 ]; then
  echo "  NG: .claude/ の中を走査して落ちた（終了コード $CODE）" >&2
  echo "      eslint.config.js の ignores に .claude/** が入っているか確かめる。" >&2
  echo "--- eslint の出力 ---" >&2
  echo "$OUT" | head -20 >&2
  exit 1
fi

echo "  OK: 走査対象から外れている（終了コード 0）"
echo
echo "ESLint の走査範囲の確認を通過しました"
