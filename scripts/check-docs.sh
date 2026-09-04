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
echo "  完了"

if [ "$fail" -ne 0 ]; then echo "検査に失敗しました"; exit 1; fi
echo "すべての検査に合格しました"
