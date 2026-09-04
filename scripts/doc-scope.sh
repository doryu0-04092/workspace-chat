# 検査の対象範囲。check-docs.sh と check-docs.test.sh の両方が読む。
#
# なぜ1箇所に置くか。片方だけに書くと「本物の検査が見ている範囲」と
# 「テストが検査させる範囲」が黙ってずれる。ずれても失敗にはならず、
# 検査がその文書を見ないだけで全ケースが緑のまま通る。
#
# 何を除くか。.gitignore が無視する生成物と .env。
# - node_modules 等は、実装に着手した時点で数万ファイルになる
# - .env は複製すると一時ディレクトリに残り続ける（テストは後片付けをしない）。
#   CLAUDE.md の禁止事項は .env の値の扱いを「存在と変数名までに留める」と定めており、
#   複製を残す設計はその趣旨に合わない
#
# ディレクトリ名は -path ではなく -name で書く。実装が始まれば
# apps/api/node_modules のように入れ子になり、-path ./node_modules では当たらない。

doc_find() { # $1... = find に渡す残りの条件（例: -name '*.md' -print）
  find . \
    \( -name .git \
       -o -name node_modules \
       -o -name dist \
       -o -name build \
       -o -name coverage \
       -o -name .terraform \
       -o -name '.env' \
       -o -name '.env.*' \) -prune -o \
    "$@"
}
