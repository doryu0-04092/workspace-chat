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
# そのため次の3つを、**陰性 → 終了コード → 陽性対照**の順で併せて確かめる
# （**順序そのものに意味がある。**理由は check_tool の直上に書いた）。
#
#   1. 陰性 — .claude/ の中に置いた probe の名前が出力に**現れないこと**。
#      現れたら、**終了コードに関わらず**「走査している」と判定する
#   2. 終了コード — **0 と 1 以外は「道具が動かなかった」を意味する。**
#      NG とする（0 は「指摘なし」、1 は「指摘があった」で正常）
#   3. 陽性対照 — 走査対象**である**場所に置いた同じ probe が出力に**現れること**
set -euo pipefail

cd "$(dirname "$0")/.."

# 走査対象から外れているべき場所（陰性）
#
# **出力の中から probe を探すのに使うのは「パス」ではなく「名前」（NEG_NAME）である。**
# ESLint は Windows で C:\...\.claude\worktrees\__lint_scope_probe__\... のように
# 区切りが \ の絶対パスを出し、Prettier は .claude/worktrees/... の相対パスを出す。
# NEG_ROOT（区切りが /）で探すと ESLint の出力に一致せず、
# **除外が壊れていても手元でだけ「OK」を出す**。名前で探せばどちらにも一致する。
# 直書きの文字列は置かない。名前を変えたら判定も一緒に変わる。
NEG_NAME='__lint_scope_probe__'
NEG_ROOT=".claude/worktrees/$NEG_NAME"
NEG_DIR="$NEG_ROOT/apps/api/src"
NEG="$NEG_DIR/probe.ts"

# 走査対象であるべき場所（陽性対照）
#
# **陰性の名前が、陽性の名前の部分文字列になってはならない。**
# なると陰性の判定が陽性対照に反応し、除外が効いていても NG になる。
# 現在は成り立っている（__lint_scope_probe__ は probe の後が __、
# __lint_scope_probe_positive__ は _p であり、前者は後者に含まれない）。
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
#
# 畳む範囲の終端は NEG_STOP（下で mkdir の直前に求める）。
# **「自分がこれから作る分」から導く。深さで決め打ちしない。**
cleanup() {
  rm -f "$NEG" "$POS"
  d="$NEG_DIR"
  while [ "$d" != "$NEG_STOP" ] && [ "$d" != '.' ] && [ "$d" != '/' ]; do
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

# 後片付けの終端を、**mkdir -p がこれから新しく作る最上位**から求める。
#
# 深さで決め打ちすると、片付ける範囲が「自分が作ったもの」ではなくなる。
# .claude/ がまだ無い環境——**CI がまさにそれである**——では、mkdir -p が
# .claude/ と .claude/worktrees/ も新しく作る。終端を .claude/worktrees に
# 固定していると、この2階層が毎回そこに残り続ける。
#
# 逆に、既にワークツリーを使っている手元では .claude/worktrees/ が既存なので
# ループはそこで止まり、**自分が作っていないものには触らない。**
# rmdir を使う構造は変えていないので、中身があれば失敗して残る保護もそのまま効く。
#
# **この計算は mkdir より前でなければならない。** 後に置くと、自分が作った
# ディレクトリが「既にある」ことになり、終端が一番深いところに寄ってしまう。
# trap より前でもある。trap の発火時に NEG_STOP が未定義だと set -u で落ちる。
p="$NEG_DIR"
NEG_TOP="$p"
while [ ! -d "$p" ]; do
  NEG_TOP="$p"
  p="$(dirname "$p")"
done
NEG_STOP="$(dirname "$NEG_TOP")"

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

# **パイプを使わない。** `printf '%s' "$1" | grep -qF "$2"` にすると、
# 読み手が一致した時点で抜けたときに printf が SIGPIPE で 141 で死ぬ。
# set -o pipefail は「非0がひとつでもあればそれを返す」ため、
# **grep が一致していてもパイプライン全体が非0になり、判定が「一致しない」に反転する。**
# 陰性の判定でこれが起きると、除外が壊れていても OK を出す——
# この検査が塞ごうとしている偽の合格そのものを、判定関数が持つことになる。
#
# 実測（bash 5, Git Bash, 入力 20MB・一致箇所は先頭）:
#   printf | head -c 1        → PIPESTATUS=[141 0]  ← 書き手が SIGPIPE で死ぬ
#   printf | grep -qF <一致>  → PIPESTATUS=[0 0]    ← この grep は最後まで読んでいた
# **この環境では反転しなかったが、成立するかは grep の実装と環境に依る。**
# CI は ubuntu であり手元とは別物である。
#
# case のパターン照合なら子プロセスもパイプも無く、環境に依らない。
# `"$2"` を引用すればグロブとして解釈されないので、grep -F の意図もそのまま保てる。
contains() {
  case "$1" in
    *"$2"*) return 0 ;;
    *) return 1 ;;
  esac
}

# 道具を1回走らせ、次の3つを**この順で**判定する。
#   陰性が出力にある      → 除外が効いていない（**終了コードより先に見る。下の理由**）
#   終了コードが 0/1 以外 → 道具が動かなかった。この検査は何も言えない
#   陽性が出力に無い      → probe が検出されない状態。陰性の OK に意味が無い
#
# **「2 だけ」で見てはいけない。** ESLint も Prettier も「指摘あり」は 1 のみで、
# それ以外は起動失敗か npm 自身の失敗である。2 だけを拾うと、
# 道具が1行も走っていないのに「陽性対照が検出されなかった」に落ち、
# **「probe の内容を直せ」と案内してしまう。原因から遠ざかる。**
#   例) npm ci の前に実行して eslint が居ない
#       → POSIX の sh では 127。**ただし Windows では 1 になり、この判定には掛からない**（実測）。
#          そのため下の陽性対照の分岐でも出力を出す。片方だけでは足りない。
check_tool() {
  name="$1"
  ignore_hint="$2"
  out="$3"
  code="$4"

  # **陰性を最初に見る。順序に意味がある。**
  #
  # 出力に probe の名前があることは、終了コードに関わらず
  # **道具が .claude/ の中まで到達した動かぬ証拠**である。
  #
  # 終了コードを先に見ると誤診する。.claude/worktrees/ に入るのは作業中の
  # ワークツリーであり、**構文として成立していない .ts が置かれうる場所**である。
  # 除外が消えた状態で走らせると Prettier はそれを走査して 2 で終わり、
  # 「Prettier が動かなかった」と報告される。**実際には動いており、
  # .claude/ を走査したことこそが原因である。**
  # この検査が存在する目的そのものの事象で、原因から遠い案内が出てしまう。
  if contains "$out" "$NEG_NAME"; then
    echo "  NG: .claude/ の中を走査している" >&2
    echo "      $ignore_hint" >&2
    printf '%s\n' "$out" | grep -F "$NEG_NAME" | head -5 >&2
    return 1
  fi

  if [ "$code" -ne 0 ] && [ "$code" -ne 1 ]; then
    echo "  NG: $name が動かなかった（終了コード $code）。この検査は何も判定できない" >&2
    printf '%s\n' "$out" | head -10 >&2
    return 1
  fi

  if ! contains "$out" "$POS_ROOT"; then
    echo "  NG: 陽性対照が検出されなかった。probe が $name のどのルールにも当たっていない" >&2
    echo "      probe の内容を、$name が必ず指摘するものに直す。" >&2
    echo "      これが直るまで、除外が効いているかどうかは判定できない。" >&2
    # **出力も出す。** 上の判定を抜けても道具が走っていないことがある。
    # npm は「script が無い」を 1 で返すため、0/1 以外の判定には掛からず
    # ここに落ちてくる。そのとき出力だけが切り分けの手掛かりになる。
    printf '%s\n' "$out" | head -10 >&2
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

# **npm script をそのまま呼ぶ。コマンドを複製しない。**
# npx eslint . / npx prettier --check . と書くと、package.json の scripts と
# 同じ内容を2箇所に持つことになる。**package.json 側に対象の絞り込みや
# --ignore-path が足されても、この検査は古いコマンドを走らせ続ける。**
# そのとき検査は緑のまま lint / format:check だけが落ちる——
# この検査が塞ごうとしている経路と同じ形の穴になる。
#
# npm が子の終了コードをそのまま返すことに依存する（check_tool の「0/1 以外」の判定）。
# 実測で確かめた: `exit 2` の script → 2 / eslint.config.js を構文的に壊す →
# npx も npm run も 2 / prettier が解析できないファイルを置く → npx も npm run も 2。
echo "1. ESLint"
set +e
ESLINT_OUT="$(npm run lint 2>&1)"
ESLINT_CODE=$?
set -e
check_tool 'ESLint' 'eslint.config.js の ignores に .claude/** が入っているか確かめる。' \
  "$ESLINT_OUT" "$ESLINT_CODE" || rc=1

# **この検査は `npm run format:check` そのものを走らせる。**
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
PRETTIER_OUT="$(npm run format:check 2>&1)"
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
