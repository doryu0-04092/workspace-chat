# shellcheck shell=bash
# このファイルは実行せず、他のスクリプトから読み込む（shebang を持たない）。
# 検査の対象範囲。check-docs.sh と check-docs.test.sh の両方が読む。
#
# なぜ1箇所に置くか。片方だけに書くと「本物の検査が見ている範囲」と
# 「テストが検査させる範囲」が黙ってずれる。ずれても失敗にはならず、
# 検査がその文書を見ないだけで全ケースが緑のまま通る。
#
# 除外は .gitignore から導出しない。check-docs.sh は「git の追跡状態に依存しない
# （未コミットのファイルも検査対象にする）」方針であり、除外だけを git に委ねると
# 方針が二重になる。**.gitignore に足しただけでは除外されない。この一覧にも足す。**
#
# ■ 制約: DOC_PRUNE_DIRS 配下のファイルを、Markdown のリンク先にしてはならない。
#
# doc_find は2つの用途を兼ねている。
#   1. check-docs.sh — 検査する Markdown を選ぶ
#   2. check-docs.test.sh — 一時ディレクトリへ複製するファイルを選ぶ
# ところがリンク検査はリンク「先」の存在を実ファイルシステムで見ており、doc_find を
# 通していない。そのため除外ディレクトリの中の追跡対象ファイルをリンク先にすると、
# 本物のリポジトリでは通るのに、複製先には存在しないためテストの前提チェックだけが落ちる。
# 原因の切り分けに時間がかかるため、check-docs.sh の検査1がこの制約を直接見る。
#
# .gitignore が `!` で追跡対象に戻しているもの（.env.example / .vscode/extensions.json）が
# これに当たる。.env.example は README から参照されやすいため下で除外から外している。
# .vscode/extensions.json は除外したままとする。リンク先にする必要が生じたら、
# そのときに除外から外す。

# 除外するディレクトリ名。.gitignore が無視するもののうち、Markdown が置かれうるものを挙げる。
# 実装に着手すると、これらが無いと検査が依存パッケージの README まで読みに行く。
DOC_PRUNE_DIRS=(
  .git
  node_modules .pnp
  dist build .vite
  coverage .nyc_output playwright-report test-results blob-report reports
  generated
  uploads tmp
  .terraform
  .vscode .idea
)

# 除外するファイル名。値を持つため、複製すると一時ディレクトリに残り続ける
# （テストは後片付けをしない）。CLAUDE.md の禁止事項は .env の値の扱いを
# 「存在と変数名までに留める」と定めている。terraform.tfstate は RDS のパスワードなどを
# 平文で保持する。DOC_PRUNE_DIRS に .terraform を入れている以上、ディレクトリだけ
# 除外して同じ .gitignore の秘密ファイルを残すのは非対称である。
# `*.tfvars.json` を別に挙げるのは、`*.tfvars` が末尾一致であり
# Terraform が読む JSON 版（terraform.tfvars.json / *.auto.tfvars.json）に一致しないため。
DOC_PRUNE_FILES=(
  '.env' '.env.*'
  '*.tfstate' '*.tfstate.*' '*.tfvars' '*.tfvars.json'
)

# 上に一致しても除外しないもの。.gitignore が `!` で追跡対象に戻しているファイルで、
# 値ではなく変数名しか持たない。除外すると、文書がそこへリンクした時点で
# 「本物の検査は通るのにテストだけが落ちる」というずれが生まれる。
# `*.tfvars.example` はここに要らない。`*.tfvars` は末尾一致であり
# `prod.tfvars.example` に一致しないため、書いても効果を持たない。
# 効果の無い設定を置くと「戻しているから残っている」と読めてしまう。
DOC_KEEP_FILES=(
  '.env.example'
)

# ディレクトリは -path ではなく -name で指定する。実装が始まれば
# apps/api/node_modules のように入れ子になり、-path ./node_modules では当たらない。
doc_find() { # $1... = find に渡す残りの条件（例: -name '*.md' -print）
  local dexpr=() fexpr=() keep=() d g
  for d in "${DOC_PRUNE_DIRS[@]}"; do
    [ ${#dexpr[@]} -eq 0 ] || dexpr+=(-o)
    dexpr+=(-name "$d")
  done
  for g in "${DOC_PRUNE_FILES[@]}"; do
    [ ${#fexpr[@]} -eq 0 ] || fexpr+=(-o)
    fexpr+=(-name "$g")
  done
  for g in "${DOC_KEEP_FILES[@]}"; do
    keep+=(! -name "$g")
  done
  find . "(" \
      "(" "${dexpr[@]}" ")" \
      -o "(" "(" "${fexpr[@]}" ")" "${keep[@]}" ")" \
    ")" -prune -o "$@"
}

# リンク先にできないパスかどうかを判定する。check-docs.sh の検査1が使う。
# ディレクトリ側だけを見ると、.env や terraform.tfstate へのリンクを見逃す。
doc_excluded() { # $1=リンク先のパス。除外なら理由を出力して 0 を返す
  local p="$1" d g
  for d in "${DOC_PRUNE_DIRS[@]}"; do
    case "/$p/" in */"$d"/*) echo "対象外ディレクトリ $d の配下"; return 0 ;; esac
  done
  g=$(doc_excluded_name "$(basename "$p")") && { echo "対象外のファイル名 $g に一致"; return 0; }
  return 1
}

# ファイル名だけで見た除外判定（KEEP を差し引いた DOC_PRUNE_FILES）。
# doc_excluded と、check-docs.test.sh の「値を持つ名前が追跡されていないか」の確認が
# 同じ規則を見るように、判定は1箇所に置く。2箇所に書くと黙ってずれる。
#
# **これはファイル名だけの判定であり、ディレクトリ側（DOC_PRUNE_DIRS）は含まない。**
# 除外判定として尽きているのは doc_excluded のほうである。名前から
# 「doc_excluded の一部」とだけ読むと、呼び出し側が「これで除外は尽きている」と誤読しうる。
doc_excluded_name() { # $1=ファイル名（basename）。除外なら一致したパターンを出力して 0
  local base="$1" g
  for g in "${DOC_KEEP_FILES[@]}"; do
    # shellcheck disable=SC2254
    case "$base" in $g) return 1 ;; esac
  done
  for g in "${DOC_PRUNE_FILES[@]}"; do
    # shellcheck disable=SC2254
    case "$base" in $g) echo "$g"; return 0 ;; esac
  done
  return 1
}

# 宣言に含まれる数をすべて返す。check-docs.sh の3〜4章と、check-docs.test.sh の
# 「N通り」の突き合わせが同じ規則で読むように、読み取りの経路は1つに置く。
# 2箇所に書くと、片方を直したときにもう片方が古い規則のまま残る
# （このファイル冒頭の「片方だけに書くと黙ってずれる」と同じ理由）。
#
# head -1 で先頭1件だけを見ないことがこの関数の要点である。前方に正しい数のおとりが
# 現れると、検査対象が黙ってそちらに移り、本命が古いまま無検査で通る。一致はすべて返す。
# 0件のときに NG とするかは呼び出し側が決める（check-docs.sh は compare_decls、
# check-docs.test.sh は decl_mismatches。どちらも「読み取れない」を NG にしている）。
decls() { # $1=ファイル $2=宣言の正規表現。宣言に含まれる数をすべて返す
  grep -o "$2" "$1" | grep -o "[0-9][0-9]*"
}
