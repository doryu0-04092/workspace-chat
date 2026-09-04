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
ts=$(grep -o "機能 *[0-9][0-9]* *件" docs/tech-stack.md | head -1 | grep -o "[0-9]*")
[ -n "$ts" ] || note "tech-stack.md から「機能N件」を読み取れない"
[ "$ts" = "$count" ] || note "tech-stack.md の「機能$ts 件」が実際の $count 件と一致しない"

# 内訳も2文書に手書きで重複している。合計だけを見ていると、ある機能の区分が
# 「派生 → 提案・承認済」に変わったとき合計は動かず、内訳だけが黙ってずれる。
# 区分は表の4列目にあるため機械的に数えられる。
kind_count() { # $1=区分名。強調記号と空白を落として4列目と突き合わせる
  awk -F'|' -v kind="$1" '/^\| F-[0-9][0-9] \|/ { k=$5; gsub(/[* ]/, "", k); if (k == kind) n++ }
                          END { print n+0 }' docs/features.md
}
# requirements.md 3.1〜3.3 も同じ数を「全N件」と宣言する。区分名を伴わない書き方のため
# 上の grep では拾えない。節を特定して読む。節の見出しが変われば読み取りに失敗して NG になる。
sec_decl() { # $1=節の見出しの正規表現。その節に現れる最初の「全N件」を返す
  # 終端は「#### 以外のあらゆる見出し」とする。^### だけで抜けると、次の見出しが ## だった場合に
  # 章をまたいで読み進み、節の外の数字を正しく読めたかのように返す。読み取り失敗より気づきにくい。
  # ubuntu-latest の既定 awk は mawk のため、^#{1,3} のような区間表現は使わない。
  awk -v h="$1" '$0 ~ h { in_sec=1; next }
                 in_sec && /^#/ && $0 !~ /^#### / { exit }
                 in_sec { print }' docs/requirements.md \
    | grep -o "全 *[0-9][0-9]* *件" | head -1 | grep -o "[0-9]*"
}
sum=0
for kind in 要求 派生 提案・承認済; do
  n=$(kind_count "$kind")
  sum=$((sum + n))
  [ "$n" -gt 0 ] || note "features.md の表から区分「$kind」の行を1件も読み取れない"
  fd=$(grep -o "$kind [0-9][0-9]* 件" docs/features.md | head -1 | grep -o "[0-9]*")
  if [ -z "$fd" ]; then note "features.md から「$kind N 件」の内訳を読み取れない"
  elif [ "$fd" != "$n" ]; then note "features.md の内訳「$kind $fd 件」が実際の $n 件と一致しない"; fi

  rd=$(grep -o "$kind [0-9][0-9]*" README.md | head -1 | grep -o "[0-9]*")
  if [ -z "$rd" ]; then note "README.md から「$kind N」の内訳を読み取れない"
  elif [ "$rd" != "$n" ]; then note "README.md の内訳「$kind $rd」が実際の $n 件と一致しない"; fi

  # 見出しは awk の動的正規表現に渡すため、ドットはエスケープしない（警告になるうえ、
  # ここでは任意の1文字に一致しても見出し文字列が十分に具体的で誤検出しない）。
  case "$kind" in
    要求)         sec='^### 3.1 顧客要求に基づく機能' ;;
    派生)         sec='^### 3.2 要求の実現に必要となる派生機能' ;;
    提案・承認済) sec='^### 3.3 提案し、承認を得て実装した機能' ;;
  esac
  qd=$(sec_decl "$sec")
  if [ -z "$qd" ]; then note "requirements.md の「$kind」の節から「全N件」を読み取れない（節の見出しが変わった可能性）"
  elif [ "$qd" != "$n" ]; then note "requirements.md の「$kind」の節の「全$qd 件」が実際の $n 件と一致しない"; fi
done
[ "$sum" = "$count" ] || note "内訳の合計 $sum 件が機能数 $count 件と一致しない（区分の表記ゆれの可能性）"
echo "  完了（合計 $count 件 / 内訳の合計 $sum 件）"

# 「必ずテストを書く箇所」は3つの文書に同じ一覧が載る。ここがずれると
# 「どれを必ずテストするか」の合意そのものがずれる。
echo "4. 「必ずテストを書く箇所」の一覧"
items() { # $1=ファイル $2=見出しの正規表現。箇条書きの記号と強調を落として本文だけ返す
  awk -v h="$2" '$0 ~ h { in_block=1; next }
                 in_block && /^#/ { exit }
                 in_block && /^([0-9]+\.|- )/ { print }' "$1" \
    | sed 's/^[0-9]*\. *//; s/^- *//; s/\*\*//g'
}
req_items=$(items docs/requirements.md '^#+ 必ずテストを書く箇所')
rev_items=$(items REVIEW.md '^#+ テストが必須の箇所')
cla_items=$(items CLAUDE.md '^#+ 必ずテストを書く箇所')
req=$(printf '%s\n' "$req_items" | grep -c .)
rev=$(printf '%s\n' "$rev_items" | grep -c .)
[ "$req" -gt 0 ] || note "requirements.md から一覧を読み取れない"
# 件数ではなく本文で突き合わせる。守りたいのは「どれを必ずテストするか」の合意であり、
# 件数の一致はその代理指標にすぎない。8件のまま1項目だけ書き換えられても件数では気づけない。
[ "$req_items" = "$rev_items" ] || note "requirements.md と REVIEW.md で一覧の内容が違う"
[ "$req_items" = "$cla_items" ] || note "requirements.md と CLAUDE.md で一覧の内容が違う"
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
