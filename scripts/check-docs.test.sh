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
cd "$(dirname "$0")/.." || exit 1
# 検査の対象範囲と、宣言から数を読み取る規則は check-docs.sh と共有する
# shellcheck source=scripts/doc-scope.sh
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
            playwright-report test-results blob-report reports generated uploads tmp
            .terraform .vscode .idea)
probe_prune_files=('.env' '.env.*' '*.tfstate' '*.tfstate.*' '*.tfvars' '*.tfvars.json')
probe_keep_files=('.env.example')
# 現実に出てくる綴り。0a（木を作る）と 0c（.gitignore に問う）が同じものを見る。
# 導出（${g//\*/x}）は1パターンにつき代表1名しか作らないため、
# secrets.auto.tfvars.json のようなドットを複数含む綴りはこの一覧にしか依存しない。
# 0a と 0c で別々に書き写すと、片方に足したときもう片方が静かに狭くなる。
probe_real_names=(.env.local terraform.tfstate terraform.tfstate.backup
                  prod.tfvars terraform.tfvars.json secrets.auto.tfvars.json)
# 一致しては困る対（末尾一致であることの裏打ち）。
# *.tfvars / *.tfvars.json はいずれも末尾一致であり、例示ファイルには一致しない。
# この対を置かないと、末尾一致でない形へ崩しても 0a・0c が緑で通る。
probe_real_keeps=(prod.tfvars.example prod.tfvars.json.example)
# 先頭が - になるファイル名。名前の取り出しに basename を使うと option として
# 解釈され、名前が空になって一致しなくなる（実測: `basename "-x.tfvars"` は
# `unknown option -- x` を出して終了コード 1、標準出力は空）。
# 先頭が `*` のパターンからだけ作る。`.env` のように `*` で始まらないものは、
# 先頭に - を足すと本当にどのパターンにも一致せず、根拠の無い NG になる。
probe_dash_names=()
for g in "${probe_prune_files[@]}"; do
  case "$g" in '*'*) probe_dash_names+=("-${g//\*/x}") ;; esac
done
same() { # $1=期待の一覧名 $2...=比較する2組（改行区切り）
  [ "$2" = "$3" ] || { echo "  NG: 0a の一覧と $1 がずれている（除外を足したら、この一覧にも足す）"; fail=1; }
}
same DOC_PRUNE_DIRS \
  "$(printf '%s\n' "${probe_dirs[@]}"        | sort)" "$(printf '%s\n' "${DOC_PRUNE_DIRS[@]}"  | sort)"
same DOC_PRUNE_FILES \
  "$(printf '%s\n' "${probe_prune_files[@]}" | sort)" "$(printf '%s\n' "${DOC_PRUNE_FILES[@]}" | sort)"
same DOC_KEEP_FILES \
  "$(printf '%s\n' "${probe_keep_files[@]}"  | sort)" "$(printf '%s\n' "${DOC_KEEP_FILES[@]}"  | sort)"
for d in "${probe_dirs[@]}"; do
  mkdir -p "$probe/$d" && : > "$probe/$d/x.md"
done
mkdir -p "$probe/apps/api/node_modules" && : > "$probe/apps/api/node_modules/x.md"
# 除外されるはずのファイルは一覧から導出する（グロブの * を x に置き換える）。
# 手書きで並べると、一覧にパターンを足しても木にファイルが増えず、
# 「足したのに効いていない」が素通りする。ディレクトリ側と同じ水準にそろえる。
for g in "${probe_prune_files[@]}"; do : > "$probe/${g//\*/x}"; done
# 実際に出てくる名前でも当たることを見る（導出名だけだと現実の綴りを外しても気づけない）
for f in "${probe_real_names[@]}"; do : > "$probe/$f"; done
# 残るはずのもの（KEEP に一致するもの と、末尾一致のため一致しない例示ファイル）
for g in "${probe_keep_files[@]}"; do : > "$probe/${g//\*/x}"; done
for f in "${probe_real_keeps[@]}"; do : > "$probe/$f"; done
: > "$probe/keep.md"
expected=$(printf '%s\n' keep.md "${probe_real_keeps[@]}" "${probe_keep_files[@]//\*/x}" | sort | tr '\n' ' ')
got=$( (cd "$probe" && doc_find -type f -print) | sed 's|^\./||' | sort | tr '\n' ' ')
if [ "$got" = "$expected" ]; then
  echo "  OK（残るのは $expected）"
else
  echo "  NG: 除外の範囲が想定と違う → $got"
  fail=1
fi
# doc_excluded_name の KEEP 分岐を、判定関数を直接呼んで踏む。
#
# 上の doc_find は配列から find の式を組み立てる別経路であり、doc_excluded_name を
# 通らない。0c の gi_committed は通るが、リポジトリに .env* が1つも無いため
# KEEP に一致する入力がそもそも流れない。**この2つだけでは KEEP 分岐に
# 落ちる条件が無い。**
#
# 壊れたときの帰結は、0c が「値を持つ名前のファイルが追跡されている」と偽の NG を出して
# CI を止めることであり（.env.example は .gitignore が `!` で追跡対象へ戻している）、
# 落ちる条件を持たせておく必要がある。名前は一覧から導出する（足したら自動で増える）。
#
# ここが見るのは doc_excluded_name の単体である。doc_excluded の委譲と
# check-docs.sh の検査1 まで通した経路は、この確認では踏まない。
for g in "${probe_keep_files[@]}"; do
  if doc_excluded_name "${g//\*/x}" >/dev/null; then
    echo "  NG: KEEP のファイル名 ${g//\*/x} が除外されている（doc_excluded_name の KEEP 分岐が効いていない）"
    fail=1
  fi
done

# 先頭が - のファイル名でも除外されること。ここだけが doc_excluded（doc_find でも
# doc_excluded_name でもない側）を直接呼ぶ。doc_excluded は渡されたパスから
# 名前を取り出して doc_excluded_name に渡しており、その取り出しに落ちる条件が無かった。
for f in "${probe_dash_names[@]}"; do
  if ! doc_excluded "$f" >/dev/null 2>&1; then
    echo "  NG: 先頭が - のファイル名 $f が除外されない（doc_excluded の名前の取り出しが壊れている）"
    fail=1
  fi
done

# --- 前提: 検査対象が1件も無いときに落ちること -------------------------------
# この分岐だけが番号付きのケースのどれからも踏まれない。踏まないまま置くと、
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

# --- 前提: 値を持つファイルが .gitignore で無視され、かつ追跡されていないこと ---
# doc-scope.sh の除外が保証するのは「検査が読みに行かない」ことだけで、
# 「値がコミットされない」ことは .gitignore が担う。両者は同じ穴を持ちうる
# （*.tfvars が terraform.tfvars.json に一致しない、が実例）。片方だけ直すと
# 検査は緑のまま秘密がコミットされうるため、ここで .gitignore 側も突き合わせる。
# 判定は git 自身に行わせる。.gitignore を読んで一致規則を書き直すと、
# その実装が本物とずれたときに気づけない。
#
# 見るのは「リポジトリの .gitignore が無視するか」だけである。終了コードを見るだけでは足りない。
#
#   1. 既定の check-ignore はインデックスを見て、追跡済みのパスを「無視されない」と報告する。
#      --no-index を付けないと、追跡済みの README.md に対する下の確認は .gitignore を
#      どう壊しても緑のままになり、落ちる条件を持たなくなる。
#      （手元で確認: 一時の除外ファイルに README.md を書いて実行すると、
#       既定は終了コード 1、--no-index 付きは 0 になった。）
#   2. check-ignore は .git/info/exclude と core.excludesFile にも一致する。
#      GitHub 公式の Terraform.gitignore をグローバル除外に置いている手元では、
#      リポジトリの .gitignore に *.tfvars.json が無くてもこの確認が緑になる。
#      逆に、グローバル除外が *.example を持つ手元では下の gi_tracked が偽の NG を出す。
#      -v で一致元とパターンまで見て、.gitignore に書かれた肯定パターンだけを認める。
#   3. .gitignore は既に追跡されているファイルには効かない。git add -f や
#      「.gitignore に足す前のコミット」で入ったものはパターンが揃っていても値が入っている。
#      追跡の側からも見る。
#
# 代償 1: この確認だけが git の作業ツリーを前提にする。check-docs.sh は「git の追跡状態に
# 依存しない」（未コミットのファイルも検査対象にする）方針だが、.gitignore が何を無視するかは
# git にしか判定できないため、ここは例外とする。git が無い環境や作業ツリーでない場所では
# 0c が NG になる。CI（actions/checkout）と手元はどちらも作業ツリーである。
#
# 代償 2: 一致元を .gitignore に限ったため、.git/info/exclude や core.excludesFile だけで
# 無視している手元では gi_ignored 側が NG になる。逆に gi_tracked 側は、グローバル除外に
# 一致していても緑のままになる（.gitignore に書かれていないため）。
# 0c が保証するのは「リポジトリの .gitignore がどうなっているか」だけである。
# これは意図した限定である。守りたいのは「このリポジトリを clone した誰の手元でも
# 値がコミットされないこと」であり、個人の環境設定はその保証に数えられない。
#
# 代償 3: 下の gi_probe_* が落ちる条件を与えているのは **gi_scan_tracked の中身**
# （読み取り・名前の取り出し・KEEP の差し引き）だけである。
# **実物を流す呼び出し（git ls-files -z | gi_scan_tracked）そのものには、
# 落ちる条件が1つも無い。** リポジトリに DOC_PRUNE_FILES に一致する追跡ファイルが
# 1件も無く結果が常に空であるため、次のどれも全ケースが緑で通る。
#
#   - git ls-files から -z を外す
#   - 呼び出しの数行を丸ごと削る（確認そのものが消えても緑）
#   - pathspec を足して走査範囲を狭める（例: -- docs/）
#   - -C "$repo" の指し先を変える
#
# 落ちる条件を持たせるには、値を持つ名前の追跡ファイルをリポジトリに置くことになる。
# 0c が塞ごうとしている状態そのものを作ることになるため採らない。
# **守れているのは関数の中身までである、と読むこと。**
echo "0c. 値を持つファイル名が .gitignore で無視され、かつ追跡されていないこと"
gi_why=""
gi_ignored_by_gitignore() { # $1=パス。リポジトリの .gitignore が無視していれば 0。一致内容は gi_why
  local line head src pat
  # 出力は <一致元>:<行番号>:<パターン><TAB><パス>。一致が無ければ空。
  line=$(git -C "$repo" check-ignore -v --no-index "$1")
  gi_why=${line:-一致なし}
  [ -n "$line" ] || return 1
  head=${line%%$'\t'*}
  src=${head%%:*}
  pat=${head#*:}; pat=${pat#*:}
  [ "$src" = .gitignore ] || return 1
  # 打ち消しパターン（!）に一致したものは無視されない。
  case "$pat" in '!'*) return 1 ;; esac
  return 0
}
# 現実の綴りは 0a と同じ一覧を見る（手で書き写すと、片方に足したとき
# もう片方の見る範囲が静かに狭くなる）。
# .env はここに直書きしない。probe_prune_files の '.env' は `*` を含まないため、
# 下の導出（${g//\*/x}）が .env そのものを作る。直書きと導出の両方に置くと、
# DOC_PRUNE_FILES から .env を外して .gitignore の該当行も併せて外したとき、
# 導出側は消えるのに直書きだけが残り、根拠を失った NG が出る（KEEP 側と同じ穴）。
gi_ignored=("${probe_real_names[@]}")
# 上の実名の列挙だけだと、DOC_PRUNE_FILES にパターンを足して .gitignore に足し忘れた場合に
# 素通りする（新しい名前がこの一覧に無いため）。0a の
# 「除外されるはずのファイルは一覧から導出する」と同じ置換で機械的に補う。
for g in "${probe_prune_files[@]}"; do gi_ignored+=("${g//\*/x}"); done
# 無視されては困るもの。片側だけ見ると「全部無視する」設定でも緑になる。
# KEEP 由来の名前はここに直書きしない。下の導出だけが持つ形にそろえる。
# 直書きと導出の両方に置くと、DOC_KEEP_FILES から外して .gitignore の `!` 行も
# 併せて外したとき、導出側は消えるのに直書きだけが残り、根拠を失った NG が出る。
# （PRUNE 側の .env も同じ理由で直書きしていない。上を参照。）
gi_tracked=(README.md "${probe_real_keeps[@]}")
# KEEP は .gitignore が `!` で追跡対象へ戻しているファイルを写したものである。
# 実名の列挙だけだと、DOC_KEEP_FILES に足して .gitignore の打ち消し行を足し忘れた場合に
# 素通りする。上の gi_ignored（DOC_PRUNE_FILES 側）と同じ置換で機械的に補う。
# 0a は KEEP・PRUNE の両側を導出しているため、揃えないとこの非対称が 0c にだけ残る。
for g in "${probe_keep_files[@]}"; do gi_tracked+=("${g//\*/x}"); done
gi_ng=0
for p in "${gi_ignored[@]}"; do
  if ! gi_ignored_by_gitignore "$p"; then
    echo "  NG: $p が .gitignore で無視されない（値がコミットされうる。一致: $gi_why）"; gi_ng=1
  fi
done
for p in "${gi_tracked[@]}"; do
  if gi_ignored_by_gitignore "$p"; then
    echo "  NG: $p が .gitignore で無視される（追跡対象のはず。一致: $gi_why）"; gi_ng=1
  fi
done
# 追跡済みのファイルは .gitignore の影響を受けない。パターンが揃っていても値は入っている。
# 判定は doc_excluded と同じ doc_excluded_name に寄せる（一覧を手で並べ直すと黙ってずれる）。
#
# doc_excluded ではなく doc_excluded_name を使う。doc_excluded はディレクトリ側
# （DOC_PRUNE_DIRS）も見るため、.gitignore が `!.vscode/extensions.json` で
# 意図的に追跡対象へ戻しているファイルが、置かれた時点で偽の NG になる。
# 代償: そのぶん 0c は、.terraform/ や uploads/ の配下に追跡ファイルがあっても
# 何も言わない。0c が保証するのは「値を持つ**ファイル名**が追跡されていないこと」だけである。
# ディレクトリ側まで見るなら、KEEP に相当する打ち消しの一覧を別に持つことになる。
# -z で NUL 区切りにする。core.quotePath は既定で有効であり、既定の ls-files は
# 非 ASCII を含むパスを二重引用符で囲みバックスラッシュでエスケープして出力する。
# 「本番.tfvars」が追跡されていると "\346\234\254\347\225\252.tfvars" となり、
# basename の結果に " が残って *.tfvars に一致しない。つまり 0c が塞ごうとしている穴
# （.gitignore は追跡済みに効かない）そのものが素通りする。
# この文書もコミットメッセージも日本語であり、その命名は起こりうる。
# NUL 区切りにすると引用も、パスに改行を含む場合の問題も同時に消える。
#
# **入口だけを NUL にしても足りない。** 出力を改行区切りにすると、
# read -r -d '' が1件として読んだ改行入りのパスが、受け側の mapfile -t で再び割れる。
# 検出（件数が 0 でないこと）は失われないが、NG に出すパスが2件に見え、
# そのまま git rm --cached に渡しても当たらない。経路の端から端まで NUL でそろえる。
#
# 走査は関数に切り出す。実物を渡す経路と、下の決め打ちを渡す確認が
# 同じ読み取りを通るようにするため（2箇所に書くと黙ってずれる）。
gi_scan_tracked() { # 標準入力: NUL 区切りのパス。除外に一致したものを NUL 区切りで返す
  local p
  while IFS= read -r -d '' p; do
    doc_excluded_name "${p##*/}" >/dev/null && printf '%s\0' "$p"
  done
}
# 関数の中身に落ちる条件を持たせる。リポジトリに DOC_PRUNE_FILES に一致する
# 追跡ファイルは1件も無く、実物を流すかぎり結果は常に空である。つまり、この確認を
# 置くまでは、上のループを丸ごと削っても、-z を外しても、名前の取り出しを外しても
# 全ケースが緑で通った
# （ここに件数を書かない。ケースを足すたびに古くなるうえ、コメントの数は
#   どこからも照合されない。0b の注記と同じ理由）。
# 決め打ちの一覧を同じ関数に流し、読み取り・名前の取り出し・KEEP の差し引きを同時に見る。
#
# **ここで塞がるのは関数の中身だけである。** 実物を流す呼び出し側
# （下の git ls-files -z | gi_scan_tracked）にはいまも落ちる条件が無い。
# 上の「代償 3」に、その範囲を書いてある。
#
# 名前は一覧から導出する。手書きで並べると、DOC_PRUNE_FILES / DOC_KEEP_FILES を
# 変えたときに走査は正しく動いているのに期待値だけが取り残され、
# 「根拠を失った NG」が出る（gi_ignored / gi_tracked を導出に寄せたのと同じ理由）。
gi_probe_pass=("${probe_real_names[@]}")
# 非 ASCII 名。パターンの * を「本番」に置き換えて作る。
# 既定の ls-files が引用して出す側であり、引用が残ると一致しなくなる。
for g in "${probe_prune_files[@]}"; do gi_probe_pass+=("${g//\*/本番}"); done
# ディレクトリを含むパス。名前の取り出しを外すと、パターンが先頭から当たらず一致しなくなる。
for f in "${probe_real_names[@]}"; do gi_probe_pass+=("sub/$f"); done
# 先頭が - のファイル名。名前の取り出しを basename に戻すと、option として
# 解釈されて名前が空になり、一致しなくなる。
gi_probe_pass+=("${probe_dash_names[@]}")
# 改行を含む名前。パターンの * を「改行 + x」に置き換えて作る。
# 出力を改行区切りに戻すと、ここで1件が2件に割れて件数が合わなくなる。
# `*` を含むパターンからだけ作る（`.env` は置き換えが起こらず、既にある名前と重複する）。
for g in "${probe_prune_files[@]}"; do
  case "$g" in *'*'*) gi_probe_pass+=("${g//\*/$'\n'x}") ;; esac
done
# 一致してはならない側（KEEP に挙げたもの、末尾一致であることの裏打ちになる対、
# 値を持たない通常のファイル）。
# probe_real_keeps をここに入れるのは、これを doc_excluded_name に尋ねる経路が
# ほかに無いためである。0a の expected は doc_find の別経路であり、
# 0c の gi_tracked が問うのは .gitignore であって doc_excluded_name ではない。
# 入れないと、末尾一致（`case "$base" in $g)`）を前方一致に崩しても全ケースが緑で通る。
gi_probe_skip=("${probe_keep_files[@]//\*/x}" "${probe_real_keeps[@]}" README.md)
# 結果は配列で受ける。$( ) は NUL を落とすため、NUL 区切りの出力を変数には入れられない。
mapfile -d '' -t gi_probe_got < <(printf '%s\0' "${gi_probe_pass[@]}" "${gi_probe_skip[@]}" | gi_scan_tracked)
if [ "${#gi_probe_got[@]}" -ne "${#gi_probe_pass[@]}" ] ||
   [ "${gi_probe_got[*]}" != "${gi_probe_pass[*]}" ]; then
  echo "  NG: 追跡ファイルの走査が想定と違う（期待 ${#gi_probe_pass[@]} 件 / 実際 ${#gi_probe_got[@]} 件）"
  echo "        期待: ${gi_probe_pass[*]}"
  echo "        実際: ${gi_probe_got[*]}"
  gi_ng=1
fi
mapfile -d '' -t gi_committed < <(git -C "$repo" ls-files -z | gi_scan_tracked)
if [ ${#gi_committed[@]} -gt 0 ]; then
  echo "  NG: 値を持つ名前のファイルが追跡されている（.gitignore は追跡済みに効かない）: ${gi_committed[*]}"
  gi_ng=1
fi
if [ "$gi_ng" = 0 ]; then echo "  OK"; else fail=1; fi

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
expect_ng "README のリンク先を除外ディレクトリの配下にする" README.md \
  's|(docs/requirements.md)|(node_modules/pkg/README.md)|' \
  'は検査の対象外ディレクトリ node_modules の配下'
expect_ng "README のリンク先を除外ファイル名（.env）にする" README.md \
  's|(docs/requirements.md)|(.env)|' \
  'は検査の対象外のファイル名 .env に一致'
# h で始まる相対リンク。旧実装は http を外すために先頭1文字を [^)h] で弾いており、
# handbook/... のような相対リンクまで黙って対象外にしていた。
# 「見たと表示しながら見ていない範囲がある」状態は、それ自体では検出できない。
expect_ng "README のリンク先を h で始まる存在しない相対パスに" README.md \
  's|(docs/requirements.md)|(handbook/hooks.md)|' \
  'README.md -> handbook/hooks.md が存在しない'

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

# --- 落ちてはならないこと。$4 で、置いたファイルが検査の対象に入るはず（in）か
#     除外されるはず（out）かを切り替える。関数を2つに分けると、失敗時の出力や
#     後片付けに手を入れたとき片方が黙って取り残される（doc-scope.sh 冒頭と同じ理由）。
#     判定は doc_find -name '*.md' に統一する。検査1が見るのは Markdown だけである。
expect_ok() { # $1=説明 $2=作るファイル $3=中身 $4=in（検査の対象に入る）| out（除外される）
  local desc="$1" file="$2" body="$3" want="$4" got
  n=$((n + 1))
  mkdir -p "$work/$(dirname "$file")"
  printf '%s\n' "$body" > "$work/$file"
  # ファイルを置けたことを先に確かめる。下の got=out は「doc_find の結果に含まれない」
  # でしか判定しておらず、「除外された」と「そもそも置けていない」の両方で成立する。
  # mkdir -p や printf > が失敗しても（set -e は無いので継続する）got=out になり、
  # want=out のケースは一致し、run_check は壊れたリンクが1つも無い状態で当然通る。
  # つまり壊れたリンクを一度も置かないまま「無視されることを確認した」と表示する。
  # in 側は doc_find に現れることで存在も同時に保証されるが、out 側だけ保証が無い。
  if [ ! -f "$work/$file" ]; then
    echo "  NG: $n. $desc — ファイルを置けていない。ケースが成立していない"
    fail=1; return
  fi
  # 置いたファイルが想定した側にあることを先に確かめる。逆側に落ちると
  # 「検査が落ちない」ことに意味が無くなり、ケースは静かに無効化される。
  if (cd "$work" && doc_find -name '*.md' -print | sed 's|^\./||' | grep -qxF "$file"); then
    got=in
  else
    got=out
  fi
  if [ "$got" != "$want" ]; then
    echo "  NG: $n. $desc — 置いたファイルが $want ではなく $got の側にある。ケースが成立していない"
    fail=1; rm -f "$work/$file"; return
  fi
  if run_check; then
    echo "  OK: $n. $desc"
  else
    echo "  NG: $n. $desc — 落ちてはならないのに検査が落ちた"
    (cd "$work" && bash scripts/check-docs.sh 2>&1 | grep '^  NG' | sed 's/^/        実際: /')
    fail=1
  fi
  rm -f "$work/$file"
}
# 除外されたディレクトリの中の Markdown は検査対象にならないこと。
# ここが効かないと、依存パッケージの README のリンク切れで CI が落ちる。
expect_ok "node_modules の中のリンク切れは無視される" node_modules/pkg/README.md \
  '[壊れたリンク](./does-not-exist.md)' out
expect_ok "入れ子の node_modules の中のリンク切れも無視される" apps/api/node_modules/pkg/README.md \
  '[壊れたリンク](./does-not-exist.md)' out
# 外部リンクを飛ばす判断はスキームで行う。現物の文書にも https のリンクはあるが、
# それが消えた瞬間にこの経路の確認も消える。専用のケースとして残す。
#
# case が列挙する3つのスキームは、3つとも1本ずつ置く。ここがスキーム判定の唯一の確認で
# あるため、置かなかった枝は個別に無検査になる。http:// を置かないと、その枝を
# 丸ごと削っても全ケースが緑で通る（https は http:// に一致しないため冗長ではない）。
# 消えた場合の帰結は、文書に http:// のリンクが1本入った時点で
# 「http://… が存在しない」という偽の NG が出て CI が止まることであり、
# しかも文面は「リンク切れ」と読めるため、本来直す必要のないリンクの方を疑わせる。
expect_ok "外部リンク（http / https / mailto）は存在を確かめない" docs/probe-external-link.md \
  '[外部の文書](https://example.invalid/does-not-exist) と [平文の外部](http://example.invalid/x) と [連絡先](mailto:nobody@example.invalid)' in

# --- 「N通り」の宣言が実数と一致すること -------------------------------------
# check-docs.sh の3章は「合計 N 件」「全 N 件」「機能N件」「N項目」を照合するが、
# 「N通り」は見ていない。実数 $n はテストを走らせて初めて確定するため、ここで突き合わせる。
# 無いと、ケースを1件足すたびに文書の宣言が古くなり、しかもどの検査も落ちない。
# 検査3で「tech-stack.md が漏れていたため機能34件が38件になっても放置された」のと同型。
echo "2. 「N通り」の宣言が実数と一致すること"
decl_files=(README.md CLAUDE.md)
# パターンは宣言の行にしか無い後続語まで含めて一意にする（check-docs.sh の
# compare_decls と同じ方針）。総称の [0-9][0-9]*通り で拾うと、ケース数と無関係な
# 「起動は2通り」のような1行が入った時点で「2 と書かれているが、実際は N」という
# 偽の NG が出る。しかも文面は「宣言が古い」と読めるため、受け取った側は
# 本来直す必要のない文の方を書き換えてしまう。
# （N に具体数を書かない。ケースを足すたびに古くなるうえ、コメントの数は
#   どこからも照合されない。0b の注記と同じ理由。）
# 読み取れない場合を NG にする扱いは下に入れてあるので、具体化しても
# 「言い回しを変えたら検査が消える」ことにはならない。
decl_pattern() { # $1=ファイル名。その文書の宣言のパターンを出力する
  case "$1" in
    README.md) echo 'check-docs\.test\.sh`、[0-9][0-9]*通り' ;;
    CLAUDE.md) echo '検査そのものの検査を[0-9][0-9]*通り含む' ;;
    *) return 1 ;;
  esac
}
decl_mismatches() { # $1=期待する数。README.md と CLAUDE.md の「N通り」のうち食い違うものを返す
  local f v pat found
  for f in "${decl_files[@]}"; do
    if ! pat=$(decl_pattern "$f"); then
      echo "$f の「N通り」のパターンが定義されていない（decl_pattern に足す）"
      continue
    fi
    # found は文書ごとに持つ。ループの外に置くと、片方が読めているだけで
    # もう片方の「読み取れない」が出なくなり、その文書が黙って対象から外れる。
    # check-docs.sh の compare_decls が宣言ごとに呼ばれているのと同じ粒度にそろえる。
    found=0
    while IFS= read -r v; do
      [ -n "$v" ] || continue
      found=1
      [ "$v" = "$1" ] || echo "$f の「N通り」: $v と書かれているが、実際は $1"
    # 数の取り出しは doc-scope.sh の decls に寄せる。ここに書き直すと、
    # check-docs.sh 側の読み取りを直したときにテスト側だけが古い規則で残る。
    done < <(decls "$repo/$f" "$pat")
    # 読み取れないのも NG。黙って通すと、言い回しを変えた時点で検査が落ちるのではなく消える
    # （check-docs.sh の compare_decls と同じ扱い）。
    [ "$found" = 1 ] || echo "$f の「N通り」を読み取れない（言い回しが変わった可能性）"
  done
}
# 突き合わせ自体が働いていることを先に見る。わざと違う数を渡して何も出ないなら、
# 下の確認は文書に何を書いても通る。0a・0c と同じく「ケースが成立していない」を検出する。
# 「1件でも出たか」ではなく文書ごとに出たかを見る。合計で見ると、片方の宣言が
# 読み取れなくなっても、もう片方の食い違いだけでこの自己確認が緑のまま通る。
#
# 渡す数は、宣言として現れ得ない -1 にする。n + 1 だと、宣言がたまたまその数のとき
# （ケースを1件減らして宣言を直し忘れた場合が該当する。この検査が最も想定している変化である）
# その文書だけ食い違いが出ず、「突き合わせが効いていない」という**原因を取り違えた NG** が出る。
# decls が数を取り出すのは grep -o "[0-9][0-9]*" であり、負数は決して現れない。
decl_probe=$(decl_mismatches -1)
decl_probe_ng=0
for f in "${decl_files[@]}"; do
  printf '%s\n' "$decl_probe" | grep -q "^$f の" || {
    echo "  NG: 「N通り」の突き合わせが $f に効いていない（宣言に現れ得ない数を渡しても食い違いが出ない）"
    decl_probe_ng=1
  }
done
# 自己確認が落ちた場合も本体の結果を出す。どちらが原因かを1回の実行で切り分けるため。
decl_out=$(decl_mismatches "$n")
if [ -n "$decl_out" ]; then
  printf '%s\n' "$decl_out" | sed 's/^/  NG: /'
  fail=1
elif [ "$decl_probe_ng" = 0 ]; then
  echo "  OK（$n 通り）"
fi
[ "$decl_probe_ng" = 0 ] || fail=1

if [ "$fail" -ne 0 ]; then echo "検査の検査に失敗しました"; exit 1; fi
echo "$n 通りの確認をすべて通過しました"
