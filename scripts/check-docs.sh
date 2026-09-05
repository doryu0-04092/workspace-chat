#!/usr/bin/env bash
# ドキュメントの機械的な検査。
# 目的は「実行した事実を成果物に残すこと」であり、内容の正しさは人間とレビューが見る。
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
# 検査の対象範囲と、宣言から数を読み取る規則は check-docs.test.sh と共有する
# （scripts/doc-scope.sh）
# shellcheck source=scripts/doc-scope.sh
. scripts/doc-scope.sh

fail=0
note() { echo "  NG: $*"; fail=1; }

# git の追跡状態に依存しない。未コミットのファイルも検査対象にするため。
mapfile -t docs < <(doc_find -name '*.md' -print | sed 's|^\./||' | sort)
[ "${#docs[@]}" -gt 0 ] || { echo "NG: 検査対象の Markdown が1件も見つからない"; exit 1; }

echo "1. 相対リンクの検証（対象 ${#docs[@]} ファイル）"
for f in "${docs[@]}"; do
  d=$(dirname "$f")
  while IFS= read -r l; do
    [ -z "$l" ] && continue
    # 外部リンクはスキームで見分ける。先頭1文字で弾くと（かつての抽出パターン [^)h]）、
    # handbook/x.md のような h で始まる相対リンクまで黙って対象外になる。
    # 「相対リンクの検証、完了」と表示しながら見ていない範囲がある状態は、
    # リンク切れそのものより危うい。検査が通ったという誤った安心は自力で検出できない。
    # 列挙にないスキーム（ftp: など）は相対パスとして扱われ「存在しない」と鳴る。
    # 黙って飛ばすより、気づける形で落ちる側に倒す。
    case "$l" in http://*|https://*|mailto:*) continue ;; esac
    [ -e "$d/$l" ] || note "$f -> $l が存在しない"
    # 検査の対象外はリンク先にできない（doc-scope.sh の制約）。
    # ここで見ないと、本物のリポジトリでは通るのにテストの前提チェックだけが落ち、
    # 原因の切り分けに時間がかかる。制約を書くだけでは守られない。
    why=$(doc_excluded "$d/$l") && note "$f -> $l は検査の$why（リンク先にできない）"
  done < <(grep -o "](\([^)]*\))" "$f" | sed 's/](\(.*\))/\1/' | sed 's/#.*//' | sort -u)
done
echo "  完了"

echo "2. 機能IDの連番と重複"
mapfile -t ids < <(grep -o "^| F-[0-9][0-9]" docs/features.md | sed 's/^| F-//' | sort -n)
count=${#ids[@]}
if [ "$count" -eq 0 ]; then
  # 以降の検査はすべて機能数を土台にしている。ここで抜けないと ${ids[-1]} が
  # 未定義参照になり、set -u でスクリプトが途中で落ちて残りの指摘が出なくなる。
  note "機能一覧表から機能IDを1件も読み取れない"
  echo "  完了（0 件）"
else
  uniq_count=$(printf '%s\n' "${ids[@]}" | sort -u | wc -l | tr -d ' ')
  [ "$count" = "$uniq_count" ] || note "機能IDが重複している（$count 行 / $uniq_count 種）"
  last=$((10#${ids[-1]}))
  [ "$count" = "$last" ] || note "機能IDに欠番がある（最大 F-$last / $count 件）"
  echo "  完了（F-01 〜 F-$last、$count 件）"
fi

echo "3. 件数表記の整合"

# 宣言の読み取り（decls）は doc-scope.sh に置いてある。check-docs.test.sh の
# 「N通り」の突き合わせも同じ関数を呼ぶ。2箇所に書くと、片方の読み取りを直したときに
# もう片方が古い規則のまま残る。
# 0件なら NG。黙って通すと、言い回しを変えた時点で検査が落ちるのではなく消える。
compare_decls() { # $1=数の並び（改行区切り） $2=期待値 $3=宣言の呼び名
  # パイプで渡すと while がサブシェルで回り、note の fail=1 が親に伝わらない。
  # ヒアストリングで現在のシェルのまま回す。
  local found=0 v
  while IFS= read -r v; do
    [ -n "$v" ] || continue
    found=1
    [ "$v" = "$2" ] || note "$3: $v と書かれているが、実際は $2"
  done <<< "$1"
  [ "$found" = 1 ] || note "$3 を読み取れない（言い回しが変わった可能性）"
}

compare_decls "$(decls docs/features.md   '合計 [0-9][0-9]* 件')"     "$count" "features.md の「合計 N 件」"
compare_decls "$(decls README.md          '全 [0-9][0-9]* 件')"       "$count" "README.md の「全 N 件」"
# tech-stack.md も件数を語る。ここが検査から漏れていたため「機能34件」が38件になっても放置された。
compare_decls "$(decls docs/tech-stack.md '機能 *[0-9][0-9]* *件')"   "$count" "tech-stack.md の「機能N件」"

# 内訳も複数の文書に手書きで重複している。合計だけを見ていると、ある機能の区分が
# 「派生 → 提案・承認済」に変わったとき合計は動かず、内訳だけが黙ってずれる。
# 区分は表の4列目にあるため機械的に数えられる。
kind_count() { # $1=区分名。強調記号と空白を落として4列目と突き合わせる
  awk -F'|' -v kind="$1" '/^\| F-[0-9][0-9] \|/ { k=$5; gsub(/[* ]/, "", k); if (k == kind) n++ }
                          END { print n+0 }' docs/features.md
}
# requirements.md 3.1〜3.3 も同じ数を「全N件」と宣言する。区分名を伴わない書き方のため
# 上の grep では拾えない。節を特定して読む。節の見出しが変われば読み取りに失敗して NG になる。
sec_decls() { # $1=節の見出しの正規表現。その節に現れる「全N件」の数をすべて返す
  # 終端は「#### 以外のあらゆる見出し」とする。^### だけで抜けると、次の見出しが ## だった場合に
  # 章をまたいで読み進み、節の外の数字を正しく読めたかのように返す。読み取り失敗より気づきにくい。
  # ubuntu-latest の既定 awk は mawk のため、^#{1,3} のような区間表現は使わない。
  awk -v h="$1" '$0 ~ h { in_sec=1; next }
                 in_sec && /^#/ && $0 !~ /^#### / { exit }
                 in_sec { print }' docs/requirements.md \
    | decls_in "全 *[0-9][0-9]* *件"
}
sum=0
for kind in 要求 派生 提案・承認済; do
  n=$(kind_count "$kind")
  sum=$((sum + n))
  [ "$n" -gt 0 ] || note "features.md の表から区分「$kind」の行を1件も読み取れない"

  compare_decls "$(decls docs/features.md "$kind [0-9][0-9]* 件")" "$n" "features.md の内訳「$kind」"
  compare_decls "$(decls README.md        "$kind [0-9][0-9]*")"    "$n" "README.md の内訳「$kind」"

  # 見出しは awk の動的正規表現に渡すため、ドットはエスケープしない（警告になるうえ、
  # ここでは任意の1文字に一致しても見出し文字列が十分に具体的で誤検出しない）。
  case "$kind" in
    要求)         sec='^### 3.1 顧客要求に基づく機能' ;;
    派生)         sec='^### 3.2 要求の実現に必要となる派生機能' ;;
    提案・承認済) sec='^### 3.3 提案し、承認を得て実装した機能' ;;
  esac
  compare_decls "$(sec_decls "$sec")" "$n" "requirements.md の「$kind」の節の「全N件」"
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
# 宣言の照合は3章の compare_decls に寄せる。同じ欠陥（先頭1件だけを見る）を
# 1箇所だけ直して他に残す、という事態を避けるため、読み取りの経路は1つにする。
# パターンは宣言の行にしか無い後続語まで含めて一意にする。
compare_decls "$(decls docs/requirements.md "「必ずテストを書く箇所」の *[0-9][0-9]* *項目")" "$req" "requirements.md の「N項目」の宣言"
compare_decls "$(decls REVIEW.md "下記の *[0-9][0-9]* *項目に該当する変更")"                  "$rev" "REVIEW.md の「N項目」の宣言"
echo "  完了（$req 項目）"

# 「N経路」「N種類」も同じ形の宣言である。どちらも実体は表であり、機械的に数えられる。
# 経路は REVIEW.md 2.1 が最優先とする箇所で、1つ欠けたまま実装されると認可の穴になる。
# 実際、requirements.md が「3経路」と書いて WebSocket の配信が抜けていた
# （PR #6 で文言は直したが、検査は入れていなかった）。
echo "5. 「N経路」と「N種類」の宣言"

# 経路の実体は REVIEW.md 2.1 の表である。行は「| 1 |」で始まり、2列目が経路の名前。
# ここは awk のリテラル正規表現なのでドットをエスケープする。しないと「### 2-1 認可」でも
# 一致してしまい、見出しが変わったのに読み取れたことになる（検査の検査が実際に踏んだ）。
#
# **読み取りは1箇所だけに置く。** 数と名前を別々の awk で取ると、節の特定（^### 2\.1 ）と
# 行の判定（^\| [0-9]+ \|）を二重に持つことになる。上のエスケープ漏れは、実際に
# 両方へ同じ修正を入れる必要があった（doc-scope.sh 冒頭・検査3と同じ理由）。
#
# 帰結は件数の不一致ではなく **NG の原因の取り違え**である。名前側だけが空になると
# routes は正のままで下の読み取り失敗の分岐に落ちず、
# 「表と requirements.md で経路の名前が違う（表: ）」が出る。
# 受け取った側は、壊れていない requirements.md の列挙を疑うことになる。
route_names=$(awk -F'|' '$0 ~ /^### 2\.1 / { in_sec = 1; next }
                         in_sec && /^#/ { exit }
                         in_sec && /^\| [0-9]+ \|/ {
                           r = $3; gsub(/\*/, "", r); gsub(/^ +| +$/, "", r); print r }' REVIEW.md)
routes=$(printf '%s\n' "$route_names" | grep -c .)
if [ "$routes" -eq 0 ]; then
  # 以降の照合はすべてこの数を土台にしている。0 のまま進むと、
  # 宣言側が何を書いていても「実際は 0」と鳴るだけで、読み取り失敗が埋もれる。
  note "REVIEW.md 2.1 の表から経路を1件も読み取れない"
else
  # 「N経路」は数字の直後の語が場所ごとに違う。requirements.md の「残る2経路」は
  # 4のうち2という別の数であり、まとめて拾うと正しい記述が NG になる。
  # 宣言の行にしか無い後続語まで含めて一意にする（検査4と同じ方針）。
  # requirements.md は強調記号が数字と後続語の間に入る（4経路**すべてを塞いで）ため \** を挟む。
  compare_decls "$(decls REVIEW.md          '[0-9][0-9]*経路すべてを塞ぐ')"       "$routes" "REVIEW.md の「N経路すべてを塞ぐ」"
  compare_decls "$(decls REVIEW.md          '経路は[0-9][0-9]*つある')"           "$routes" "REVIEW.md の「経路はNつある」"
  compare_decls "$(decls docs/requirements.md '[0-9][0-9]*経路\**すべてを塞いで')" "$routes" "requirements.md の「N経路すべてを塞いで」"
  compare_decls "$(decls docs/requirements.md '[0-9][0-9]*経路のうち')"            "$routes" "requirements.md の「N経路のうち」"
  # 同じ数はレビュー用ワークフローの prompt にも直書きされている。文書ではないが、
  # ここだけ配線しないと帰結が文書の不整合より重い。経路が増減したとき、
  # **AI レビュアーが誤った経路数を最優先の観点として渡され続ける**（REVIEW.md 2.1 そのもの）。
  # .github 配下でも doc_find の除外には当たらず、検査の検査の複製ループにも入る。
  compare_decls "$(decls .github/workflows/claude_code_review.yml '認可[0-9][0-9]*経路を最優先')" \
    "$routes" "claude_code_review.yml の「認可N経路」"

  # 数だけでは足りない。4のまま1つが別物に差し替わっても気づけない。
  # REVIEW.md 2.1 は本ファイルが最優先と定めた箇所であり、経路が差し替わることは
  # 欠けることと影響が同じである（塞ぐ対象の合意がずれる）。イベント表と同じく中身で見る。
  #
  # requirements.md 側は1行に4つ並ぶ。行を特定し、「/」で分割して集合として突き合わせる。
  #
  # 包含（grep -qF）で見てはいけない。「検索」は「全文検索」に含まれるため、
  # 列挙側を 検索 → 全文検索 に書き換えても素通りする（検査の検査が実際に踏んだ）。
  # 集合で見れば、名前の差し替え・増減のどちらも検出できる。
  # 行を読み取れない場合は NG（消えるのではなく鳴らす）。
  #
  # 一致する行は grep -m1 で先頭1件に絞らない。前方に同じ言い回しで正しい4名を並べた
  # 要約行が現れると、検査対象が黙ってそちらに移り、本命が差し替わったまま無検査で通る。
  # decls が「head -1 で先頭1件だけを見ない」としているのと同じ理由である。すべて照合する。
  mapfile -t route_lines < <(grep '[0-9][0-9]*経路\**すべてを塞いで' docs/requirements.md)
  if [ "${#route_lines[@]}" -eq 0 ]; then
    note "requirements.md の経路を列挙している行を読み取れない"
  else
    rev_sorted=$(printf '%s\n' "$route_names" | sort | paste -sd'/' -)
    for route_line in "${route_lines[@]}"; do
      # 「> **一覧・取得 API / … / WebSocket の配信の4経路**すべてを塞いで」から列挙だけを取る。
      req_routes=$(printf '%s\n' "$route_line" \
        | sed 's/^> *//; s/^\*\*//; s/の[0-9][0-9]*経路.*//' \
        | tr '/' '\n' | sed 's/^ *//; s/ *$//')
      req_sorted=$(printf '%s\n' "$req_routes" | sort | paste -sd'/' -)
      [ "$rev_sorted" = "$req_sorted" ] ||
        note "REVIEW.md 2.1 の表と requirements.md で経路の名前が違う（表: $rev_sorted / 列挙: $req_sorted）"
    done
  fi
fi

# リアルタイム配信のイベント表は requirements.md と features.md に重複している。
# 表を1つに寄せる案もあるが、どちらの文書も単独で読まれる前提であり、
# 内容欄の参照先も違う（提-3 と F-34）。2つのまま、イベント名の列で突き合わせる。
events() { # $1=ファイル $2=見出しの正規表現。イベント表の1列目を返す
  awk -F'|' -v h="$2" '$0 ~ h { in_sec = 1; next }
                       in_sec && /^#/ { exit }
                       in_sec && /^\| `/ { e = $2; gsub(/^ +| +$/, "", e); print e }' "$1"
}
req_events=$(events docs/requirements.md '^#+ リアルタイム配信の対象イベント')
fea_events=$(events docs/features.md     '^#+ 5.1 配信するイベント')
kinds=$(printf '%s\n' "$req_events" | grep -c .)
# 読み取り失敗は両側で見る。features.md 側にこれが無いと、その見出しを変えたときに
# 出る NG が「イベント表の内容が違う」だけになり、受け取った側は表の中身を
# 突き合わせに行く。実際に違うのは見出しである（原因を取り違えた NG になる）。
fea_kinds=$(printf '%s\n' "$fea_events" | grep -c .)
[ "$fea_kinds" -gt 0 ] || note "features.md からイベント表を読み取れない"
if [ "$kinds" -eq 0 ]; then
  note "requirements.md からイベント表を読み取れない"
else
  # 数ではなく中身で突き合わせる。7種類のまま1つだけ差し替えられても数では気づけない
  # （検査4と同じ理由）。守りたいのは「どのイベントを配信するか」の合意である。
  [ "$req_events" = "$fea_events" ] || note "requirements.md と features.md でイベント表の内容が違う"
  # 宣言は4つの文書・6箇所にある。1つだけ検査すると、検査していない側を直し忘れて
  # 同じ見落としが再発する。パターンは経路と同じく場所ごとに分ける
  # （宣言の行にしか無い後続語まで含めて一意にする）。総称の [0-9][0-9]*種類 を
  # 4文書へ一律に当てると、イベントと無関係な「N種類」が1つ入った時点で
  # 正しい記述が NG になる。アップロードの許可形式やロールの説明は同じ文書にあり、
  # 書かれうる場所である。同じ検査の中に方針が2つあると、次に触る人が寄せ先を判断できない。
  #
  # requirements.md の宣言は「（4.1 の7種類）は、フロントエンドと…」である。
  # 節番号を含めると decls が 4 と 1 も数として返すため、節番号ではなく後続語で一意にする。
  # 「の N 種類）」だけだと固有の語を1つも含まず、その文書内では総称パターンになる
  # （4.4 の許可形式やロールの説明に「（下表の5種類）」が入ると偽の NG が出る）。
  compare_decls "$(decls CLAUDE.md            'イベント定義（[0-9][0-9]*種類）')"      "$kinds" "CLAUDE.md の「イベント定義（N種類）」"
  compare_decls "$(decls docs/requirements.md 'の[0-9][0-9]*種類）は、フロントエンド')" "$kinds" "requirements.md の「4.1 のN種類」"
  compare_decls "$(decls docs/features.md     '[0-9][0-9]*種類のイベントを配信')"       "$kinds" "features.md の「N種類のイベントを配信」"
  compare_decls "$(decls docs/features.md     'この[0-9][0-9]*種類以外')"               "$kinds" "features.md の「このN種類以外」"
  compare_decls "$(decls docs/tech-stack.md   '[0-9][0-9]*種類の WebSocket イベント')"  "$kinds" "tech-stack.md の「N種類の WebSocket イベント」"
  compare_decls "$(decls docs/tech-stack.md   '[0-9][0-9]*種類のイベント定義')"         "$kinds" "tech-stack.md の「N種類のイベント定義」"
fi
echo "  完了（$routes 経路 / $kinds 種類）"

if [ "$fail" -ne 0 ]; then echo "検査に失敗しました"; exit 1; fi
echo "すべての検査に合格しました"
