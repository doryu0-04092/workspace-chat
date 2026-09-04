#!/usr/bin/env bash
# ドキュメントの機械的な検査。
# 目的は「実行した事実を成果物に残すこと」であり、内容の正しさは人間とレビューが見る。
set -uo pipefail
cd "$(dirname "$0")/.."

fail=0
note() { echo "  NG: $*"; fail=1; }

# git の追跡状態に依存しない。未コミットのファイルも検査対象にするため。
mapfile -t docs < <(find . -name '*.md' -not -path './.git/*' | sed 's|^\./||' | sort)
[ "${#docs[@]}" -gt 0 ] || { echo "NG: 検査対象の Markdown が1件も見つからない"; exit 1; }

echo "1. 相対リンクの検証（対象 ${#docs[@]} ファイル）"
for f in "${docs[@]}"; do
  d=$(dirname "$f")
  while IFS= read -r l; do
    [ -z "$l" ] && continue
    [ -e "$d/$l" ] || note "$f -> $l が存在しない"
  done < <(grep -o "](\([^)h][^)]*\))" "$f" | sed 's/](\(.*\))/\1/' | sed 's/#.*//' | sort -u)
done
echo "  完了"

echo "2. 機能IDの連番と重複"
mapfile -t ids < <(grep -o "^| F-[0-9][0-9]" docs/features.md | sed 's/^| F-//' | sort -n)
count=${#ids[@]}
uniq_count=$(printf '%s\n' "${ids[@]}" | sort -u | wc -l | tr -d ' ')
[ "$count" -gt 0 ] || note "機能一覧表から機能IDを1件も読み取れない"
[ "$count" = "$uniq_count" ] || note "機能IDが重複している（$count 行 / $uniq_count 種）"
last=$((10#${ids[-1]}))
[ "$count" = "$last" ] || note "機能IDに欠番がある（最大 F-$last / $count 件）"
echo "  完了（F-01 〜 F-$last、$count 件）"

echo "3. 件数表記の整合"
declared=$(grep -o "合計 [0-9]* 件" docs/features.md | head -1 | grep -o "[0-9]*")
[ "$declared" = "$count" ] || note "features.md の「合計 $declared 件」が実際の $count 件と一致しない"
grep -q "全 $count 件" README.md || note "README.md の件数表記が $count 件になっていない"
# tech-stack.md も件数を語る。ここが検査から漏れていたため「機能34件」が38件になっても放置された。
ts=$(grep -o "機能 *[0-9]* *件" docs/tech-stack.md | head -1 | grep -o "[0-9]*")
[ -n "$ts" ] || note "tech-stack.md から「機能N件」を読み取れない"
[ "$ts" = "$count" ] || note "tech-stack.md の「機能$ts 件」が実際の $count 件と一致しない"
echo "  完了"

# 「必ずテストを書く箇所」は3つの文書に同じ一覧が載る。ここがずれると
# 「どれを必ずテストするか」の合意そのものがずれる。件数だけでも機械的に突き合わせる。
echo "4. 「必ずテストを書く箇所」の項目数"
list_len() { # $1=ファイル $2=見出しの正規表現。見出しから次の見出しまでの箇条書きを数える
  awk -v h="$2" '$0 ~ h { in_block=1; next }
                 in_block && /^#/ { exit }
                 in_block && /^([0-9]+\.|- )/ { n++ }
                 END { print n+0 }' "$1"
}
req=$(list_len docs/requirements.md '^#+ 必ずテストを書く箇所')
rev=$(list_len REVIEW.md '^#+ テストが必須の箇所')
cla=$(list_len CLAUDE.md '^#+ 必ずテストを書く箇所')
[ "$req" -gt 0 ] || note "requirements.md から一覧を読み取れない"
[ "$req" = "$rev" ] || note "件数がずれている（requirements.md $req 件 / REVIEW.md $rev 件）"
[ "$req" = "$cla" ] || note "件数がずれている（requirements.md $req 件 / CLAUDE.md $cla 件）"
# 本文が「N項目である」と数を宣言している箇所も、一覧の実数と突き合わせる。
# 宣言は複数の文書にある。1つだけ検査すると、検査していない側を直し忘れて同じ見落としが再発する。
# 読み取れなかった場合は NG とする。黙って通すと、言い回しを変えた時点で検査が消える。
check_decl() { # $1=ファイル $2=宣言の正規表現 $3=一覧の実数
  local n
  n=$(grep -o "$2" "$1" | head -1 | grep -o "[0-9]*")
  [ -n "$n" ] || { note "$1 から「N項目」の宣言を読み取れない（言い回しが変わった可能性）"; return; }
  [ "$n" = "$3" ] || note "$1 の「$n 項目」が一覧の $3 件と一致しない"
}
check_decl docs/requirements.md "「必ずテストを書く箇所」の *[0-9]* *項目" "$req"
check_decl REVIEW.md "下記の *[0-9]* *項目" "$rev"
echo "  完了（$req 項目）"

if [ "$fail" -ne 0 ]; then echo "検査に失敗しました"; exit 1; fi
echo "すべての検査に合格しました"
