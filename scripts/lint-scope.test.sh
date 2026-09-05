#!/usr/bin/env bash
# ESLint と Prettier の走査範囲を検証する。
#
# エージェントが作る git のワークツリーが .claude/worktrees/ に置かれる。
# そこには apps/api などの複製がまるごと入るため、道具が走査すると
# 手元でだけ検査が落ちる（ESLint は「複数の tsconfig 候補がある」で、
# Prettier は作業中の整形崩れで）。
#
# **CI では起きない。** .claude/ は追跡していないので、CI のチェックアウトには無い。
# 「CI が緑だから良い」で見過ごされ、**手元で検査を回す習慣のほうが先に失われる。**
#
# この検査は、走査対象から外れていることを機械で確かめる。
#
# **一方向の確認では足りない。** 「出力に probe の名前が現れないこと」だけを見ると、
# 道具が起動に失敗した場合も、probe がどのルールにも当たらなくなった場合も緑になる。
# **検査が何も見ていない状態と、正しく除外されている状態が区別できない。**
# そのため次の2つを併せて確かめる。
#
#   1. 陽性対照 — 走査対象**である**場所に同じ probe を置き、
#      出力にその名前が**現れること**を先に確かめる
#   2. 終了コード — 2 は「道具が動かなかった」を意味する。
#      probe 名の有無に関わらず NG とする（1 は「指摘があった」なので正常）
set -euo pipefail

cd "$(dirname "$0")/.."

# 走査対象から外れているべき場所（陰性）
NEG_ROOT='.claude/worktrees/__lint_scope_probe__'
NEG_DIR="$NEG_ROOT/apps/api/src"
NEG="$NEG_DIR/probe.ts"

# 走査対象であるべき場所（陽性対照）
#
# **この置き場所を .gitignore に足してはならない。** Prettier 3 の既定の ignore-path は
# .gitignore と .prettierignore の両方であり、足すと Prettier がここを走査しなくなって、
# 陽性対照が必ず「検出されなかった」で落ちる。
# 「後片付けし損ねた probe が誤ってコミットされるのを防ぐ」目的でも足さない。
# それは下の cleanup が担う。**.gitignore を触ると Prettier の走査範囲が動く。**
POS_ROOT='__lint_scope_probe_positive__'
POS="$POS_ROOT/probe.ts"

# 後片付け。途中で落ちても消す。
#
# rm -rf は使わない（CLAUDE.md の禁止事項）。置いたファイルを消し、
# あとは rmdir で空のディレクトリだけを下から畳む。
# **rmdir は中身のあるディレクトリを消せない**ため、
# 取り違えても実体のあるものを壊しようがない。
cleanup() {
  rm -f "$NEG" "$POS"
  d="$NEG_DIR"
  while [ "$d" != '.claude/worktrees' ] && [ "$d" != '.' ] && [ "$d" != '/' ]; do
    rmdir "$d" 2>/dev/null || true
    d="$(dirname "$d")"
  done
  rmdir "$POS_ROOT" 2>/dev/null || true
}

# 既存物があれば、何もせずに止まる。
#
# **この確認は trap を仕掛ける前に行う。** 後に置くと、ここで exit したときに
# EXIT トラップが発火し、cleanup の rm -f が「触らないと決めたはずの既存ファイル」を
# 消してしまう。rmdir は空でないディレクトリを消せないが、rm -f はその保護を受けない。
for existing in "$NEG_ROOT" "$POS_ROOT"; do
  if [ -e "$existing" ]; then
    echo "NG: 検査用の場所に何かが既にある: $existing" >&2
    exit 1
  fi
done

# ここから先は自分が置いたものしか無い。後片付けを仕掛けてよい。
trap cleanup EXIT

mkdir -p "$NEG_DIR" "$POS_ROOT"

# **わざと ESLint と Prettier の両方に引っかかる内容にする。**
# - any と未使用の変数 → ESLint が指摘する
# - 詰めた空白と末尾のセミコロン無し → Prettier が整形崩れとして指摘する
#
# 2箇所に同じ内容を置く。**内容が同じであることが、陽性対照が対照として
# 成り立つ条件である。**片方だけ書き換えると、比較が意味を失う。
PROBE_BODY='const    使われない変数:any   =    1'
printf '%s\n' "$PROBE_BODY" > "$NEG"
printf '%s\n' "$PROBE_BODY" > "$POS"

contains() {
  printf '%s' "$1" | grep -q "$2"
}

# 道具を1回走らせ、次の3つを判定する。
#   終了コード 2      → 道具が動かなかった。この検査は何も言えない
#   陽性が出力に無い  → probe が検出されない状態。陰性の OK に意味が無い
#   陰性が出力にある  → 除外が効いていない
check_tool() {
  name="$1"
  ignore_hint="$2"
  out="$3"
  code="$4"

  if [ "$code" -eq 2 ]; then
    echo "  NG: $name が動かなかった（終了コード 2）。この検査は何も判定できない" >&2
    printf '%s\n' "$out" | head -10 >&2
    return 1
  fi

  if ! contains "$out" "$POS_ROOT"; then
    echo "  NG: 陽性対照が検出されなかった。probe が $name のどのルールにも当たっていない" >&2
    echo "      probe の内容を、$name が必ず指摘するものに直す。" >&2
    echo "      これが直るまで、除外が効いているかどうかは判定できない。" >&2
    return 1
  fi

  if contains "$out" '__lint_scope_probe__'; then
    echo "  NG: .claude/ の中を走査している" >&2
    echo "      $ignore_hint" >&2
    printf '%s\n' "$out" | grep '__lint_scope_probe__' | head -5 >&2
    return 1
  fi

  echo "  OK: 陽性対照は検出され、.claude/ の中は走査対象から外れている"
}

# **両方を必ず走らせてから、まとめて判定する。**
#
# check_tool をそのまま呼ぶと、1 を返した時点で set -e がスクリプトを終了させ、
# **ESLint が NG のとき Prettier のブロックに到達しない。**
# この PR が見つけたのは「同じ欠落が ESLint と Prettier の2箇所にある」ことであり、
# 2箇所同時に欠けている状態（設定をまとめて作り直したとき、この変更を revert したとき）でこそ
# 両方を報告できなければならない。片方ずつしか出ないと、直して push するたびに
# 次の欠落が現れることになる。
#
# `|| rc=1` の形にすると check_tool は set -e の対象外の文脈で呼ばれるため、
# 途中で止まらずに両方の判定が出る。
rc=0

echo "1. ESLint"
set +e
ESLINT_OUT="$(npx eslint . 2>&1)"
ESLINT_CODE=$?
set -e
check_tool 'ESLint' 'eslint.config.js の ignores に .claude/** が入っているか確かめる。' \
  "$ESLINT_OUT" "$ESLINT_CODE" || rc=1

# **この検査は `npm run format:check` と同じコマンドを走らせる。**
# `--ignore-path .prettierignore` は付けない。付けると .gitignore の影響を切り離せる代わりに、
# **手元と CI が実際に回すコマンドとは別物を検査することになる。**
# この検査の目的は「format:check が .claude/ を走査しないこと」であって、
# 「除外がどのファイルに書かれているか」ではない。
#
# 帰結として、#35 で .gitignore に .claude/ が入ると、Prettier 3 はそちらだけで
# .claude/ を除外するようになり、**この検査は .prettierignore の .claude/ が消えても緑になる。**
# それは検査の穴ではない。除外が .gitignore に移っただけで、
# 「Prettier が .claude/ を走査しない」という守るべき性質は保たれているからである。
# どちらからも消えれば、この検査は変わらず NG を出す。
# 依存関係そのものは #35 に書き残した。
echo "2. Prettier"
set +e
PRETTIER_OUT="$(npx prettier --check . 2>&1)"
PRETTIER_CODE=$?
set -e
check_tool 'Prettier' '.prettierignore（または .gitignore）に .claude/ が入っているか確かめる。' \
  "$PRETTIER_OUT" "$PRETTIER_CODE" || rc=1

if [ "$rc" -ne 0 ]; then
  echo >&2
  echo "走査範囲の確認に失敗しました" >&2
  exit 1
fi

echo
echo "走査範囲の確認を 2 通りすべて通過しました"
