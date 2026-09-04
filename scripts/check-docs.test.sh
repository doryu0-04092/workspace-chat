#!/usr/bin/env bash
# check-docs.sh が「壊れたときに落ちる」ことを確かめる。
#
# なぜ要るか。check-docs.sh は文書の不整合を検出する実装であり、それ自体には
# これまで検査が無かった。CI が実行していたのは正常系の1回だけで、
# 「検査が落ちるべきときに落ちる」ことは保証されていなかった。
# 実際、sec_decl の「章をまたいで節外の数字を読む」欠陥は、手作業の確認を
# 一度すり抜けている。手で壊す確認は再現できる形で残らないと同じことが起きる。
#
# 方針: 文書一式を一時ディレクトリに複製し、1箇所ずつ壊して exit 1 になることを見る。
# 元のリポジトリは書き換えない。
set -uo pipefail
cd "$(dirname "$0")/.."
repo=$(pwd)

fail=0
work=$(mktemp -d)
# 後片付けはしない。CI のランナーは実行のたびに作り直され、手元では TMPDIR に残るだけで
# 害が無い。プロジェクトの禁止事項により rm -rf は使わない。
echo "作業ディレクトリ: $work"

# check-docs.sh は相対リンクを検査するため、リンク先になるファイルも複製する。
# ここが欠けると検査1が常に失敗し、どの壊し方でも「落ちた」ことになって検査にならない。
mkdir -p "$work/docs" "$work/scripts" "$work/.github/workflows"
cp "$repo"/*.md                        "$work/"
cp "$repo"/docs/*.md                   "$work/docs/"
cp "$repo"/scripts/check-docs.sh       "$work/scripts/"
cp "$repo"/.github/workflows/*.yml     "$work/.github/workflows/"

run_check() { (cd "$work" && bash scripts/check-docs.sh >/dev/null 2>&1); }
restore()   { cp "$repo/$1" "$work/$1"; }

# --- 前提: 壊す前は通ること -------------------------------------------------
# これが通らないと、以降の「落ちた」は壊したせいではなく複製の不備によるものになる。
echo "0. 複製した状態で検査が通ること"
if run_check; then
  echo "  OK"
else
  echo "  NG: 壊す前から検査が落ちている。この結果は信用できない"
  (cd "$work" && bash scripts/check-docs.sh 2>&1 | sed 's/^/      /')
  exit 1
fi

# --- 壊したら落ちること -----------------------------------------------------
# 終了コードだけを見ると足りない。壊し方によっては、検査が「正しい理由」で落ちたのか
# 「別の理由」で落ちたのかを区別できない。実例: sec_decl が章をまたいで節外の数字を
# 読んでいたとき、読み取り失敗ではなく「全99 件が実際の 10 件と一致しない」で落ちるため、
# 終了コードだけを見る検査ではこの欠陥を素通りする（実際に素通りさせた）。
# 期待する指摘の文言まで突き合わせる。
n=0
expect_ng() { # $1=説明 $2=対象ファイル $3=sed 式 $4=NG に含まれるべき文言
  local out rc
  n=$((n + 1))
  restore "$2"
  sed -i "$3" "$work/$2"
  out=$(cd "$work" && bash scripts/check-docs.sh 2>&1); rc=$?
  if [ "$rc" -eq 0 ]; then
    echo "  NG: $n. $1 — 壊しても検査が通ってしまった"
    fail=1
  elif ! printf '%s\n' "$out" | grep -q "$4"; then
    echo "  NG: $n. $1 — 落ちたが、期待した指摘「$4」が出ていない"
    printf '%s\n' "$out" | grep '^  NG' | sed 's/^/        実際: /'
    fail=1
  else
    echo "  OK: $n. $1"
  fi
  restore "$2"
}

echo "1. 壊したときに落ちること"

# 検査1: 相対リンク
expect_ng "README のリンク先を存在しないファイルに" README.md \
  's|(docs/requirements.md)|(docs/nonexistent.md)|' 'README.md -> docs/nonexistent.md が存在しない'

# 検査2: 機能IDの連番
expect_ng "features.md から F-20 の行を削除して欠番を作る" docs/features.md \
  '/^| F-20 |/d' '機能IDに欠番がある'

# 検査3a: 総数
expect_ng "tech-stack.md の「機能38件」を34件に" docs/tech-stack.md \
  's/機能38件/機能34件/' 'tech-stack.md の「機能34 件」'

# 検査3b: 内訳
expect_ng "features.md の内訳を「要求 18 件」に" docs/features.md \
  's/内訳: 要求 19 件/内訳: 要求 18 件/' 'features.md の内訳「要求 18 件」'
expect_ng "README.md の内訳を「要求 18」に" README.md \
  's/（要求 19 \/ 派生 9/（要求 18 \/ 派生 9/' 'README.md の内訳「要求 18」'
expect_ng "F-01 の区分を 要求→派生 に（合計は 38 のまま動かない）" docs/features.md \
  's/^\(| F-01 |[^|]*|[^|]*\)| 要求 |/\1| **派生** |/' 'features.md の内訳「要求 19 件」が実際の 18 件と一致しない'
expect_ng "requirements.md 3.1 の「全19件」を18件に" docs/requirements.md \
  's/課題文に明記された機能。全19件。/課題文に明記された機能。全18件。/' '「要求」の節の「全18 件」'
expect_ng "requirements.md 3.2 の節見出しを変えて読み取れなくする" docs/requirements.md \
  's/^### 3\.2 要求の実現に必要となる派生機能$/### 3.2 派生機能/' '「派生」の節から「全N件」を読み取れない'
expect_ng "3.4・3.5 の見出しレベルを下げ、章をまたいだ先に「全99件」を置く" docs/requirements.md \
  's/^### 3\.4 /#### 3.4 /; s/^### 3\.5 /#### 3.5 /; s/^全10件。\*\*提-1/**提-1/; s/^## 4\. 非機能要件$/## 4. 非機能要件\n\n全99件。/' '「提案・承認済」の節から「全N件」を読み取れない'

# 検査4a: 一覧の本文
expect_ng "REVIEW.md の一覧の1項目だけ本文を書き換え（8件のまま）" REVIEW.md \
  's/^4\. \*\*WebSocket が許可外の Origin からのハンドシェイクを拒否すること\*\*$/4. **WebSocket の接続数に上限があること**/' 'requirements.md と REVIEW.md で一覧の内容が違う'
expect_ng "CLAUDE.md の一覧の1項目だけ本文を書き換え（8件のまま）" CLAUDE.md \
  's/^- \*\*メンバーがオーナー専用の操作を実行できないこと\*\*$/- **メンバーが招待できないこと**/' 'requirements.md と CLAUDE.md で一覧の内容が違う'

# 検査4b: 本文の宣言
expect_ng "requirements.md の「8項目」を7項目に" docs/requirements.md \
  's/「必ずテストを書く箇所」の8項目/「必ずテストを書く箇所」の7項目/' 'docs/requirements.md の「7 項目」'
expect_ng "REVIEW.md の「下記の8項目」を7項目に" REVIEW.md \
  's/下記の8項目に該当する変更/下記の7項目に該当する変更/' 'REVIEW.md の「7 項目」'
expect_ng "REVIEW.md の宣言の言い回しを変えて読み取れなくする" REVIEW.md \
  's/下記の8項目に該当する変更/下記の一覧に該当する変更/' 'REVIEW.md から「N項目」の宣言を読み取れない'
# 先頭に正しい数のおとりを置き、本命だけを壊す。check_decl が先頭1件しか見ていないと
# おとりを読んで通ってしまう。「すべての宣言を照合する」ことを検証するための場合分け。
expect_ng "REVIEW.md の前方に正しい数のおとりを置き、本命だけ7項目に" REVIEW.md \
  's/^## 1\. 重大度の定義$/## 1. 重大度の定義\n\n下記の8項目に該当する変更（検査の検査が置いたおとり）\n/; s/下記の8項目に該当する変更で、テストが無い場合/下記の7項目に該当する変更で、テストが無い場合/' 'REVIEW.md の「7 項目」'

if [ "$fail" -ne 0 ]; then echo "検査の検査に失敗しました"; exit 1; fi
echo "$n 通りすべてで、壊すと検査が落ちることを確認しました"
