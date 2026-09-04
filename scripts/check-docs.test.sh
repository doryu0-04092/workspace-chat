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
# 対象範囲の定義は check-docs.sh と共有する
. scripts/doc-scope.sh
repo=$(pwd)

fail=0
work=$(mktemp -d)
# 後片付けはしない。CI のランナーは実行のたびに作り直され、手元では TMPDIR に残るだけで
# 害が無い。プロジェクトの禁止事項により rm -rf は使わない。
echo "作業ディレクトリ: $work"

# check-docs.sh は相対リンクを検査するため、リンク先になるファイルも複製する。
# ここが欠けると検査1が常に失敗し、どの壊し方でも「落ちた」ことになって検査にならない。
# 複製するファイルは列挙しない。check-docs.sh は find でその場の Markdown をすべて
# 対象にするため、列挙で書くと docs/ の下に階層を切った瞬間に複製から漏れる。
# 漏れても失敗にはならず、検査がその文書を見ないだけで全ケースが緑のまま通る。
# 「本物の検査が見ている範囲」と「テストが検査させている範囲」が黙ってずれる。
while IFS= read -r p; do
  mkdir -p "$work/$(dirname "$p")"
  cp "$repo/$p" "$work/$p"
done < <(cd "$repo" && doc_find -type f -print | sed 's|^\./||')

run_check() { (cd "$work" && bash scripts/check-docs.sh >/dev/null 2>&1); }
restore()   { cp "$repo/$1" "$work/$1"; }

# --- 前提: 除外の定義が効くこと ---------------------------------------------
# リポジトリに node_modules や .env がまだ無いため、実物では「除外できている」ことを
# 確かめられない（何も無いので何も漏れない）。専用の木を作って doc_find だけを見る。
echo "0a. 除外の定義（doc_find）が効くこと"
probe=$(mktemp -d)
# 木を作る一覧は DOC_PRUNE_DIRS から導出しない。導出すると、一覧から項目が消えたときに
# 木からも消え、検証が素通りする。ここに直接書く。
# ただし直接書くだけでは「足したのに効いていない」（綴り間違い等）を検出できないため、
# 木を作る前に集合として一致することを確かめる。
probe_dirs=(.git node_modules .pnp dist build .vite coverage .nyc_output
            playwright-report test-results blob-report generated uploads tmp
            .terraform .vscode .idea)
if [ "$(printf '%s\n' "${probe_dirs[@]}" | sort)" \
  != "$(printf '%s\n' "${DOC_PRUNE_DIRS[@]}" | sort)" ]; then
  echo "  NG: 0a の一覧と DOC_PRUNE_DIRS がずれている（除外を足したら、この一覧にも足す）"
  fail=1
fi
for d in "${probe_dirs[@]}"; do
  mkdir -p "$probe/$d" && : > "$probe/$d/x.md"
done
mkdir -p "$probe/apps/api/node_modules" && : > "$probe/apps/api/node_modules/x.md"
: > "$probe/.env"
: > "$probe/.env.local"
: > "$probe/keep.md"
: > "$probe/.env.example"   # .gitignore が追跡対象に戻しているため、除外してはいけない
got=$( (cd "$probe" && doc_find -type f -print) | sed 's|^\./||' | sort | tr '\n' ' ')
if [ "$got" = ".env.example keep.md " ]; then
  echo "  OK（keep.md と .env.example だけが残る）"
else
  echo "  NG: 除外の範囲が想定と違う → $got"
  fail=1
fi

# --- 前提: 検査対象が1件も無いときに落ちること -------------------------------
# この分岐だけがケース1〜26 のどれからも踏まれない。踏まないまま置くと、
# 検査が何も見ていない状態を「合格」と表示するようになっても気づけない。
echo "0b. Markdown が1件も無いときに落ちること"
bare=$(mktemp -d)
mkdir -p "$bare/scripts"
cp "$repo"/scripts/*.sh "$bare/scripts/"
bare_out=$( (cd "$bare" && bash scripts/check-docs.sh 2>&1) ) && bare_rc=0 || bare_rc=$?
if [ "$bare_rc" -ne 0 ] && printf '%s\n' "$bare_out" | grep -q "検査対象の Markdown が1件も見つからない"; then
  echo "  OK"
else
  echo "  NG: Markdown が無くても落ちない、または期待した指摘が出ない"
  printf '%s\n' "$bare_out" | sed 's/^/        実際: /'
  fail=1
fi

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
expect_ng() { # $1=説明 $2=対象ファイル $3=sed 式 $4=NG に含まれるべき文言 $5...=壊した後のファイルに要る文字列
  local desc="$1" file="$2" script="$3" expect="$4"
  shift 4
  local out rc pat
  n=$((n + 1))
  restore "$file"
  sed -i "$script" "$work/$file"
  # sed が空振りしていないか見る。cmp は「どれか1つでも当たれば」差分ありと判定するため、
  # 式を複数持つケースでは残りが空振りしても通ってしまう。そうなるとケースは静かに
  # 別のケースへ退化し、検出したかった経路が緑のまま消える。
  # 複数式のケースには、式ごとの結果を必須文字列として渡して個別に確かめる。
  if cmp -s "$repo/$file" "$work/$file"; then
    echo "  NG: $n. $desc — sed が空振りしてファイルが変わっていない"
    fail=1; restore "$file"; return
  fi
  for pat in "$@"; do
    if ! grep -q "$pat" "$work/$file"; then
      echo "  NG: $n. $desc — 壊した後のファイルに「$pat」が入っていない"
      fail=1; restore "$file"; return
    fi
  done
  out=$(cd "$work" && bash scripts/check-docs.sh 2>&1); rc=$?
  if [ "$rc" -eq 0 ]; then
    echo "  NG: $n. $desc — 壊しても検査が通ってしまった"
    fail=1
  elif ! printf '%s\n' "$out" | grep -q "$expect"; then
    echo "  NG: $n. $desc — 落ちたが、期待した指摘「$expect」が出ていない"
    printf '%s\n' "$out" | grep '^  NG' | sed 's/^/        実際: /'
    fail=1
  else
    echo "  OK: $n. $desc"
  fi
  restore "$file"
}

echo "1. 壊したときに落ちること"

# --- 検査1: 相対リンク
expect_ng "README のリンク先を存在しないファイルに" README.md \
  's|(docs/requirements.md)|(docs/nonexistent.md)|' 'README.md -> docs/nonexistent.md が存在しない'

# --- 検査2: 機能IDの連番と重複
expect_ng "features.md から F-20 の行を削除して欠番を作る" docs/features.md \
  '/^| F-20 |/d' '機能IDに欠番がある'
expect_ng "F-38 の ID を F-37 に書き換えて重複を作る" docs/features.md \
  's/^| F-38 |/| F-37 |/' '機能IDが重複している'

# --- 検査3: 総数
expect_ng "features.md の「合計 38 件」を37件に" docs/features.md \
  's/\*\*合計 38 件。\*\*/**合計 37 件。**/' 'features.md の「合計 N 件」: 37 と書かれているが、実際は 38'
expect_ng "README.md の「全 38 件」を37件に" README.md \
  's/\*\*全 38 件\*\*/**全 37 件**/' 'README.md の「全 N 件」: 37 と書かれているが、実際は 38'
expect_ng "tech-stack.md の「機能38件」を34件に" docs/tech-stack.md \
  's/機能38件/機能34件/' 'tech-stack.md の「機能N件」: 34 と書かれているが、実際は 38'
# 前方に正しい数のおとりを置き、本命だけを壊す。先頭1件しか見ていないと素通りする。
expect_ng "tech-stack.md の前方におとりを置き、本命だけ34件に" docs/tech-stack.md \
  's/^## 選定の前提$/## 選定の前提\n\n（検査の検査が置いたおとり）機能38件\n/; s/機能38件、うちリアルタイム/機能34件、うちリアルタイム/' \
  'tech-stack.md の「機能N件」: 34 と書かれているが、実際は 38' '検査の検査が置いたおとり' '機能34件、うちリアルタイム'

# --- 検査3: 内訳
expect_ng "features.md の内訳を「要求 18 件」に" docs/features.md \
  's/内訳: 要求 19 件/内訳: 要求 18 件/' 'features.md の内訳「要求」: 18 と書かれているが、実際は 19'
expect_ng "features.md の前方におとりを置き、本命の内訳だけ18件に" docs/features.md \
  's/^## 機能一覧表$/## 機能一覧表\n\n（検査の検査が置いたおとり）要求 19 件\n/; s/内訳: 要求 19 件/内訳: 要求 18 件/' \
  'features.md の内訳「要求」: 18 と書かれているが、実際は 19' '検査の検査が置いたおとり' '内訳: 要求 18 件'
expect_ng "README.md の内訳を「要求 18」に" README.md \
  's/（要求 19 \/ 派生 9/（要求 18 \/ 派生 9/' 'README.md の内訳「要求」: 18 と書かれているが、実際は 19'
expect_ng "F-01 の区分を 要求→派生 に（合計は 38 のまま動かない）" docs/features.md \
  's/^\(| F-01 |[^|]*|[^|]*\)| 要求 |/\1| **派生** |/' 'features.md の内訳「要求」: 19 と書かれているが、実際は 18'
expect_ng "requirements.md 3.1 の「全19件」を18件に" docs/requirements.md \
  's/課題文に明記された機能。全19件。/課題文に明記された機能。全18件。/' 'requirements.md の「要求」の節の「全N件」: 18 と書かれているが、実際は 19'
expect_ng "requirements.md 3.2 の節見出しを変えて読み取れなくする" docs/requirements.md \
  's/^### 3\.2 要求の実現に必要となる派生機能$/### 3.2 派生機能/' 'requirements.md の「派生」の節の「全N件」 を読み取れない'
expect_ng "3.4・3.5 の見出しレベルを下げ、章をまたいだ先に「全99件」を置く" docs/requirements.md \
  's/^### 3\.4 /#### 3.4 /; s/^### 3\.5 /#### 3.5 /; s/^全10件。\*\*提-1/**提-1/; s/^## 4\. 非機能要件$/## 4. 非機能要件\n\n全99件。/' \
  'requirements.md の「提案・承認済」の節の「全N件」 を読み取れない' \
  '#### 3.4 ' '#### 3.5 ' '^\*\*提-1' '全99件。'

# --- 検査4: 一覧の本文
expect_ng "REVIEW.md の一覧の1項目だけ本文を書き換え（8件のまま）" REVIEW.md \
  's/^4\. \*\*WebSocket が許可外の Origin からのハンドシェイクを拒否すること\*\*$/4. **WebSocket の接続数に上限があること**/' 'requirements.md と REVIEW.md で一覧の内容が違う'
expect_ng "CLAUDE.md の一覧の1項目だけ本文を書き換え（8件のまま）" CLAUDE.md \
  's/^- \*\*メンバーがオーナー専用の操作を実行できないこと\*\*$/- **メンバーが招待できないこと**/' 'requirements.md と CLAUDE.md で一覧の内容が違う'

# --- 検査4: 本文の宣言
expect_ng "requirements.md の「8項目」を7項目に" docs/requirements.md \
  's/「必ずテストを書く箇所」の8項目/「必ずテストを書く箇所」の7項目/' 'requirements.md の「N項目」の宣言: 7 と書かれているが、実際は 8'
expect_ng "REVIEW.md の「下記の8項目」を7項目に" REVIEW.md \
  's/下記の8項目に該当する変更/下記の7項目に該当する変更/' 'REVIEW.md の「N項目」の宣言: 7 と書かれているが、実際は 8'
expect_ng "REVIEW.md の宣言の言い回しを変えて読み取れなくする" REVIEW.md \
  's/下記の8項目に該当する変更/下記の一覧に該当する変更/' 'REVIEW.md の「N項目」の宣言 を読み取れない'
expect_ng "REVIEW.md の前方に正しい数のおとりを置き、本命だけ7項目に" REVIEW.md \
  's/^## 1\. 重大度の定義$/## 1. 重大度の定義\n\n下記の8項目に該当する変更（検査の検査が置いたおとり）\n/; s/下記の8項目に該当する変更で、テストが無い場合/下記の7項目に該当する変更で、テストが無い場合/' \
  'REVIEW.md の「N項目」の宣言: 7 と書かれているが、実際は 8' '検査の検査が置いたおとり' '下記の7項目に該当する変更で、テストが無い場合'


# --- 検査が「1件も読み取れない」と言う経路。ここを踏まないと、
#     表の形が変わって検査が何も見なくなったときに気づけない。
expect_ng "features.md の 要求 の行をすべて別の区分名に書き換える" docs/features.md \
  's/^\(| F-[0-9][0-9] |[^|]*|[^|]*\)| 要求 |/\1| **要検討** |/' \
  'features.md の表から区分「要求」の行を1件も読み取れない'
expect_ng "F-01 の区分だけを未知の区分名にする（合計は 38 のまま動かない）" docs/features.md \
  's/^\(| F-01 |[^|]*|[^|]*\)| 要求 |/\1| **要検討** |/' \
  '内訳の合計 37 件が機能数 38 件と一致しない'
expect_ng "features.md の機能IDの接頭辞を F- から G- に変える" docs/features.md \
  's/^| F-\([0-9][0-9]\) |/| G-\1 |/' \
  '機能一覧表から機能IDを1件も読み取れない'
expect_ng "requirements.md の一覧の見出しを変えて読み取れなくする" docs/requirements.md \
  's/^#### 必ずテストを書く箇所$/#### 必ずテストを書く項目/' \
  'requirements.md から一覧を読み取れない'

# --- 除外されたディレクトリの中の Markdown は検査対象にならないこと。
#     ここが効かないと、依存パッケージの README のリンク切れで CI が落ちる。
expect_ok() { # $1=説明 $2=作るファイル $3=中身
  n=$((n + 1))
  mkdir -p "$work/$(dirname "$2")"
  printf '%s\n' "$3" > "$work/$2"
  if run_check; then
    echo "  OK: $n. $1"
  else
    echo "  NG: $n. $1 — 除外されるはずのファイルで検査が落ちた"
    (cd "$work" && bash scripts/check-docs.sh 2>&1 | grep '^  NG' | sed 's/^/        実際: /')
    fail=1
  fi
  rm -f "$work/$2"
}
expect_ok "node_modules の中のリンク切れは無視される" node_modules/pkg/README.md \
  '[壊れたリンク](./does-not-exist.md)'
expect_ok "入れ子の node_modules の中のリンク切れも無視される" apps/api/node_modules/pkg/README.md \
  '[壊れたリンク](./does-not-exist.md)'
if [ "$fail" -ne 0 ]; then echo "検査の検査に失敗しました"; exit 1; fi
echo "$n 通りの確認をすべて通過しました"
