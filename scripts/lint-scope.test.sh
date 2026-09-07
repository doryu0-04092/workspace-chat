#!/usr/bin/env bash
# ESLint と Prettier の**走査範囲**と、**react-hooks のルールの配線**を検証する。
#
# **この2つ目を、名前も冒頭の宣言も長らく含んでいなかった。** ファイルを頭から
# 読んだ人が「3. react-hooks のルール」に来て初めて役割の広がりを知る状態だったため、
# ここに書く。走査範囲が正しくても hooks の配線が外れていれば、このスクリプトは落ちる。
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
# そのため、道具1つにつき次の**3種類の判定**を、**陰性 → 終了コード → 陽性対照**の
# 順で併せて確かめる（**順序そのものに意味がある。**理由は check_tool の中、
# 陰性を最初に見る分岐のところに書いた）。
#
# **この「3種類の判定」は、末尾の総括が数えている検査の数とは別のものである。**
# あちらは begin_check が数える**検査の数**（ESLint / Prettier / react-hooks）を指す。
#
#   1. 陰性 — .claude/ の中に置いた probe の名前が出力に**現れないこと**。
#      現れたら、**終了コードに関わらず**「走査している」と判定する
#   2. 終了コード — **0 と 1 以外は「道具が動かなかった」を意味する。**
#      NG とする（0 は「指摘なし」、1 は「指摘があった」で正常）
#   3. 陽性対照 — 走査対象**である**場所に置いた同じ probe が出力に**現れること**
#
# **この3種類は check_tool の形であり、走査範囲を見る検査（ESLint / Prettier）だけの
# 方法である。** react-hooks の検査は形が違う。陰性に当たるものが無く、代わりに
#
#   - probe に hooks 違反を書き、**両方のルールが error で検出されること**を見る
#     （ルール ID の有無では足りない。理由は「react-hooks のルール」の節に書いた）
#   - **設定を壊した写しで走らせ、検出が消えること**を見る（追跡下の
#     eslint.config.js は書き換えない。壊す確認の直上を参照）
#
# **「検査が何も見ていない状態」と区別している担い手は、次の3つである。
# どれも消してはならない。**
#
#   - **両方のルールが error で検出されること。** probe の `useEffect` から依存漏れが
#     失われると（誰かが probe を書き換えると）、`exhaustive-deps` は**そもそも一度も
#     発火しない。** そのとき壊す確認の側は「error では検出されない」を満たしてしまうため、
#     **この判定だけがその経路を見ている**（設定から行ごと消す壊し方は件数の判定が拾う）
#   - **終了コード**（0/1 以外なら「ESLint が動かなかった。この検査は何も判定できない」）。
#     check_tool の 2 と同じ役割を、react-hooks の側でも別に持っている
#   - **壊した写しでの rules-of-hooks の再判定。** 書き換えていない側が error で
#     出ていなければ、「exhaustive-deps が warn に下がった」のではなく
#     「probe 自体が lint されていない」可能性がある。**exhaustive-deps の判定だけでは
#     この2つを区別できない。** 陽性対照と重複して見えるが、消すと壊す確認が偽の合格を出す
# **役割だけでなく方法もここに書く。** 方法が書かれていないと、読む人は
# その節に来て初めて別の形だと知ることになる。
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

# react-hooks のルール（#18）が実際に効いているかを見る置き場所。
#
# 上の NEG/POS は「.claude/ を走査しないこと」だけを見ており、eslint.config.js に
# 足した react-hooks/rules-of-hooks・react-hooks/exhaustive-deps が実際に
# 配線されているかは別懸念として見ていない。files のパターンが壊れても、
# NEG/POS の判定（any・未使用変数・整形崩れ）は他のルールで変わらず検出されるため、
# ここだけを見ていては気づけない。
#
# 置き場所は apps/web 配下でなければならない。react-hooks のルールは
# `apps/web/**/*.{ts,tsx}` にしか適用されないため、.claude/ 配下や apps/api に
# 置くと最初から対象外になり、判定にならない。
#
# 名前に NEG_NAME を含めない（向きに注意。**NEG_NAME がこの名前の部分文字列に
# なってはならない**、という関係である）。含むと上の陰性判定
# （contains "$out" "$NEG_NAME"）がこの probe にも反応し、
# 「.claude/ を走査している」という無関係な NG に化ける。
HOOKS_ROOT='apps/web/src/__lint_scope_hooks_probe__'
HOOKS_PROBE="$HOOKS_ROOT/Probe.tsx"

# 壊す確認用に一時的に書く、exhaustive-deps を 'warn' に戻した eslint.config.js の
# 写し。空文字列の間はまだ用意していないという意味で扱う（trap 発火時に set -u で
# 落ちないよう、変数だけは先に宣言しておく）。
#
# **追跡下の eslint.config.js 自体は書き換えない。** リポジトリ直下に置くのは、
# ESM の import（`import js from '@eslint/js'`）が node_modules を探すのに
# ディレクトリ階層を辿るためで、リポジトリの外の一時ディレクトリに置くと
# `ERR_MODULE_NOT_FOUND` になる（実測）。
HOOKS_BROKEN_CONFIG=''
# mktemp が最初に作る、拡張子の付く前の名前。改名の前後どちらで落ちても
# 消えるように、これも別の変数で持つ（改名後は空にする）。
hooks_broken_seed=''

# 後片付け。途中で落ちても消す。
#
# rm -rf は使わない（CLAUDE.md の禁止事項）。置いたファイルを消し、
# あとは rmdir で空のディレクトリだけを下から畳む。
# **rmdir は中身のあるディレクトリを消せない**ため、
# 取り違えても実体のあるものを壊しようがない。
#
# 畳む範囲の終端は NEG_STOP である（求めている場所は、その変数名で辿れる）。
# **「自分がこれから作る分」から導く。深さで決め打ちしない。**
cleanup() {
  rm -f "$NEG" "$POS" "$HOOKS_PROBE"
  d="$NEG_DIR"
  while [ "$d" != "$NEG_STOP" ] && [ "$d" != '.' ] && [ "$d" != '/' ]; do
    rmdir "$d" 2>/dev/null || true
    d="$(dirname "$d")"
  done
  rmdir "$POS_ROOT" 2>/dev/null || true
  rmdir "$HOOKS_ROOT" 2>/dev/null || true
  # 壊す確認用に書いた一時ファイルを消す。リポジトリ直下に置いているため、
  # 消し忘れると未追跡ファイルとして残り続ける。
  rm -f "$HOOKS_BROKEN_CONFIG" "$hooks_broken_seed"
}

# 既存物があれば、何もせずに止まる。
#
# **この確認は trap を仕掛ける前に行う。** 後に置くと、ここで exit したときに
# EXIT トラップが発火し、cleanup の rm -f が「触らないと決めたはずの既存ファイル」を
# 消してしまう。rmdir は空でないディレクトリを消せないが、rm -f はその保護を受けない。
for existing in "$NEG_ROOT" "$POS_ROOT" "$HOOKS_ROOT"; do
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

mkdir -p "$NEG_DIR" "$POS_ROOT" "$HOOKS_ROOT"

# **わざと ESLint と Prettier の両方に引っかかる内容にする。**
# - any と未使用の変数 → ESLint が指摘する
# - 詰めた空白と末尾のセミコロン無し → Prettier が整形崩れとして指摘する
#
# 2箇所に同じ内容を置く。**内容が同じであることが、陽性対照が対照として
# 成り立つ条件である。**片方だけ書き換えると、比較が意味を失う。
PROBE_BODY='const    使われない変数:any   =    1'
printf '%s\n' "$PROBE_BODY" > "$NEG"
printf '%s\n' "$PROBE_BODY" > "$POS"

# **わざと rules-of-hooks と exhaustive-deps の両方に引っかかる内容にする。**
# - 条件分岐の中の useState 呼び出し → react-hooks/rules-of-hooks
# - useEffect の依存配列に id が抜けている → react-hooks/exhaustive-deps
# 2つとも入れるのは、どちらか一方だけが壊れても気づけるようにするため。
cat > "$HOOKS_PROBE" <<'EOF'
import { useEffect, useState } from 'react';

export function LintScopeHooksProbe({ cond, id }: { cond: boolean; id: number }) {
  if (cond) {
    const [value] = useState(0);
    return <div>{value}</div>;
  }
  const [count, setCount] = useState(0);
  useEffect(() => {
    setCount(id);
  }, []);
  return <div>{count}</div>;
}
EOF

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

# 検査の見出しを出し、**同時に数える。**
#
# 総括が出す件数を手で書かない（規則と理由は scripts/doc-scope.sh の decls の直上にある。「実数から導くか、機械が照合できる
# 形にする」）。このスクリプトの件数を照合している道具は無く、check-docs.sh も
# check-docs.test.sh も lint-scope を見ていない。**手で書くと、4つ目の検査を足した
# 時点で黙ってずれ、動作は壊れないので誰も気づかない。**
# 見出しの番号も同じ数から出すため、番号と総括が食い違いようがない。
checks_total=0
begin_check() {
  checks_total=$((checks_total + 1))
  echo "$checks_total. $1"
}

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
begin_check ESLint
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
begin_check Prettier
set +e
PRETTIER_OUT="$(npm run format:check 2>&1)"
PRETTIER_CODE=$?
set -e
check_tool 'Prettier' '.prettierignore（または .gitignore）に .claude/ が入っているか確かめる。' \
  "$PRETTIER_OUT" "$PRETTIER_CODE" || rc=1

# --- 3. react-hooks のルールが実際に効いていること -------------------------------
#
# 1./2. は .claude/ の走査範囲だけを見ており、eslint.config.js に足した
# react-hooks/rules-of-hooks・react-hooks/exhaustive-deps が実際に配線されて
# いるかは見ていない。誰かが files のパターンを壊しても、NEG/POS の判定は
# 他のルール（any・未使用変数）で変わらず緑のまま通る。
begin_check "react-hooks のルール"

# ルール ID が出力に含まれるだけでは足りない。probe は rules-of-hooks と
# exhaustive-deps の両方に引っかかるようにしてあり、rules-of-hooks は常に
# error で検出される。exhaustive-deps だけを誤って 'warn' に戻しても、
# rules-of-hooks の error のおかげで npm run lint の終了コードは 1 のままであり、
# ルール ID の有無だけを見る判定は「検出された」と誤判定する。守るべき性質は
# 「hooks 違反で npm run lint が赤になること」であり、ルール ID を含む行の
# 重大度（error であること）まで見る。
#
# ESLint の stylish フォーマットは、ファイルパスを行頭（インデント無し）に
# 見出しとして置き、そのファイルの違反を `<行:列>  <重大度>  <メッセージ>
# <ルール ID>` の形でインデントして並べる。見出しが次に現れるまでが
# そのファイルの違反である。
#
# **場所まで見る。** ルール ID と重大度が一致するだけでは足りない。
# 出力全体から探すと、$HOOKS_PROBE 以外のファイルが同じルールで error を
# 出した場合にも一致してしまい、$HOOKS_PROBE 自体が lint されていなくても
# 陽性対照を通過しうる（check_tool が NEG_NAME を「.claude/ の中の」という
# 場所ごと確かめているのと同じ理由で、ここも「$HOOKS_PROBE の中の」という
# 場所まで確かめる）。見出し行が今の probe のものかどうかで in_file を
# 切り替え、その区間の行だけを対象にする。
#
# ファイルパスの文字列そのものは比べない。ESLint は Windows で絶対パス・
# 区切りが `\`、それ以外では相対パス・区切りが `/` を出すため
# （NEG_NAME の直上に書いた理由と同じ）、一意な名前（$HOOKS_ROOT の
# 末尾のディレクトリ名）の部分一致で見出し行を判定する。
#
# **パイプを使わない。** ヒアストリング（`<<<`）で awk に渡す。
# `printf ... | grep -qE ...` のようにパイプにすると、読み手が先に終了して
# 書き手が SIGPIPE で死にうる（contains の直上に実測とともに書いた理由と同じ）。
hooks_rule_is_error() { # $1=出力 $2=ルール ID
  awk -v probe_name="${HOOKS_ROOT##*/}" -v rule="$2" '
    /^[^ ]/ { in_probe = (index($0, probe_name) > 0); next }
    in_probe && $0 ~ ("^ *[0-9]+:[0-9]+ +error .*" rule "$") { found = 1 }
    END { exit !found }
  ' <<< "$1"
}

# 1. の ESLint 実行（$ESLINT_OUT・$ESLINT_CODE）をそのまま使う。probe は
# NEG/POS と同じタイミング（1. より前）で置いているため、$ESLINT_OUT には
# 既に probe の結果が含まれている。npm script をもう一度走らせない
# （package.json 側のコマンドが変わっても検査が古いままにならないという
# 「1. ESLint」の直上に書いた理由は、ここでも npm run lint を経由することで
# 保っている）。
if [ "$ESLINT_CODE" -ne 0 ] && [ "$ESLINT_CODE" -ne 1 ]; then
  echo "  NG: ESLint が動かなかった（終了コード $ESLINT_CODE）。この検査は何も判定できない" >&2
  head -10 <<< "$ESLINT_OUT" >&2
  rc=1
elif ! hooks_rule_is_error "$ESLINT_OUT" 'react-hooks/rules-of-hooks' ||
     ! hooks_rule_is_error "$ESLINT_OUT" 'react-hooks/exhaustive-deps'; then
  # **どちらが欠けたかを出す。** 判定は「どちらか一方でも欠ければ」発火するのに
  # 「両方とも検出されていない」と断定すると、片方だけが warn に下がった場合——
  # **この検査が作られた動機そのものの事象**——にも同じ文言が出る。読む側は
  # 「両方とも」を手掛かりに、両方が同時に落ちる原因（プラグインの読み込み、files の
  # 範囲）を先に疑うことになる。2回別々に呼んでいるので、どちらが欠けたかは分かる。
  hooks_missing=''
  hooks_rule_is_error "$ESLINT_OUT" 'react-hooks/rules-of-hooks' || hooks_missing='react-hooks/rules-of-hooks'
  if ! hooks_rule_is_error "$ESLINT_OUT" 'react-hooks/exhaustive-deps'; then
    hooks_missing="${hooks_missing:+$hooks_missing と }react-hooks/exhaustive-deps"
  fi
  echo "  NG: $hooks_missing が error で検出されていない" >&2
  echo "      probe の内容と、そのルールの重大度が 'error' であることを確かめる。" >&2
  # **files も案内する。** probe の内容と重大度が正しくても、eslint.config.js の
  # files が probe の置き場所（$HOOKS_ROOT）を含まなくなればここに落ちる。
  # 案内が2つの疑い先しか出さないと、原因から遠いところを探すことになる。
  # check_tool が ignore_hint で被参照側（ignores / .prettierignore）を名指しするのと同じ形。
  echo "      eslint.config.js の files が $HOOKS_ROOT を含んでいることも確かめる。" >&2
  head -20 <<< "$ESLINT_OUT" >&2
  rc=1
else
  # 壊す確認: exhaustive-deps を 'warn' に戻した設定を一時ファイルに書き、
  # --config でそこだけを明示的に指す。**追跡下の eslint.config.js 自体は
  # 書き換えない。** check-docs.test.sh が複製（$work）だけを壊すのと同じ型で、
  # 実物を書き換えないぶん、バックアップ・trap での復元・空振りしたときに
  # 壊れたまま残るおそれが丸ごと無い。
  #
  # 一時ファイルはリポジトリ直下に置く（.js のまま）。eslint.config.js は
  # `import js from '@eslint/js'` のような ESM import を持ち、node は
  # import 元のディレクトリから親へ node_modules を辿って解決する。
  # リポジトリの外の一時ディレクトリ（例: /tmp）に置くと、辿った先に
  # node_modules が無く ERR_MODULE_NOT_FOUND で ESLint 自体が起動しない
  # （実測）。cleanup がここで作る一時ファイルを消す。
  #
  # **mktemp の --suffix と -p は GNU coreutils の拡張であり、macOS（BSD）には無い。**
  # 使うと不正なオプションで終了し、set -e によって NG の説明が1行も出ないまま
  # スクリプトが止まる。README は「CI が回すのと同じ検査を手元で通す」手順として
  # これを案内しているため、環境で動かないと案内自体が成り立たない。
  # **末尾に X が並ぶテンプレートを渡す形は GNU と BSD の両方にある**ので、
  # そちらで作ってから .js を付けて改名する（拡張子が要るのは、node が
  # 拡張子でモジュールの種類を決めるためである）。
  hooks_broken_seed="$(mktemp ./eslint-broken.XXXXXX)"
  HOOKS_BROKEN_CONFIG="$hooks_broken_seed.js"
  mv "$hooks_broken_seed" "$HOOKS_BROKEN_CONFIG"
  hooks_broken_seed=''
  sed "s/'react-hooks\/exhaustive-deps': 'error'/'react-hooks\/exhaustive-deps': 'warn'/" \
    eslint.config.js > "$HOOKS_BROKEN_CONFIG"

  # 置換が実際に効いたことを grep -c の件数で確かめる
  # （元の eslint.config.js に 'error' が1件、書き換えた側に 'warn' が1件）。
  hooks_broken_before=$(grep -cF "'react-hooks/exhaustive-deps': 'error'" eslint.config.js || true)
  hooks_broken_after=$(grep -cF "'react-hooks/exhaustive-deps': 'warn'" "$HOOKS_BROKEN_CONFIG" || true)

  if [ "$hooks_broken_before" -ne 1 ] || [ "$hooks_broken_after" -ne 1 ]; then
    echo "  NG: sed が想定どおりに exhaustive-deps を 'warn' に書き換えられていない（変更前 error $hooks_broken_before 件 / 変更後 warn $hooks_broken_after 件）" >&2
    rc=1
  else
    # **ここだけは「npm script をそのまま呼ぶ。コマンドを複製しない」の例外である。**
    # 壊した設定を指すには --config を渡すほかなく、package.json の lint は
    # それを受け取れない（npm run lint -- --config は npm のバージョンによって
    # 引数の渡り方が変わり、依存を1つ増やすことになる）。
    #
    # **例外の代償は残る。** package.json の lint に対象の絞り込みや追加のフラグが
    # 足されると、**この壊す確認だけが古いコマンドを走らせ続ける。**
    # 上の「1. ESLint」の直上が塞ごうとした穴が、ここには開いたままである。
    # 判定側（陰性・陽性対照・重大度）は $ESLINT_OUT を使っており npm run lint を
    # 経由しているため、**穴が残るのは「壊すと落ちるか」の確認だけである。**
    set +e
    HOOKS_BROKEN_OUT="$(npx eslint . --config "$HOOKS_BROKEN_CONFIG" 2>&1)"
    HOOKS_BROKEN_CODE=$?
    set -e
    if [ "$HOOKS_BROKEN_CODE" -ne 0 ] && [ "$HOOKS_BROKEN_CODE" -ne 1 ]; then
      echo "  NG: 壊した設定で ESLint が動かなかった（終了コード $HOOKS_BROKEN_CODE）。この検査は何も判定できない" >&2
      head -10 <<< "$HOOKS_BROKEN_OUT" >&2
      rc=1
    elif ! hooks_rule_is_error "$HOOKS_BROKEN_OUT" 'react-hooks/rules-of-hooks'; then
      # rules-of-hooks は今回書き換えていない。ここが error で出ていなければ、
      # 「exhaustive-deps が warn に下がった」のではなく「probe 自体が
      # lint されていない」（--config の指し先を誤った、ファイルが対象外に
      # なった等）可能性がある。exhaustive-deps 側の判定だけでは
      # この2つを区別できないため、rules-of-hooks の陽性対照を別に見る。
      echo "  NG: 壊した設定で probe が lint されていない（react-hooks/rules-of-hooks も検出されなかった）" >&2
      head -20 <<< "$HOOKS_BROKEN_OUT" >&2
      rc=1
    elif hooks_rule_is_error "$HOOKS_BROKEN_OUT" 'react-hooks/exhaustive-deps'; then
      echo "  NG: exhaustive-deps を 'warn' に戻しても error のまま検出された（壊す確認が効いていない）" >&2
      rc=1
    else
      echo "  OK: 陽性対照は error で検出され、exhaustive-deps を 'warn' に戻すと error では検出されなくなることも確認した"
    fi
  fi

  rm -f "$HOOKS_BROKEN_CONFIG"
  HOOKS_BROKEN_CONFIG=''
fi

if [ "$rc" -ne 0 ]; then
  echo >&2
  echo "lint 設定の確認に失敗しました（走査範囲 / react-hooks）" >&2
  exit 1
fi

echo
echo "lint 設定の確認（走査範囲 / react-hooks）を $checks_total 通りすべて通過しました"
