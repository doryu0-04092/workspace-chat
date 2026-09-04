# 検査の対象範囲。check-docs.sh と check-docs.test.sh の両方が読む。
#
# なぜ1箇所に置くか。片方だけに書くと「本物の検査が見ている範囲」と
# 「テストが検査させる範囲」が黙ってずれる。ずれても失敗にはならず、
# 検査がその文書を見ないだけで全ケースが緑のまま通る。
#
# 除外は .gitignore から導出しない。check-docs.sh は「git の追跡状態に依存しない
# （未コミットのファイルも検査対象にする）」方針であり、除外だけを git に委ねると
# 方針が二重になる。**.gitignore に足しただけでは除外されない。この一覧にも足す。**

# 除外するディレクトリ名。.gitignore が無視するもののうち、Markdown が置かれうるものを挙げる。
# 実装に着手すると、これらが無いと検査が依存パッケージの README まで読みに行く。
DOC_PRUNE_DIRS=(
  .git
  node_modules .pnp
  dist build .vite
  coverage .nyc_output playwright-report test-results blob-report
  generated
  uploads tmp
  .terraform
  .vscode .idea
)

# ディレクトリは -path ではなく -name で指定する。実装が始まれば
# apps/api/node_modules のように入れ子になり、-path ./node_modules では当たらない。
doc_find() { # $1... = find に渡す残りの条件（例: -name '*.md' -print）
  local expr=() d
  for d in "${DOC_PRUNE_DIRS[@]}"; do
    expr+=(-name "$d" -o)
  done
  # .env は値を持つため複製しない。テストは後片付けをしないため、複製すると
  # 一時ディレクトリに残り続ける。CLAUDE.md の禁止事項は .env の値の扱いを
  # 「存在と変数名までに留める」と定めている。
  # .env.example は変数名しか持たないので対象に残す（.gitignore も !.env.example で
  # 追跡対象に戻している）。ここで除外すると、README がそこへリンクした時点で
  # 「本物の検査は通るのにテストだけが落ちる」というずれが生まれる。
  find . \
    \( "${expr[@]}" \
       -name '.env' \
       -o \( -name '.env.*' ! -name '.env.example' \) \) -prune -o \
    "$@"
}
