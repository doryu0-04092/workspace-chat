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
  mkdir -p "$work/$(doc_parent "$p")"
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
probe_dirs=(.git .claude node_modules .pnp dist build .vite coverage .nyc_output
            playwright-report test-results blob-report reports generated uploads tmp
            .terraform .vscode .idea)
probe_prune_files=('.env' '.env.*' '*.tfstate' '*.tfstate.*' '*.tfvars' '*.tfvars.json'
                   '*.log' 'crash.log' 'npm-debug.log*' 'yarn-debug.log*' 'yarn-error.log*'
                   'pnpm-debug.log*' 'override.tf' 'override.tf.json' '*.swp' '*.swo')
probe_keep_files=('.env.example')
# 現実に出てくる綴り。0a（木を作る）と 0c（.gitignore に問う）が同じものを見る。
# 導出（${g//\*/x}）は1パターンにつき代表1名しか作らないため、
# secrets.auto.tfvars.json のようなドットを複数含む綴りはこの一覧にしか依存しない。
# 0a と 0c で別々に書き写すと、片方に足したときもう片方が静かに狭くなる。
probe_real_names=(.env.local terraform.tfstate terraform.tfstate.backup
                  prod.tfvars terraform.tfvars.json secrets.auto.tfvars.json
                  crash.log npm-debug.log.1 override.tf .env.swp)
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
# **ファイル名の一覧に、スラッシュを含むパターンを入れない。**
# doc_find は `find -name "$g"`、doc_excluded_name は `case "$base" in $g)` であり、
# **どちらも basename にだけ当たる。** スラッシュを含むパターンを足しても**永久に一致しない。**
#
# **一方 0c-3 は一覧と文字列として照合するため、足した時点で緑になる**——
# 「分類は済んだ／除外は効いていない」という偽の緑が作れる（#44 第4巡の指摘）。
# **指示を読み違えても、ここで止まる。**
no_slash() { # $1=一覧の名前 $2...=要素
  local name="$1" g
  shift
  for g in "$@"; do
    case "$g" in
      */*)
        echo "  NG: $name の「$g」がスラッシュを含む（basename にしか当たらないため、永久に一致しない）"
        echo "        パスで絞るなら、先頭のディレクトリ名を DOC_PRUNE_DIRS へ足す"
        fail=1
        ;;
    esac
  done
}
no_slash DOC_PRUNE_FILES "${DOC_PRUNE_FILES[@]}"
no_slash DOC_KEEP_FILES "${DOC_KEEP_FILES[@]}"
# **DOC_NO_VALUE_IGNORES にも当てる。** ここに入れた行も 0c-3 の照合を通るため、
# スラッシュを含む綴りを足すと「分類は済んだ」の側で緑になる（#44 第8巡）。
no_slash DOC_NO_VALUE_IGNORES "${DOC_NO_VALUE_IGNORES[@]}"
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
  echo "  OK: doc_find の結果は想定どおり（残るのは $expected）"
else
  echo "  NG: 除外の範囲が想定と違う → $got"
  fail=1
fi
# doc_excluded_name の KEEP 分岐を、判定関数を直接呼んで踏む。
#
# 上の doc_find は配列から find の式を組み立てる別経路であり、doc_excluded_name を
# 通らない。0c の gi_committed は、origin/main が .env.example を追跡対象として
# 置いたため KEEP 分岐を実物でも踏むようになった（それ以前は .env* が1つも無く、
# KEEP に一致する入力がそもそも流れなかった）。
#
# それでもここを残す。gi_committed 側が KEEP の破れを表に出すときの文言は
# 「値を持つ名前のファイルが追跡されている」であり、**原因を取り違えさせる。**
# 受け取った側は .gitignore と追跡状態を疑うが、実際に壊れているのは判定関数である。
# ここは KEEP 分岐そのものを名指しで落とす。
#
# 名前は一覧から導出する（足したら自動で増える）。
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
#
# **本番の呼び出し元が作らない形の入力である。** check-docs.sh の検査1 は
# `$(doc_parent "$f")/$l` を渡すため、先頭は必ず `./` か `docs/` になる。
# ここが固定しているのは、呼び出し元の形に依存しない関数単体の性質である。
# 実際に先頭が - のまま流れるのは、git ls-files の出力を渡す 0c の走査のほう。
for f in "${probe_dash_names[@]}"; do
  if ! doc_excluded "$f" >/dev/null 2>&1; then
    echo "  NG: 先頭が - のファイル名 $f が除外されない（doc_excluded の名前の取り出しが壊れている）"
    fail=1
  fi
done

# --- 前提: 検査対象が1件も無いときに落ちること -------------------------------
# この分岐だけが、以降のどのケースからも踏まれない。踏まないまま置くと、
# 検査が何も見ていない状態を「合格」と表示するようになっても気づけない。
#
# ここに「ケース1〜N」と数を書かない。ケースを足すたびに古くなるうえ、
# この数はどこからも照合されない（2章が照合するのは README / CLAUDE の「N通り」だけ）。
# 宣言と実数の食い違いを機械で捕まえるのがこのファイルの目的である以上、
# 捕まらない宣言をコメントに増やすのは同じ穴を1つ作ることになる。
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
#      どう壊しても緑のままになる。
#      （手元で確認: 一時の除外ファイルに README.md を書いて実行すると、
#       既定は終了コード 1、--no-index 付きは 0 になった。）
#      **この指定自体に落ちる条件を持たせてある。** KEEP の名前が .gitignore の
#      打ち消し（!）に一致することを下で見ており、--no-index を外すと
#      追跡済みの .env.example に一致が返らなくなって落ちる。
#   2. check-ignore は .git/info/exclude と core.excludesFile にも一致する。
#      GitHub 公式の Terraform.gitignore をグローバル除外に置いている手元では、
#      リポジトリの .gitignore に *.tfvars.json が無くてもこの確認が緑になる。
#      -v で一致元とパターンまで見て、.gitignore に書かれた肯定パターンだけを認める。
#      （-v を入れる前は、グローバル除外が *.example を持つ手元で gi_tracked が
#       偽の NG を出した。いまは一致元を見るため、その形では落ちない。下の代償 2 を参照）
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
# **実物を流す呼び出し（gi_read_into gi_tracked_hits_in "$repo"）そのものには、
# かつて落ちる条件が1つも無かった。** doc_excluded_name が除外と判定する追跡ファイルが
# 1件も無く（.env.example は DOC_PRUNE_FILES の .env.* に一致するが、KEEP が差し引く）、
# 結果が常に空であるため、次のどれも全ケースが緑で通った。
#
#   - git ls-files から -z を外す
#   - 呼び出しの数行を丸ごと削る（確認そのものが消えても緑）
#   - pathspec を足して走査範囲を狭める（例: -- docs/）
#   - -C の指し先を変える
#
# **「塞げない」ではなかった。塞いでいなかっただけである。**
# 実物に値を持つ追跡ファイルを置くのは、0c が塞ごうとしている状態そのものを
# 作ることになるため採らない。**しかしその手は他にもある。**
# 0c-2b が採っているのが、それである——専用の一時リポジトリを git init し、
# そこに git add -f して、リポジトリを引数で受ける関数を本体と壊す確認で共有する。
# 実物には何も置かずに、**-z・pathspec・指し先の3つ**に落ちる条件を与えられる。
#
# **同じ形を、この gi_committed の呼び出しにも適用した**（#88）。
# 下の gi_tracked_hits_in がリポジトリを引数で受け、専用の一時リポジトリに
# 名前だけが除外に当たる空ファイルを1件置いて、それを拾えることを見る。
# **上の4つのうち3つが塞がった**（実際に壊して落ちることを確かめてある）。
#
# **「呼び出しの数行を丸ごと削る」だけは、いまも塞げていない**——
# 本体を削っても、残った壊す確認は一時リポジトリだけを見て OK を出す。
echo "0c. 値を持つファイル名が .gitignore で無視され、かつ追跡されていないこと"
gi_why=""
gi_pat=""   # 一致したパターン。.gitignore 以外が一致元だったときは空
# $1=問う先の git リポジトリ $2=パス。そのリポジトリの .gitignore が
# 無視していれば 0。一致内容は gi_why。
#
# リポジトリを引数にしているのは、0c-2 が実物の $repo ではなく専用の
# 複製（git init した一時ディレクトリ）を問うためである。ここを固定で
# $repo と書くと、0c-2 が同じ判定をもう1つ書き直すことになり、
# 出力形式の読み取りが2箇所でずれうる。
gi_ignored_by_gitignore() {
  local line head src pat
  # 出力は <一致元>:<行番号>:<パターン><TAB><パス>。一致が無ければ空。
  line=$(git -C "$1" check-ignore -v --no-index "$2")
  gi_why=${line:-一致なし}
  gi_pat=""
  [ -n "$line" ] || return 1
  head=${line%%$'\t'*}
  src=${head%%:*}
  pat=${head#*:}; pat=${pat#*:}
  [ "$src" = .gitignore ] || return 1
  gi_pat=$pat
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
# 直下だけでなく配下のパスも問う。
#
# **踏むと壊れる: この名前の *いずれかの階層* に .gitignore を置くと 0c が偽の NG を出す。**
# git は祖先のどの階層の .gitignore も評価するため、1段目でも2段目でも同じ壊れ方をする
# （実測: probe-not-root/.gitignore に *.tfvars を置くと、一致元が
#  probe-not-root/.gitignore になって「無視されない」で落ちた）。
# gi_ignored_by_gitignore は git check-ignore -v の一致元がちょうど .gitignore で
# あることを求めており、配下の .gitignore に一致すると一致元が
# <この名前>/.gitignore になって「無視されない」と判定するためである。
# 実在しうる置き場（infra/terraform など）を選ぶと、その運用を始めた時点で落ちる。
# 検査用だと分かる名前にしてある。要件は「直下ではない」ことだけで、実在は要らない。
#
# 反復中に同じ配列へ足さない。展開の時点で確定するとはいえ、読む側に紛れる。
gi_subdir='probe-not-root/nested'
gi_sub=()
for f in "${gi_ignored[@]}"; do gi_sub+=("$gi_subdir/$f"); done
gi_ignored+=("${gi_sub[@]}")
gi_sub=()
for f in "${gi_tracked[@]}"; do gi_sub+=("$gi_subdir/$f"); done
gi_tracked+=("${gi_sub[@]}")
gi_ng=0
for p in "${gi_ignored[@]}"; do
  if ! gi_ignored_by_gitignore "$repo" "$p"; then
    echo "  NG: $p が .gitignore で無視されない（値がコミットされうる。一致: $gi_why）"; gi_ng=1
  fi
done
for p in "${gi_tracked[@]}"; do
  if gi_ignored_by_gitignore "$repo" "$p"; then
    echo "  NG: $p が .gitignore で無視される（追跡対象のはず。一致: $gi_why）"; gi_ng=1
  fi
done
# KEEP の名前は、.gitignore が打ち消し（!）で追跡対象へ戻しているものの写しである。
# 「無視されない」だけでなく、**打ち消しに一致していること**まで見る。
#
# ここが --no-index の落ちる条件である。--no-index を外すと、check-ignore は
# インデックスを見て追跡済みのパスに一致を返さなくなる（一致なしになる）。
# 上の2つのループは「無視されない」を期待する側なので、それでも緑のまま通る。
for g in "${probe_keep_files[@]}"; do
  gi_keep=${g//\*/x}
  gi_ignored_by_gitignore "$repo" "$gi_keep"
  case "$gi_pat" in
    '!'*) ;;
    *) echo "  NG: $gi_keep が .gitignore の打ち消し（!）に一致しない（一致: $gi_why）"; gi_ng=1 ;;
  esac
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
  # **明示的に 0 を返す。** while の終了コードは本体の最後のコマンドのものであり、
  # 最後に読んだパスが除外に当たらなければ && が短絡して非ゼロになる——
  # **実物を流すかぎり、ほぼ必ず非ゼロで終わる。**
  # 呼び出し側が終了コードを見る形（gi_read_into）にした時点で、
  # これを返すと「git ls-files が失敗した」と誤って報告される（実際に踏んだ）。
  # **git の失敗は握り潰されない**——冒頭の set -o pipefail により、
  # パイプラインは git が失敗すれば非ゼロを返す。
  return 0
}
# 関数の中身に落ちる条件を持たせる。doc_excluded_name が除外と判定する追跡ファイルは
# 1件も無く（.env.example は KEEP が差し引く）、実物を流すかぎり結果は常に空である。つまり、この確認を
# 置くまでは、上のループを丸ごと削っても、-z を外しても、名前の取り出しを外しても
# 全ケースが緑で通った
# （ここに件数を書かない。ケースを足すたびに古くなるうえ、コメントの数は
#   どこからも照合されない。0b の注記と同じ理由）。
# 決め打ちの一覧を同じ関数に流し、読み取り・名前の取り出し・KEEP の差し引きを同時に見る。
#
# **ここで塞がるのは関数の中身だけである。** 実物を流す呼び出し側
# （下の gi_read_into gi_tracked_hits_in "$repo"）は、その直前の probe が塞いでいる（#88）。
# 上の「代償 3」に、いまも塞げていない1つを書いてある。
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
# --- 前提: 実物を問う走査が、実際に追跡ファイルを拾えること（#88）---
# **これが無いと、-z を外しても・pathspec で範囲を狭めても・-C の指し先を変えても、
# 全ケースが緑で通る**——実物には除外に当たる追跡ファイルが1件も無く、結果が常に空になるためである。
# 上の「代償 3」が「呼び出し側には落ちる条件が無い」と書いていた範囲を、ここで塞ぐ。
#
# **実物には何も置かない。** 置くこと自体が、0c が防ごうとしている状態を作る。
# 0c-2b と同じ形を採る——専用の一時リポジトリを git init し、そこに git add -f して、
# **リポジトリを引数で受ける関数を、本体と壊す確認で共有する。**
#
# 落ちる条件の作り方:
#   - **-z を外すと 0 件になる。** この経路の読み手は下の gi_scan_tracked の
#     `read -r -d ''` であり、NUL が1つも無ければループの中身が一度も実行されない。
#     **件数の比較がこれを捕まえる。**（0c-2b の同じ注記が「件数では気づけない。パスで見る」と
#     書いているのは、あちらの読み手が `mapfile -d ''` で出力全体が1要素として読まれるためである。
#     **ここでは成立しない。** 写さないこと）
#   - **名前に非 ASCII を含める**のは、-z があるかぎり git が引用しないことを併せて見るため。
#     引用が残れば、件数ではなくパスの比較で落ちる
#   - **sub/ の下**に置く。pathspec（例: -- docs/）で範囲を狭めると拾えなくなる
#   - **引数のリポジトリを問う。** -C の指し先を固定に書き換えると、
#     本体か壊す確認のどちらかが必ず落ちる
#
# **順序に意味がある。壊す確認の probe を先に足してから、本体を読む**（0c-2b と同じ）。
# 逆にすると、本体の指し先を一時リポジトリに取り違えても、その時点では索引が空で
# 0 件になり、**実物を一度も見ないまま緑で通る。**
#
# **名前は DOC_PRUNE_FILES から導出する。** 手書きで並べると、一覧を変えたときに
# 走査は正しく動いているのに期待値だけが取り残される（上の gi_probe_pass と同じ理由）。
gi_tracked_hits_in() { # $1=問う先の git リポジトリ。除外に当たる追跡ファイルを NUL 区切りで返す
  git -C "$1" ls-files -z | gi_scan_tracked
}

# * を含むパターンからだけ作る（.env のような固定名は置き換えが起こらない）。
gi_scan_probe_name=''
for g in "${probe_prune_files[@]}"; do
  case "$g" in *'*'*) gi_scan_probe_name="${g//\*/本番}"; break ;; esac
done
gi_scan_probe_ok=0
if [ -z "$gi_scan_probe_name" ]; then
  # DOC_PRUNE_FILES から * を含むパターンが消えると、ここが空になる。
  # 名指ししないと、下の判定が「0 件」で落ちて -z や pathspec を疑わせる。
  echo "  NG: DOC_PRUNE_FILES に * を含むパターンが無く、走査の確認用の名前を作れない"
  gi_ng=1
elif ! gi_scan_probe=$(mktemp -d); then
  echo "  NG: 走査の確認用の一時ディレクトリを作れなかった（TMPDIR を確かめる）"
  gi_ng=1
elif ! git -C "$gi_scan_probe" init -q; then
  echo "  NG: 走査の確認用の一時リポジトリを作れなかった（$gi_scan_probe）"
  gi_ng=1
elif ! mkdir -p "$gi_scan_probe/sub"; then
  echo "  NG: 走査の確認用のディレクトリを作れなかった（$gi_scan_probe/sub）"
  gi_ng=1
elif ! : > "$gi_scan_probe/sub/$gi_scan_probe_name"; then
  # **中身は書かない。判定は名前だけで行われる。**
  echo "  NG: 走査の確認用のファイルを作れなかった（sub/$gi_scan_probe_name）"
  gi_ng=1
elif ! git -C "$gi_scan_probe" add -f -- "sub/$gi_scan_probe_name"; then
  echo "  NG: 走査の確認用のファイルを索引に足せなかった（sub/$gi_scan_probe_name）"
  gi_ng=1
else
  gi_scan_probe_ok=1
fi
# **読み取りの層は、このファイルに1つだけ置く。**
# 0c と 0c-2b は producer（NUL 区切りを標準出力へ出す関数）が違うだけで、
# 入口での配列の戻し・mktemp の名指し・終了コードの判定・mapfile の名指し・rm -f・return 0 は
# すべて同じである。**2箇所に書くと、片方だけ直したときに黙ってずれる**——
# このファイルが他の手順について繰り返し禁じてきた形であり、
# 実際に #88 の第1巡で「0c-2b から終了コードの判定だけを写し漏れる」を踏んだ。
#
# **読み取りの終了コードを見る。** プロセス置換（`< <(...)`）で受けると終了コードが失われ、
# **git が失敗して出力が空でも「追跡されていない」と同じ 0 件になり、緑のまま通る。**
# このファイルは冒頭で `set -uo pipefail` を敷いているため、
# `git | gi_scan_tracked` のパイプラインは git の失敗をそのまま返す。捨てなければ拾える。
#
# **名指しの経路を1つにする。** 関数の中で NG を出して呼び出し側も出すと、
# 2行が並んで**後から出るほう（git）を先に疑うことになる。**
#
# **mktemp の明示的な判定を外さないこと。** 外すと out が空文字になってリダイレクトが開けず、
# producer は**一度も実行されないまま**非ゼロで返る。理由は「producer が失敗した」になり、
# 読む側は pathspec や -z を見に行って、実際の原因（TMPDIR）に届かない。
#
# **成功経路では明示的に 0 を返す。** 最後の rm -f の終了コードが漏れると、
# 読み取りは成功しているのに呼び出し側が偽の NG を出す
# （しかも gi_read_err は空のままなので、括弧の中が空になる）。
gi_read=()
gi_read_err=''
gi_read_into() { # $1=producer 関数名 $2=リポジトリ。結果は gi_read。読めなければ 1 と gi_read_err
  local out
  # **入口で配列を戻す。** mapfile が失敗すると代入が起きず、前回の呼び出しの値が残る。
  # この関数は本体と壊す確認で繰り返し呼ばれるため、残った値で判定しうる。
  gi_read=()
  gi_read_err=''
  if ! out=$(mktemp); then
    gi_read_err='読み取り用の一時ファイルを作れなかった。TMPDIR を確かめる'
    return 1
  fi
  if ! "$1" "$2" >"$out"; then
    gi_read_err="$1 が失敗した: $2"
    rm -f "$out"
    return 1
  fi
  if ! mapfile -d '' -t gi_read <"$out"; then
    gi_read_err='読み取り結果を配列に取り込めなかった（mapfile が失敗した）'
    rm -f "$out"
    return 1
  fi
  rm -f "$out"
  return 0
}
if [ "$gi_scan_probe_ok" = 1 ]; then
  if ! gi_read_into gi_tracked_hits_in "$gi_scan_probe"; then
    echo "  NG: 走査の確認用の一時リポジトリを読めなかった（$gi_read_err）"
    gi_ng=1
  else
    gi_scan_probe_got=("${gi_read[@]}")
    if [ "${#gi_scan_probe_got[@]}" -ne 1 ] ||
       [ "${gi_scan_probe_got[0]}" != "sub/$gi_scan_probe_name" ]; then
      echo "  NG: 追跡ファイルの走査が、除外に当たる追跡ファイルを拾えていない"
      echo "        期待: 1 件「sub/$gi_scan_probe_name」"
      echo "        実際: ${#gi_scan_probe_got[@]} 件「${gi_scan_probe_got[*]}」"
      gi_ng=1
    fi
  fi
fi
if ! gi_read_into gi_tracked_hits_in "$repo"; then
  echo "  NG: 追跡ファイルの走査そのものが失敗した（$gi_read_err）"
  gi_ng=1
else
  gi_committed=("${gi_read[@]}")
  if [ ${#gi_committed[@]} -gt 0 ]; then
    echo "  NG: 値を持つ名前のファイルが追跡されている（.gitignore は追跡済みに効かない）: ${gi_committed[*]}"
    gi_ng=1
  fi
fi
if [ "$gi_ng" = 0 ]; then echo "  OK"; else fail=1; fi

# --- 前提: .claude/ が .gitignore で無視され、行を消すと無視されなくなること ---
# 上の gi_ignored / gi_tracked は DOC_PRUNE_FILES・DOC_KEEP_FILES というファイル名の
# 一覧を問うもので、.claude/ のような**ディレクトリ**の除外は見ていない
# （doc_excluded_name がファイル名だけの判定であるのと同じ理由）。#35 で
# .gitignore に .claude/ を足したこと自体は、ここでしか確かめられない。
#
# **元のリポジトリは書き換えない**（冒頭の方針）。git check-ignore は
# .gitignore の中身だけでなく「git のリポジトリであること」も要るため、
# 専用の一時ディレクトリに git init し、.gitignore だけを複製して問う。
# 壊す確認もこの複製の .gitignore を書き換えて行い、$repo には一切触れない
# （trap での復元も、途中で落ちたときに実物が壊れて残るおそれも無い）。
echo "0c-2. .claude/ が .gitignore で無視され、行を消すと無視されなくなること"
# **踏むと壊れる: この一時リポジトリの索引に .claude/ 配下を足すと、0c-2b が偽の NG を出す。**
# 下の 0c-2b は同じ一時リポジトリを使い、壊す確認で索引に**ちょうど1件**あることを
# 期待している。いまの 0c-2 は git check-ignore --no-index しか使わないため索引に
# 入らないが、ここに「.gitignore は追跡済みには効かない」を見る確認を足して
# git add -f した瞬間、0c-2b は2件を読んで落ちる。**出る NG は
# 「壊す確認が効いていない」であり、pathspec や -z を疑わせる**——実際の原因
# （0c-2 が索引に足したこと）には届かない。足すなら 0c-2b 側の期待も併せて直すこと。
gi_claude_probe='.claude/worktrees/probe-gitignore-scope/x.md'
# mktemp -d の失敗も名指しする。見ないと gi_claude_repo が空文字になり、
# 次の git init -q "" が走って、出る NG は括弧の中が空のものになる
# （「一時リポジトリを作れなかった（）」）。**パスが空になった理由がどこにも出ない。**
# 加えて、空文字を実行時のカレント（＝実物のリポジトリ）と解釈する git があれば、
# このファイルが冒頭で宣言している「元のリポジトリは書き換えない」に触れる。
# **先にここで止めれば、その挙動に依存しない。**
gi_claude_repo='<mktemp -d が失敗したため未作成>'
gi_claude_repo_ok=0
if ! gi_claude_repo=$(mktemp -d); then
  gi_claude_repo='<mktemp -d が失敗したため未作成>'
  echo "  NG: .claude/ 用の一時ディレクトリを作れなかった（TMPDIR を確かめる）"
  fail=1
elif ! git init -q "$gi_claude_repo"; then
  # git init 自体が失敗した場合、以下のすべての判定が「一時リポジトリが
  # 無いから無視されない／追跡されない」という別の理由で NG になりうる。
  # 原因を取り違えさせないよう、ここで名指しして止める。
  echo "  NG: .claude/ 用の一時リポジトリを作れなかった（$gi_claude_repo）"
  fail=1
else
  gi_claude_repo_ok=1
  # 複製に失敗すると、一時リポジトリに .gitignore が無いまま下の判定に進み、
  # 出る NG は「.claude/ 配下のパスが .gitignore で無視されない（一致: 一致なし）」に
  # なる。**受け取った側は実物の .gitignore から .claude/ の行が消えたと読み、
  # そちらを直しに行く。** 壊れているのは複製のほうである。
  # git init・mkdir・git add -f と同じく、失敗したら名指しして先に進まない。
  if ! cp "$repo/.gitignore" "$gi_claude_repo/.gitignore"; then
    echo "  NG: .gitignore を一時リポジトリに複製できなかった（$gi_claude_repo/.gitignore）"
    fail=1
    # gi_claude_repo_ok は 1 のままにする。0c-2b の壊す確認は .gitignore を使わず
    # git add -f だけで成り立つため、複製の失敗を理由にあちらまで止めると、
    # こんどは 0c-2b が原因を取り違えた NG を出すことになる。
  elif ! gi_ignored_by_gitignore "$gi_claude_repo" "$gi_claude_probe"; then
    echo "  NG: .claude/ 配下のパスが .gitignore で無視されない（一致: $gi_why）"
    fail=1
  else
    # 置換が実際に効いたことを grep -c の件数（変更前1件 → 変更後0件）で確かめる。
    # 書き換える先は複製（$gi_claude_repo/.gitignore）であり、実物の
    # $repo/.gitignore ではない。
    gi_claude_before=$(grep -c '^\.claude/$' "$gi_claude_repo/.gitignore")
    sed -i '/^\.claude\/$/d' "$gi_claude_repo/.gitignore"
    gi_claude_after=$(grep -c '^\.claude/$' "$gi_claude_repo/.gitignore")
    if [ "$gi_claude_before" -ne 1 ] || [ "$gi_claude_after" -ne 0 ]; then
      echo "  NG: sed が想定どおり複製の .gitignore の .claude/ 行を消せていない（変更前 $gi_claude_before 件 / 変更後 $gi_claude_after 件）"
      fail=1
    elif gi_ignored_by_gitignore "$gi_claude_repo" "$gi_claude_probe"; then
      echo "  NG: 複製の .gitignore から .claude/ を消しても無視され続けている（一致: $gi_why）"
      fail=1
    else
      echo "  OK"
    fi
  fi
fi

# --- 前提: .claude/ 配下が追跡されていないこと -------------------------------
# .gitignore は「今後 add されても無視される」ことしか保証しない。
# **既に追跡されてしまっているファイルには効かない**（0c の代償3・
# gi_committed と同じ理由）。.claude/ については、まだ誰もこれを見ていない。
#
# **本体（実物の $repo を問う判定）は git init の成否と切り離す。**
# 一時リポジトリが無くても「.claude/ が追跡されていないか」自体は問える。
# git init の成否の内側に本体を置くと、一時リポジトリが作れないだけで
# 「.claude/ が追跡されていないか」を一切確かめない状態になる。
#
# 読み取りは関数に切り出し、本体と壊す確認の両方がそこを通るようにする
# （gi_ignored_by_gitignore・gi_scan_tracked と同じ理由）。2箇所に別々に
# 書くと、本体側の pathspec や -z を壊しても壊す確認の呼び出しは無事なままで、
# 壊れたことに気づけない。
#
# **共有するだけでは -z は守れない。** 壊す確認が件数だけを見ていると、
# -z を外しても出力全体が1要素として読まれて 1 件になり、素通りする。
# 下の壊す確認は件数ではなく**パスの一致**を見る。-z を外すと区切りが
# NUL から改行に変わって末尾の改行が要素に残り、さらに非 ASCII の名前は
# クォートされる（core.quotePath の既定）ため、どちらでも一致しなくなる。
#
# **読み取りの終了コードを見る。** プロセス置換（`< <(...)`）で受けると
# 終了コードが失われ、git が失敗して出力が空でも「追跡されていない」と同じ
# 0 件になり、**緑のまま通る。** git init・cp・mkdir・git add -f を名指しで
# 止めているのと同じ理由で、ここも握り潰さない。
#
# **順序に意味がある。壊す確認の probe を先に一時リポジトリへ足してから、
# 本体を読む。** 逆にすると、本体の指し先を一時リポジトリに取り違えても、
# その時点では索引が空なので 0 件で緑になり、**実物の .claude/ を一度も
# 見ないまま全ケースが緑で通る。** 先に足しておけば、取り違えた本体は probe を
# 拾って「追跡されている」で落ちる。**同じ形は 0c にも入れてある**（#88。上の代償 3）。
gi_claude_tracked_in() { # $1=リポジトリ。.claude 配下で追跡されているパスを NUL 区切りで返す
  git -C "$1" ls-files -z -- .claude
}
# 読み取りは上の gi_read_into を通す（0c と共有）。**ここに層をもう1つ作らないこと。**
echo "0c-2b. .claude/ 配下が追跡されていないこと"

# 壊す確認の準備。**本体より先に行う**（上の「順序に意味がある」）。
# 一時リポジトリに .claude/ 配下のファイルを作って git add -f する。
#
# **この一時リポジトリは 0c-2 が作ったものであり、ここ専用ではない。**
# しかも 0c-2 は壊す確認のために、複製した .gitignore から .claude/ の行を
# sed で消したまま次へ進む。**ここに .gitignore に依存する確認（-f 無しでは
# add されないこと等）を足さないこと。** その .gitignore には既に .claude/ が
# 無いため、素通りするか根拠の無い NG が出る。出る NG は 0c-2b の中を疑わせ、
# 実際の原因（0c-2 の sed）には届かない。0c-2 側に書いた警告と対になっている。
# **実物の $repo に git add -f することはしない**——それ自体が、
# この検査で防ぎたい「.claude/ が追跡される」状態を本当に作ってしまう。
#
# 名前に非 ASCII を含めるのは、-z が守っているものそのものだからである。
#
# 準備（mkdir / ファイル作成 / git add -f）の失敗は握り潰さない。握り潰すと、
# 出てくる NG が「壊す確認が効いていない」になり、読む側は
# gi_claude_tracked_in の pathspec や -z を疑うことになる。実際の原因
# （一時ディレクトリに書けない等）にたどり着かない。上の git init と同じく、
# 失敗したらそれと名指しする。
#
# **止まるのは以降の「壊す確認」だけである。本体は止まらない。**
# 本体（実物の $repo を問う判定）は上のとおり git init の成否と切り離してあり、
# 準備が失敗しても実行される。**ここを「以降の判定に進まない」と読んで
# 切り離しを戻さないこと**——戻すと、一時リポジトリが作れないだけで
# 「.claude/ が追跡されていないか」を一切確かめない状態に逆戻りする。
gi_claude_probe_rel='.claude/worktrees/probe/日本語の名前.md'
gi_claude_probe_ok=0
if [ "$gi_claude_repo_ok" -eq 0 ]; then
  : # 一時リポジトリが無い。下の判定で名指しする
elif ! mkdir -p "$gi_claude_repo/.claude/worktrees/probe"; then
  echo "  NG: 壊す確認の準備に失敗した（ディレクトリを作れない: $gi_claude_repo/.claude/worktrees/probe）"
  fail=1
elif ! : > "$gi_claude_repo/$gi_claude_probe_rel"; then
  echo "  NG: 壊す確認の準備に失敗した（ファイルを作れない: $gi_claude_repo/$gi_claude_probe_rel）"
  fail=1
# git -C を使う。サブシェルで cd してから git を呼ぶと、cd が落ちた場合も
# 「git add -f が失敗」と名指しすることになり、**git は一度も走っていないのに
# git を名指しする**（mktemp を「git ls-files が失敗した」と出していたのと同じ形）。
# git -C なら判定と名指しが1対1になる。
elif ! git -C "$gi_claude_repo" add -f -- "$gi_claude_probe_rel" >/dev/null; then
  echo "  NG: 壊す確認の準備に失敗した（git add -f が失敗: $gi_claude_probe_rel）"
  fail=1
else
  gi_claude_probe_ok=1
fi

if ! gi_read_into gi_claude_tracked_in "$repo"; then
  echo "  NG: .claude/ 配下の追跡状況を読み取れなかった（$gi_read_err）"
  fail=1
elif [ "${#gi_read[@]}" -gt 0 ]; then
  echo "  NG: .claude/ 配下が追跡されている: ${gi_read[*]}"
  fail=1
elif [ "$gi_claude_repo_ok" -eq 0 ]; then
  # 壊す確認には一時リポジトリが要る。0c-2 で既に NG を出しているため、
  # ここでも重ねて名指しする（本体は緑でも、壊す確認ができていない
  # ことまで緑と表示しては誤解を招く）。
  echo "  NG: 一時リポジトリが無く、壊す確認ができない（$gi_claude_repo）"
  fail=1
elif [ "$gi_claude_probe_ok" -eq 0 ]; then
  : # 準備の失敗は上で名指ししている
elif ! gi_read_into gi_claude_tracked_in "$gi_claude_repo"; then
  echo "  NG: 壊す確認の読み取りに失敗した（$gi_read_err）"
  fail=1
elif [ "${#gi_read[@]}" -ne 1 ] ||
     [ "${gi_read[0]}" != "$gi_claude_probe_rel" ]; then
  echo "  NG: 壊す確認が効いていない（期待 1 件「$gi_claude_probe_rel」/ 実際 ${#gi_read[@]} 件「${gi_read[*]}」）"
  fail=1
else
  echo "  OK"
fi


# --- 前提: .gitignore のファイル名のパターンが、値を持つかどうか判断されていること（#44）---
# **0c の突き合わせは一方向だった。** DOC_PRUNE_FILES を起点に「.gitignore に無いもの」は
# 見ていたが、**逆向き（.gitignore にあるが DOC_PRUNE_FILES に無い）は素通りしていた。**
# 実際に `*.log` と `crash.log` が片側だけになっており、**値を持つログが複製に含まれていた。**
#
# **判断そのものは機械にできない。** 「そのファイルが値を持つか」は人が決める。
# **できるのは「判断されていない行を残さないこと」だけである。**
# DOC_PRUNE_FILES（値を持つ）にも DOC_NO_VALUE_IGNORES（値を持たないと判断した）にも
# 無いパターンが .gitignore に現れたら落とす。**新しい行を足した人に、1回だけ判断させる。**
#
# **ファイルを引数で受ける**（0c-2b・0c と同じ形）。実物には何も置かずに、
# 分類の抜けを拾えることを確かめられる。
echo "0c-3. .gitignore の行が、どの一覧で扱うか決まっていること"

# 5つの向きを見る。**「あちらで扱う」と書いた先が、実際に照合されていること**まで含む。
#
#   ファイル名の行  → DOC_PRUNE_FILES（値を持つ）か DOC_NO_VALUE_IGNORES（持たないと判断した）
#   ディレクトリ行  → DOC_PRUNE_DIRS
#   打ち消し（!）   → DOC_KEEP_FILES（DOC_PRUNE_DIRS の配下を指すものは対象外）
#   逆向き          → DOC_NO_VALUE_IGNORES の各行が .gitignore に現に在ること
#
# **判断そのものは機械にできない。** できるのは「判断されていない行を残さないこと」だけである。
#
# **壊す確認を先に置く**（0c-2b と同じ理由。後に置くと、本体の指し先を取り違えても
# その時点では空で緑になり、実物を一度も見ないまま通る）。
gi3_ng=0
gi3_probe=''
gi3_probe2=''
gi3_probe3=''
gi3_probe4=''
gi3_dir=''
if ! gi3_probe=$(mktemp) || ! gi3_probe2=$(mktemp) || ! gi3_probe3=$(mktemp) ||
  ! gi3_probe4=$(mktemp) || ! gi3_dir=$(mktemp -d); then
  echo "  NG: 分類の確認用の一時ファイルを作れなかった（TMPDIR を確かめる）"
  gi3_ng=1
elif ! printf '%s\n' '# コメント' 'node_modules/' '!.env.example' '.env' \
  '*.unclassified-probe' 'probe-unlisted-dir/' '!probe-unlisted-keep' \
  '!.vscode/extensions.json' '!node_modules/keep-me' >"$gi3_probe"; then
  echo "  NG: 分類の確認用の .gitignore を書けなかった（$gi3_probe）"
  gi3_ng=1
elif ! printf '%s\n' "${DOC_NO_VALUE_IGNORES[@]:1}" >"$gi3_probe2"; then
  # 先頭の1件だけを落とした .gitignore。逆向きがその1件を拾えるはず。
  echo "  NG: 逆向きの確認用の .gitignore を書けなかった（$gi3_probe2）"
  gi3_ng=1
elif ! printf '%s\n' '**/probe-prefixed/' '!probe-prefixed/keep-me' \
  'probe-bare' '!probe-bare/keep-me' >"$gi3_probe3"; then
  # **ディレクトリ除外の綴りを2通り置く。** 上の probe とは別のファイルにする——
  # 混ぜると、他の3つの期待値（1件ずつ）が壊れて何を見ているのか読めなくなる。
  echo "  NG: 綴りの確認用の .gitignore を書けなかった（$gi3_probe3）"
  gi3_ng=1
else
  gi3_expect() { # $1=説明 $2...=期待する件（最後の引数の後ろが実際の値。-- で区切る）
    local desc="$1" gi3_w=() gi3_r=()
    shift
    while [ "$#" -gt 0 ] && [ "$1" != '--' ]; do gi3_w+=("$1"); shift; done
    shift
    gi3_r=("$@")
    [ "${gi3_w[*]}" = "${gi3_r[*]}" ] && [ "${#gi3_w[@]}" -eq "${#gi3_r[@]}" ] && return 0
    echo "  NG: $desc（期待 ${#gi3_w[@]} 件「${gi3_w[*]}」/ 実際 ${#gi3_r[@]} 件「${gi3_r[*]}」）"
    gi3_ng=1
  }
  mapfile -t gi3_g < <(doc_unclassified_ignores "$gi3_probe")
  gi3_expect "分類の抜けを拾えていない" '*.unclassified-probe' -- "${gi3_g[@]}"
  mapfile -t gi3_g < <(doc_unlisted_ignore_dirs "$gi3_probe")
  gi3_expect "一覧に無いディレクトリ行を拾えていない" 'probe-unlisted-dir/' -- "${gi3_g[@]}"
  # `!.vscode/extensions.json` は DOC_PRUNE_DIRS の配下なので落ちるはず。
  mapfile -t gi3_g < <(doc_unlisted_ignore_keeps "$gi3_probe")
  gi3_expect "一覧に無い打ち消し行を拾えていない" '!probe-unlisted-keep' -- "${gi3_g[@]}"
  mapfile -t gi3_g < <(doc_groundless_no_value "$gi3_probe2")
  gi3_expect "根拠を失った DOC_NO_VALUE_IGNORES を拾えていない" "${DOC_NO_VALUE_IGNORES[0]}" -- "${gi3_g[@]}"
  # 親が丸ごと除外されている打ち消し。probe には `node_modules/` があるため、
  # その配下の打ち消しは**永久に効かない**。
  # **`!.vscode/extensions.json` は落ちるはず**——probe に `.vscode/` の行が無いためである。
  mapfile -t gi3_g < <(doc_unreachable_keeps "$gi3_probe")
  gi3_expect "届かない打ち消しを拾えていない" '!node_modules/keep-me' -- "${gi3_g[@]}"
  # **ディレクトリ除外の綴りは1通りではない。** どちらも拾えること（#44 第7巡）。
  #   **/probe-prefixed/ … 接頭辞が付く（.gitignore の `**/generated/` がこの形）
  #   probe-bare        … 末尾の / が無い（gitignore(5) ではディレクトリにも一致する）
  mapfile -t gi3_g < <(doc_unreachable_keeps "$gi3_probe3")
  gi3_expect "ディレクトリ除外の綴り違いを拾えていない" \
    '!probe-prefixed/keep-me' '!probe-bare/keep-me' -- "${gi3_g[@]}"
  # 裸の名前が、実在するディレクトリを指しているとき（#44 第8巡）。
  # **probe のディレクトリを実際に作る。** 綴りだけでは判定できないため、
  # この関数はファイルシステムを見る。
  if mkdir -p "$gi3_dir/probe-bare-dir" &&
    printf '%s\n' 'probe-bare-dir' >"$gi3_probe4"; then
    mapfile -t gi3_g < <(doc_bare_dirs_unlisted "$gi3_probe4" "$gi3_dir")
    gi3_expect "実在するディレクトリを指す裸の名前を拾えていない" 'probe-bare-dir' -- "${gi3_g[@]}"
  else
    echo "  NG: 裸のディレクトリの確認用のファイルを作れなかった（$gi3_dir）"
    gi3_ng=1
  fi
fi

gi3_check() { # $1=関数名 $2=NG の文言 $3=直し方
  local got
  # **指し先が無ければ名指しで落とす。** 開けないファイルを渡すと出力が空になり、
  # mapfile は 0 件、この関数は何も言わずに通る——**取り違えが緑で通る。**
  if [ ! -f "$repo/.gitignore" ]; then
    echo "  NG: $repo/.gitignore を読めない。この節の結果は信用できない"
    gi3_ng=1
    return
  fi
  mapfile -t got < <("$1" "$repo/.gitignore")
  if [ "${#got[@]}" -gt 0 ]; then
    echo "  NG: $2: ${got[*]}"
    echo "        $3"
    gi3_ng=1
  fi
}
gi3_check doc_unclassified_ignores \
  '.gitignore のパターンが、値を持つかどうか判断されていない' \
  '値を持つなら DOC_PRUNE_FILES へ、持たないなら DOC_NO_VALUE_IGNORES へ足す（scripts/doc-scope.sh）。スラッシュを含む行は、先頭のディレクトリ名を DOC_PRUNE_DIRS へ足す（.gitignore の行は書き換えない）'
gi3_check doc_unlisted_ignore_dirs \
  '.gitignore のディレクトリ行が DOC_PRUNE_DIRS に無い' \
  '足さないと、その配下の Markdown が複製され、検査の対象に入る（scripts/doc-scope.sh）'
gi3_check doc_unlisted_ignore_keeps \
  '.gitignore の打ち消し行が DOC_KEEP_FILES に無い' \
  '除外から戻すなら DOC_KEEP_FILES へ足す（scripts/doc-scope.sh）。DOC_PRUNE_DIRS の配下を指すものは足さない——ディレクトリ側で先に除外されるため KEEP は届かない'
gi3_check doc_groundless_no_value \
  'DOC_NO_VALUE_IGNORES の項目が .gitignore に無い' \
  '.gitignore から消えたなら、この一覧からも消す（判断の記録が根拠を失う。scripts/doc-scope.sh）'
gi3_check doc_unreachable_keeps \
  '打ち消し（!）の親ディレクトリが丸ごと除外されていて、永久に効かない' \
  '親を dir/ ではなく dir/* にする。git は除外したディレクトリの中を列挙しないため、! で戻せない'
# **裸の名前が、実在するディレクトリを指しているとき。** gi3_check は引数を1つしか渡さないため、
# ここだけ直に呼ぶ（この関数はリポジトリのルートも要る）。
mapfile -t gi3_bare < <(doc_bare_dirs_unlisted "$repo/.gitignore" "$repo")
if [ "${#gi3_bare[@]}" -gt 0 ]; then
  echo "  NG: .gitignore の裸の名前が、実在するディレクトリを指していて DOC_PRUNE_DIRS に無い: ${gi3_bare[*]}"
  echo "        DOC_PRUNE_DIRS へ足す。あわせて .gitignore 側も末尾に / を付けて、ディレクトリだと分かる形にする"
  gi3_ng=1
fi
# **後片付けは本体の後に行う。** 先に消すと、上の注記が言う「本体の指し先の取り違え」を
# 塞げない——**消えたファイルを指しても、出力が空になって緑で通る。**
rm -f "$gi3_probe" "$gi3_probe2" "$gi3_probe3" "$gi3_probe4"
if [ "$gi3_ng" = 0 ]; then echo "  OK"; else fail=1; fi

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

# --- 前提: .claude/ の除外が、DOC_PRUNE_DIRS から消すと壊れること（#35） ------
# 「検査を足したら、それを壊す確認も足す」というこのリポジトリの決まりに従う。
# 上の 0a は probe_dirs と DOC_PRUNE_DIRS が一致することしか見ておらず、
# .claude が両方から丸ごと抜けている場合（一致はしたまま）は検出できない。
# ここでは本物の check-docs.sh を通し、.claude/ 配下に置いた壊れたリンクが
# 「除外されている間は検出されず、DOC_PRUNE_DIRS から .claude を消すと検出される」
# ことを確かめる。
#
# **この節は「0. 複製した状態で検査が通ること」より後ろに置く。** 前に置くと、
# $work 自体に .claude/ と無関係な不備があった場合でも、この節の
# 「前提が崩れている」という NG が「.claude/ の除外が効いていない」ことだと
# 誤解させる。$work が素の状態で通ることを先に確かめてから、
# .claude/ 固有の壊す確認に進む。
#
# $n は増やさない。README.md と CLAUDE.md の「check-docs.test.sh、N通り」は
# 下の expect_ng / expect_ok の呼び出し件数を宣言しており、この節はその外側の
# 前提確認である（0a・0b・0c と同じ扱い）。
echo "0d. .claude/ 配下の Markdown が、DOC_PRUNE_DIRS の .claude を消すと検出されること"
claude_probe='.claude/worktrees/probe-claude-scope/README.md'
mkdir -p "$work/$(doc_parent "$claude_probe")"
printf '%s\n' '[壊れたリンク](./does-not-exist.md)' > "$work/$claude_probe"

if ! run_check; then
  echo "  NG: 前提が崩れている（.claude/ 配下にリンク切れを置いただけで検査が落ちた。除外が効いていない）"
  (cd "$work" && bash scripts/check-docs.sh 2>&1 | sed 's/^/        実際: /')
  fail=1
else
  # 消す行は DOC_PRUNE_DIRS の要素のうちこの1行だけに一致する。
  # 置換が実際に効いたことを、cmp ではなく grep の件数で確かめる
  # （消した行が完全に無くなったことを見たいため、差分の有無だけでは足りない）。
  before=$(grep -c '^  \.claude$' "$work/scripts/doc-scope.sh")
  sed -i '/^  \.claude$/d' "$work/scripts/doc-scope.sh"
  after=$(grep -c '^  \.claude$' "$work/scripts/doc-scope.sh")
  if [ "$before" -ne 1 ] || [ "$after" -ne 0 ]; then
    echo "  NG: sed が想定どおりに .claude の行を消せていない（変更前 $before 件 / 変更後 $after 件）"
    fail=1
  else
    out=$(cd "$work" && bash scripts/check-docs.sh 2>&1); rc=$?
    expect="$claude_probe -> ./does-not-exist.md が存在しない"
    if [ "$rc" -eq 0 ]; then
      echo "  NG: DOC_PRUNE_DIRS から .claude を消しても検査が通ってしまった"
      fail=1
    elif ! printf '%s\n' "$out" | grep -qF "$expect"; then
      echo "  NG: 落ちたが、期待した指摘「$expect」が出ていない"
      printf '%s\n' "$out" | grep '^  NG' | sed 's/^/        実際: /'
      fail=1
    else
      echo "  OK"
    fi
  fi
fi
restore scripts/doc-scope.sh
rm -f "$work/$claude_probe"
rmdir "$work/.claude/worktrees/probe-claude-scope" 2>/dev/null || true
rmdir "$work/.claude/worktrees" 2>/dev/null || true
rmdir "$work/.claude" 2>/dev/null || true

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


# --- 検査0: 整形の検知
# 桁揃えは「起きたか / 起きていないか」で判定できる。壊す側は1行で足りる。
#
# **経路の読み取り（検査5）とは別に確かめる。** 桁揃えが入ると検査5 も落ちるが、
# その NG は「2.1 の表から経路を1件も読み取れない」であり、**表の中身を疑わせる。**
# 検査0 の NG が同時に出ることまで確かめないと、原因の取り違えが残る。
expect_ng "REVIEW.md の表の行を桁揃えする" REVIEW.md \
  '0,/^| 1 | \*\*一覧・取得 API\*\*/s//| 1   | **一覧・取得 API**/' \
  'REVIEW.md の表のセルが桁揃えされている' \
  '| 1   | \*\*一覧・取得 API\*\*'
# **誤検知の側は expect_ok の節で確かめる**（「セルの途中の連続空白では落ちない」）。
# 検知の範囲が「セルの終端」に限られていることは、この検査に固有の境界である。
# 対象ファイルを走査する for ループ自体は、他の検査と共有しているため個別には見ない。
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
expect_ng "features.md の「合計 39 件」を38件に" docs/features.md \
  's/\*\*合計 39 件。\*\*/**合計 38 件。**/' 'features.md の「合計 N 件」: 38 と書かれているが、実際は 39'
expect_ng "README.md の「全 39 件」を38件に" README.md \
  's/\*\*全 39 件\*\*/**全 38 件**/' 'README.md の「全 N 件」: 38 と書かれているが、実際は 39'
expect_ng "tech-stack.md の「機能39件」を35件に" docs/tech-stack.md \
  's/機能39件/機能35件/' 'tech-stack.md の「機能N件」: 35 と書かれているが、実際は 39'
# 前方に正しい数のおとりを置き、本命だけを壊す。先頭1件しか見ていないと素通りする。
expect_ng "tech-stack.md の前方におとりを置き、本命だけ35件に" docs/tech-stack.md \
  's/^## 選定の前提$/## 選定の前提\n\n（検査の検査が置いたおとり）機能39件\n/; s/機能39件、うちリアルタイム/機能35件、うちリアルタイム/' \
  'tech-stack.md の「機能N件」: 35 と書かれているが、実際は 39' '検査の検査が置いたおとり' '機能35件、うちリアルタイム'

# --- 検査3: 内訳
expect_ng "features.md の内訳を「要求 18 件」に" docs/features.md \
  's/内訳: 要求 19 件/内訳: 要求 18 件/' 'features.md の内訳「要求」: 18 と書かれているが、実際は 19'
expect_ng "features.md の前方におとりを置き、本命の内訳だけ18件に" docs/features.md \
  's/^## 機能一覧表$/## 機能一覧表\n\n（検査の検査が置いたおとり）要求 19 件\n/; s/内訳: 要求 19 件/内訳: 要求 18 件/' \
  'features.md の内訳「要求」: 18 と書かれているが、実際は 19' '検査の検査が置いたおとり' '内訳: 要求 18 件'
expect_ng "README.md の内訳を「要求 18」に" README.md \
  's/（要求 19 \/ 派生 10/（要求 18 \/ 派生 10/' 'README.md の内訳「要求」: 18 と書かれているが、実際は 19'
expect_ng "F-01 の区分を 要求→派生 に（合計は 39 のまま動かない）" docs/features.md \
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

# --- 検査が「1件も読み取れない」と言う経路。ここを踏まないと、
#     表の形が変わって検査が何も見なくなったときに気づけない。
expect_ng "features.md の 要求 の行をすべて別の区分名に書き換える" docs/features.md \
  's/^\(| F-[0-9][0-9] |[^|]*|[^|]*\)| 要求 |/\1| **要検討** |/' \
  'features.md の表から区分「要求」の行を1件も読み取れない'
expect_ng "F-01 の区分だけを未知の区分名にする（合計は 39 のまま動かない）" docs/features.md \
  's/^\(| F-01 |[^|]*|[^|]*\)| 要求 |/\1| **要検討** |/' \
  '内訳の合計 38 件が機能数 39 件と一致しない'
expect_ng "features.md の機能IDの接頭辞を F- から G- に変える" docs/features.md \
  's/^| F-\([0-9][0-9]\) |/| G-\1 |/' \
  '機能一覧表から機能IDを1件も読み取れない'
expect_ng "requirements.md の一覧の見出しを変えて読み取れなくする" docs/requirements.md \
  's/^#### 必ずテストを書く箇所$/#### 必ずテストを書く項目/' \
  'requirements.md から一覧を読み取れない'

# --- 検査5: 「N経路」（実体は REVIEW.md 2.1 の表）
# 経路が1つ欠けたまま実装されると認可の穴になる。表と宣言の両側から壊す。
expect_ng "REVIEW.md 2.1 の表から経路を1行消す" REVIEW.md \
  '/^| 2 | \*\*検索\*\* |/d' \
  'REVIEW.md の「N経路すべてを塞ぐ」: 4 と書かれているが、実際は 3'
expect_ng "REVIEW.md の見出しの「4経路」を3経路に" REVIEW.md \
  's/4経路すべてを塞ぐ/3経路すべてを塞ぐ/' \
  'REVIEW.md の「N経路すべてを塞ぐ」: 3 と書かれているが、実際は 4'
expect_ng "REVIEW.md の「経路は4つある」を3つに" REVIEW.md \
  's/経路は4つある/経路は3つある/' \
  'REVIEW.md の「経路はNつある」: 3 と書かれているが、実際は 4'
expect_ng "requirements.md の「4経路すべてを塞いで」を3経路に" docs/requirements.md \
  's/の4経路\*\*すべてを塞いで/の3経路**すべてを塞いで/' \
  'requirements.md の「N経路すべてを塞いで」: 3 と書かれているが、実際は 4'
# 同じ文書の「残る2経路」は4のうち2という別の数である。ここが NG にならないことは
# 「requirements.md の『4経路すべてを塞いで』を3経路に」のケースが通ること自体が
# 示している（まとめて拾う実装なら 2 で落ちる）。
expect_ng "requirements.md の「4経路のうち」を3経路に" docs/requirements.md \
  's/4経路のうち/3経路のうち/' \
  'requirements.md の「N経路のうち」: 3 と書かれているが、実際は 4'
# 文書の外にある5箇所目の宣言。ここが古くなる帰結は、AI レビュアーが誤った経路数を
# 最優先の観点として渡され続けることであり、文書の不整合より重い。
expect_ng "claude_code_review.yml の「認可4経路」を3経路に" .github/workflows/claude_code_review.yml \
  's/認可4経路を最優先/認可3経路を最優先/' \
  'claude_code_review.yml の「認可N経路」: 3 と書かれているが、実際は 4' \
  '認可3経路を最優先'
expect_ng "REVIEW.md 2.1 の見出しを変えて表を読み取れなくする" REVIEW.md \
  's/^### 2\.1 認可/### 2-1 認可/' \
  'REVIEW.md 2.1 の表から経路を1件も読み取れない' '^### 2-1 認可'
# 経路は数だけでなく名前も突き合わせる。数が動かない壊し方を、表側と宣言側の両方から踏む。
# 「検索 → 全文検索」を選んでいるのは意図的である。包含（grep -qF）で見る実装だと
# 「検索」が「全文検索」に含まれるため素通りする。集合で見ていることをこの2件が確かめる。
expect_ng "REVIEW.md 2.1 の表の経路名を1つ書き換える（4行のまま動かない）" REVIEW.md \
  's/^| 2 | \*\*検索\*\* |/| 2 | **全文検索** |/' \
  'REVIEW.md 2.1 の表と requirements.md で経路の名前が違う' '\*\*全文検索\*\*'
expect_ng "requirements.md の列挙の経路名を1つ書き換える（4経路のまま動かない）" docs/requirements.md \
  's|一覧・取得 API / 検索 /|一覧・取得 API / 全文検索 /|' \
  'REVIEW.md 2.1 の表と requirements.md で経路の名前が違う' '/ 全文検索 /'
expect_ng "requirements.md の列挙の言い回しを変えて行を読み取れなくする" docs/requirements.md \
  's/の4経路\*\*すべてを塞いで/の4つの経路**すべてを塞いで/' \
  'requirements.md の経路を列挙している行を読み取れない' '4つの経路'
# 前方に正しい4名を並べたおとりの列挙行を置き、本命の名前だけを差し替える。
# 先頭1件しか見ていないと、検査対象がおとりに移って本命が無検査で通る
# （検査3・4のおとりのケースと同型）。
expect_ng "requirements.md の前方におとりの列挙行を置き、本命の名前だけ差し替える" docs/requirements.md \
  's|^> \*\*派-3 と 派-8 は同じ性質の問題である。\*\*|> **一覧・取得 API / 検索 / 添付ファイルの配信 / WebSocket の配信の4経路**すべてを塞いで初めて成立する。（検査の検査が置いたおとり）\n>\n> **派-3 と 派-8 は同じ性質の問題である。**|; s|一覧・取得 API / 検索 / 添付ファイルの配信 / WebSocket の配信の4経路\*\*すべてを塞いで$|一覧・取得 API / 全文検索 / 添付ファイルの配信 / WebSocket の配信の4経路**すべてを塞いで|' \
  'REVIEW.md 2.1 の表と requirements.md で経路の名前が違う' \
  '検査の検査が置いたおとり' '/ 全文検索 /'

# --- 検査5: 「N種類」（実体は requirements.md 4.1 のイベント表。#9 で1つに寄せた）
# イベント名は表の中でバッククォートに囲まれている。sed 式に直接書くと
# SC2016（単一引用符の中では展開されない）を shellcheck が出すため、文字を変数に逃がす。
# \140 は8進数のバッククォート。
bt=$'\140'
# **表が features.md に戻ったことを見る。** 戻ると検査は requirements.md 側だけを数え続け、
# 2つが食い違っても緑で通る。#9 で消した重複が黙って復活する経路であり、
# 復活そのものを検知しないと、以前の壊れ方（説明と注記の食い違い）がそのまま戻る。
# **書式の無い表が features.md に戻された場合も検知すること。**
# 以前は events() の結果が空かどうかで見ていたため、**コード書式で書かれていない表は
# 空を返し、「戻っている」の NG が出なかった。** 行の数で見る形に変えた。
expect_ng "features.md 5.1 に、コード書式の無いイベント表を戻す" docs/features.md \
  's/^\*\*この7種類以外の変化は即時反映されない。\*\*$/| イベント | 内容 |\n|---|---|\n| message:new | メッセージの新規投稿 |\n\n**この7種類以外の変化は即時反映されない。**/' \
  'features.md 5.1 にイベント表が戻っている' \
  '| message:new | メッセージの新規投稿 |'
expect_ng "features.md 5.1 にイベント表を戻す" docs/features.md \
  "s/^\*\*この7種類以外の変化は即時反映されない。\*\*$/| イベント | 内容 |\n|---|---|\n| ${bt}message:new${bt} | メッセージの新規投稿 |\n\n**この7種類以外の変化は即時反映されない。**/" \
  'features.md 5.1 にイベント表が戻っている' "| ${bt}message:new${bt} |"
# **書式を付け忘れた行が、黙って読み飛ばされないこと。**
# events() はコード書式（`…`）で始まる行だけを拾う。付け忘れた行は rows に入らず、
# **kinds は変わらないため各文書の「N種類」の宣言とも一致し、すべて緑のままずれる。**
# 全滅（kinds が 0）は「読み取れない」の分岐が捕まえるが、**半分しか読めない場合はそこを通らない。**
expect_ng "requirements.md のイベント表に、コード書式の無い行を1つ足す" docs/requirements.md \
  "/^| ${bt}presence:changed${bt} |/a\| notification:new | 通知（コード書式の付け忘れ） |" \
  'requirements.md のイベント表に読み取れない行がある' \
  '| notification:new |'
expect_ng "requirements.md のイベント表から1行消す" docs/requirements.md \
  "/^| ${bt}unread:updated${bt} |/d" \
  'CLAUDE.md の「イベント定義（N種類）」: 7 と書かれているが、実際は 6'
# 宣言は6箇所にあり、場所ごとに別のパターンで拾う。1箇所ずつ壊して、
# その箇所の compare_decls が本当に配線されていることを見る。
# まとめて拾う実装に戻すと、無関係な「N種類」で偽の NG が出る側に戻る。
expect_ng "CLAUDE.md の「7種類」を6種類に" CLAUDE.md \
  's/イベント定義（7種類）/イベント定義（6種類）/' \
  'CLAUDE.md の「イベント定義（N種類）」: 6 と書かれているが、実際は 7'
expect_ng "requirements.md の「4.1 の7種類」を6種類に" docs/requirements.md \
  's/（4.1 の7種類）/（4.1 の6種類）/' \
  'requirements.md の「4.1 のN種類」: 6 と書かれているが、実際は 7'
expect_ng "features.md の「7種類のイベントを配信」を6種類に" docs/features.md \
  's/7種類のイベントを配信/6種類のイベントを配信/' \
  'features.md の「N種類のイベントを配信」: 6 と書かれているが、実際は 7'
expect_ng "features.md の「この7種類以外」を6種類に" docs/features.md \
  's/この7種類以外/この6種類以外/' \
  'features.md の「このN種類以外」: 6 と書かれているが、実際は 7'
expect_ng "tech-stack.md の「7種類の WebSocket イベント」を6種類に" docs/tech-stack.md \
  's/7種類の WebSocket イベント/6種類の WebSocket イベント/' \
  'tech-stack.md の「N種類の WebSocket イベント」: 6 と書かれているが、実際は 7'
expect_ng "tech-stack.md の「7種類のイベント定義」を6種類に" docs/tech-stack.md \
  's/7種類のイベント定義/6種類のイベント定義/' \
  'tech-stack.md の「N種類のイベント定義」: 6 と書かれているが、実際は 7'
# **小見出しの下に表を戻しても落ちること**（#129）。
# table_lines の終端が「あらゆる見出し」だと、5.1 の中に小見出しを1つ置いた時点で
# exit するため行数が 0 のままになり、「表が戻っている」の NG が出ない。
expect_ng "features.md 5.1 の小見出しの下にイベント表を戻す" docs/features.md \
  "s/^\\*\\*この7種類以外の変化は即時反映されない。\\*\\*$/#### 一覧\n\n| イベント | 内容 |\n|---|---|\n| ${bt}message:new${bt} | メッセージの新規投稿 |\n\n**この7種類以外の変化は即時反映されない。**/" \
  'features.md 5.1 にイベント表が戻っている' "#### 一覧"

# **5.1 の外に表を置いても落ちること**（#121）。
# table_lines は節の中しか見ない。コメントは「features.md に表が戻っていないことも見る」と
# 書いており、**主張の範囲が実装より広かった。**
expect_ng "features.md 5.1 の外（5.2 の中）にイベント表を置く" docs/features.md \
  "s/^### 5.2 受け入れ条件$/### 5.2 受け入れ条件\n\n| イベント | 内容 |\n|---|---|\n| ${bt}message:new${bt} | メッセージの新規投稿 |/" \
  'features.md にイベント名の表の行がある' "### 5.2 受け入れ条件"

# **5.1 から requirements.md への参照を消しても落ちること**（#122）。
# #119 が確定した不変条件は「5.1 は参照だけを持つ」である。表が無いことだけを見ると、
# **参照そのものを消しても緑で通り、5.1 はどこにも一覧が無い節になる。**
# **sed の範囲は 5.1 の中に限る。** `s|A|B|` は全行に当たり、features.md にある
# 30箇所以上の `[要件定義書](requirements.md)` をすべて消してしまう。それだと
# 「**5.1 の中に**参照がある」ことを固定できず、節スコープの照合を
# `grep -q requirements.md docs/features.md` に退化させても、このケースは緑で通る。
expect_ng "features.md 5.1 から requirements.md への参照を消す" docs/features.md \
  "/^### 5\\.1 配信するイベント$/,/^### 5\\.2 /s|\\[要件定義書\\](requirements.md)|要件定義書|" \
  'features.md 5.1 に requirements.md へのリンクが無い' "**一覧は 要件定義書 4.1"

# **1行に2つ並べた行だけを外に置いても落ちること**（#121 の続き）。
# 4.1 の表は `typing:start` / `typing:stop` を1行に並べている。パターンが末尾の
# 「` |`」まで要求すると**この行に一致せず**、7行目だけを外に置いたときに 0 を返す。
# **検査が「見ている」と表示したまま見ていない状態であり、偽の緑である。**
expect_ng "features.md 5.1 の外に、1行に2つ並べたイベントの行を置く" docs/features.md \
  "s@^### 5.2 受け入れ条件\$@### 5.2 受け入れ条件\n\n| イベント | 内容 |\n|---|---|\n| ${bt}typing:start${bt} / ${bt}typing:stop${bt} | 入力中インジケータ |@" \
  'features.md にイベント名の表の行がある' "typing:start"

# **`#####` を置いても落ちること**（#129 の続き）。
# 終端を「`####` 以外の見出し」と書くと、`^#### ` は5文字目が空白であることを要求するため
# `##### 一覧` に一致せず、**そこで exit する。** `####` だけが節の中で、`#####` 以下は終端のままだった。
# features.md は現に `#####` を使っている。**終端は、節の見出しと同じ深さか、それより浅い見出しである**（`sec_body`）。
expect_ng "features.md 5.1 の ##### の下にイベント表を戻す" docs/features.md \
  "s/^\\*\\*この7種類以外の変化は即時反映されない。\\*\\*$/##### 一覧\n\n| イベント | 内容 |\n|---|---|\n| message:new | メッセージの新規投稿 |\n\n**この7種類以外の変化は即時反映されない。**/" \
  'features.md 5.1 にイベント表が戻っている' "##### 一覧"

# **features.md 以外へ表を置いても落ちること**（#182）。
# 不変条件は「表は requirements.md 4.1 の1つだけである」であり、**見る先を features.md に
# 限ると、主張より実装の範囲が狭い。** tech-stack.md は現に「7種類の WebSocket イベント」を
# 語る文書で、一覧の置き場として現実に起こりうる。走査を全 Markdown へ広げた形を固定する。
expect_ng "tech-stack.md にイベント表を置く" docs/tech-stack.md \
  "s/^## 全体構成\$/## 全体構成\n\n| イベント | 内容 |\n|---|---|\n| ${bt}message:new${bt} | メッセージの新規投稿 |/" \
  'tech-stack.md にイベント名の表の行がある' "message:new"

# **requirements.md の別の節へ複製しても落ちること**（#182）。
# 上の全 Markdown の走査は requirements.md だけを飛ばす（4.1 に本物の表があるため）。
# **飛ばしたままだと、同じ文書の別の節へ複製されても素通りする。**
# 全体の行数と 4.1 の中の行数を突き合わせる形を固定する。
expect_ng "requirements.md 4.1 の外にイベント表を複製する" docs/requirements.md \
  "s/^### 4.2 可用性\$/### 4.2 可用性\n\n| イベント | 内容 |\n|---|---|\n| ${bt}message:new${bt} | メッセージの新規投稿 |/" \
  'requirements.md の 4.1 の外にイベント名の表の行がある' "### 4.2 可用性"

# **コード書式を落とした表でも落ちること**（#182 第6巡）。
# 上の2件はどちらもバッククォート付きで壊している。**パターンが書式を必須にしていると、
# 書式を落とした表は素通りする**——同じファイルの `table_lines` の注記が
# 「行の数で見る。events() の結果で見ない」として、5.1 の中では同じ経路を塞いでいた。
# **その防御は 5.1 の中にしか無く、全 Markdown の走査は書式に依存したままだった。**
expect_ng "tech-stack.md にコード書式の無いイベント表を置く" docs/tech-stack.md \
  "s/^## 全体構成\$/## 全体構成\n\n| イベント | 内容 |\n|---|---|\n| message:new | メッセージの新規投稿 |/" \
  'tech-stack.md にイベント名の表の行がある' "| message:new |"
expect_ng "requirements.md 4.1 の外にコード書式の無いイベント表を複製する" docs/requirements.md \
  "s/^### 4.2 可用性\$/### 4.2 可用性\n\n| イベント | 内容 |\n|---|---|\n| message:new | メッセージの新規投稿 |/" \
  'requirements.md の 4.1 の外にイベント名の表の行がある' "| message:new |"

# **features.md 5.1 の見出しも、変えたら落ちること。**
# events() は見出しに一致しなければ何も返さず、それは「表が無い」と区別できない。
# 見出しを改名すると、上の「表が戻っている」のガードは NG を出さずに死ぬ（偽の緑）。
# **表を落としたこの PR では、requirements.md 側にしか読み取り失敗の確認が無かった。**
expect_ng "features.md 5.1 の見出しを変えて、表の復活を検知できなくする" docs/features.md \
  's/^### 5\.1 配信するイベント$/### 5.1 リアルタイムで配信するイベント/' \
  'features.md の「5.1 配信するイベント」の節が見つからない' \
  '^### 5\.1 リアルタイムで配信するイベント'
expect_ng "requirements.md のイベント表の見出しを変えて読み取れなくする" docs/requirements.md \
  's/^#### リアルタイム配信の対象イベント$/#### 配信するイベント/' \
  'requirements.md からイベント表を読み取れない' '^#### 配信するイベント'

# --- 節の切り出しを sec_body に寄せたことの確認（#182 第5巡）。
#     items と route_names は「あらゆる見出しで終端」のまま残っていた。
#     **小見出しを1つ置くと節が空になり、「1件も読み取れない」という
#     別の NG に化ける**——受け取った側は壊れていない側を疑うことになる。
#     壊し方を「小見出しを置く」だけにすると検査は緑のままで確認にならないため、
#     **小見出しと同時に中身を1つ壊し、本来の NG がそのまま出ることを見る。**
expect_ng "REVIEW.md 2.1 に小見出しを置き、同時に経路名を1つ書き換える" REVIEW.md \
  's/^### 2\.1 認可 — プライベートチャンネルは4経路すべてを塞ぐ$/### 2.1 認可 — プライベートチャンネルは4経路すべてを塞ぐ\n\n#### 経路の一覧/; s/^| 2 | \*\*検索\*\* |/| 2 | **全文検索** |/' \
  'REVIEW.md 2.1 の表と requirements.md で経路の名前が違う' '#### 経路の一覧' '\*\*全文検索\*\*'
expect_ng "REVIEW.md の必須の一覧に小見出しを置き、同時に1項目を書き換える" REVIEW.md \
  's/^### テストが必須の箇所$/### テストが必須の箇所\n\n#### 一覧/; s/^4\. \*\*WebSocket が許可外の Origin からのハンドシェイクを拒否すること\*\*$/4. **WebSocket の接続数に上限があること**/' \
  'requirements.md と REVIEW.md で一覧の内容が違う' '#### 一覧' 'WebSocket の接続数に上限があること'

# --- 5.1 の参照が 4.1 を指していることの確認（#182 第5巡）。
#     文字列 requirements.md があるだけでは、4.8 を指すリンクでも通る。
#     NG の文言は「一覧への導線が消える」と主張しており、
#     **導線が 4.1 に届くことまでが主張である。**
expect_ng "features.md 5.1 の参照の指し先を 4.1 から 4.8 に変える" docs/features.md \
  's|4\.1「リアルタイム配信の対象イベント」|4.8「開発方式」|' \
  'features.md 5.1 の参照が 4.1 の節を指していない' '4.8「開発方式」'


# **リンクを素の言及に変えても落ちること**（#182 第7巡）。
# 文字列 `requirements.md` があるだけでは通ってしまう。**素の言及は導線ではない。**
# 検査1（相対リンクの検証）はリンクの先の存在しか見ないため、ここが見なければ誰も見ない。
expect_ng "features.md 5.1 の参照を、リンクではない素の言及にする" docs/features.md \
  "/^### 5\.1 配信するイベント\$/,/^### 5\.2 /s|\[要件定義書\](requirements.md)|要件定義書 requirements.md|" \
  'features.md 5.1 に requirements.md へのリンクが無い' "要件定義書 requirements.md 4.1"

# --- 落ちてはならないこと。$4 で、置いたファイルが検査の対象に入るはず（in）か
#     除外されるはず（out）かを切り替える。関数を2つに分けると、失敗時の出力や
#     後片付けに手を入れたとき片方が黙って取り残される（doc-scope.sh 冒頭と同じ理由）。
#     判定は doc_find -name '*.md' に統一する。検査1が見るのは Markdown だけである。
expect_ok() { # $1=説明 $2=作るファイル $3=中身 $4=in（検査の対象に入る）| out（除外される）
              # $5...=併せて置くファイル（リンク先にする実体。既に $work にあれば
              #        作らず・消さず・空にもせず、そのまま使う。下の注記を参照）
  local desc="$1" file="$2" body="$3" want="$4" got extra
  shift 4
  local made=("$work/$file")
  n=$((n + 1))
  mkdir -p "$work/$(doc_parent "$file")"
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
  # $file と違い $extra は複製済みの木に既にありうる（.env.example がまさにその候補）。
  # そのときは作らず・消さずにそのまま使う。$extra に求めているのは
  # 「リンク先の実体が存在すること」だけで、複製されたものはそれを満たす。
  #
  # 既にある場合を失敗にしてはならない。.env.example は DOC_KEEP_FILES にあるため
  # doc_find の対象に入り、冒頭の複製ループで $work に入る。つまり
  # リポジトリに .env.example が置かれた瞬間、「KEEP に挙げた .env.example へのリンクは
  # 『リンク先にできない』にならない」のケースは本体まで到達せず落ちる。
  # KEEP に .env.example を挙げている理由自体が「README から参照されやすい」であり、
  # そのケースが想定している状況がまさに来たときに検査が落ちる、という向きになる。
  #
  # 上書きもしてはならない。本物を空に切り詰めたうえで消してしまい、以降のケースが
  # 「.env.example が消えた木」の上で黙って別物になる（expect_ng の restore と違い
  # 元に戻らない）。made に入れないことで、後片付けの対象からも外す。
  for extra in "$@"; do
    [ -e "$work/$extra" ] && continue
    mkdir -p "$work/$(doc_parent "$extra")"
    : > "$work/$extra"
    made+=("$work/$extra")
  done
  # 置いたファイルが想定した側にあることを先に確かめる。逆側に落ちると
  # 「検査が落ちない」ことに意味が無くなり、ケースは静かに無効化される。
  if (cd "$work" && doc_find -name '*.md' -print | sed 's|^\./||' | grep -qxF -- "$file"); then
    got=in
  else
    got=out
  fi
  if [ "$got" != "$want" ]; then
    echo "  NG: $n. $desc — 置いたファイルが $want ではなく $got の側にある。ケースが成立していない"
    fail=1; rm -f "${made[@]}"; return
  fi
  if run_check; then
    echo "  OK: $n. $desc"
  else
    echo "  NG: $n. $desc — 落ちてはならないのに検査が落ちた"
    (cd "$work" && bash scripts/check-docs.sh 2>&1 | grep '^  NG' | sed 's/^/        実際: /')
    fail=1
  fi
  rm -f "${made[@]}"
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

# **先頭が - の Markdown がルート直下に置かれても、偽のリンク切れを出さないこと**（#47）。
# doc_find の出力は `sed 's|^\./||'` を通るため、**ルート直下では素の名前になる。**
# **どのコマンドが option と解釈するかは、実測した**（gawk 5.4.0 / GNU coreutils）。
#   dirname "-x.md"        → unknown option -- x（失敗）
#   grep -o 'x' -x.md      → unknown option -- .（失敗。**`.` である。`k` ではない**——測り直した）
#   awk '{print}' -x.md    → **読めた（exit 0）。option と解釈しない**
# **awk は落ちない。** プログラム文字列より後ろは operand として扱われるためである。
# `./` を前置しているのは**1つの書き方で揃えるため**であって、awk が壊れるからではない。
# **awk の実測は gawk 5.4.0 で取った。CI が走らせるのは ubuntu-latest の既定 awk（mawk）であり、
# そちらは未確認である。** mawk が option と解釈するなら `./` の前置が現に効いていることになり、
# 記述の向きだけが変わる（`./` を外す変更はしていないため、どちらでも壊れない）。
#
# **塞ぐ前の帰結**（実測: `dirname "-x.md"` は `unknown option -- x` で終了コード 1）:
# 検査1 が `/docs/requirements.md` という**絶対パス**を見に行き、
# **そのファイルの相対リンクが全件「存在しない」で NG になる。**
# 文面は「リンク切れ」と読めるため、**受け取った側は壊れていないリンクの方を疑う。**
#
# **ルート直下でなければ再現しない。** `docs/-x.md` なら `${p##*/}` の前に `docs/` が付く。
expect_ok "先頭が - の Markdown をルート直下に置いても、リンク切れにならない" -probe-dash.md \
  '[README](README.md)' in

# 先頭が - の Markdown を**置いて**、期待する NG が出ることを見る（#47）。
#
# **expect_ng では書けない。** あちらは複製済みの追跡ファイルを sed で壊す形であり、
# **このケースが要るのは「置いた新しいファイルの名前そのもの」**である。
# 0d と同じ形（置いて回して文言を突き合わせる）を、名前を引数に取れるようにした。
expect_ng_new() { # $1=説明 $2=作るファイル $3=中身 $4=NG に含まれるべき文言
  local desc="$1" file="$2" body="$3" expect="$4" out rc
  n=$((n + 1))
  mkdir -p "$work/$(doc_parent "$file")"
  printf '%s\n' "$body" >"$work/$file"
  # 置けたことを先に確かめる。置けていないと検査は当然通り、
  # 「落ちるべきなのに通った」という別の原因を疑わせる NG になる（expect_ok と同じ理由）。
  if [ ! -f "$work/$file" ]; then
    echo "  NG: $n. $desc — ファイルを置けていない。ケースが成立していない"
    fail=1
    return
  fi
  out=$(cd "$work" && bash scripts/check-docs.sh 2>&1)
  rc=$?
  rm -f "$work/$file"
  if [ "$rc" -eq 0 ]; then
    echo "  NG: $n. $desc — 落ちるべきなのに検査が通った"
    fail=1
  # **grep に -- を付ける。** $expect は先頭が - になりうる。
  # **この PR が直している穴そのものを、このヘルパー自身が踏んだ**——
  # 出力に文言があるのに「出ていない」と報告された（実測）。
  elif ! printf '%s\n' "$out" | grep -qF -- "$expect"; then
    echo "  NG: $n. $desc — 落ちたが、期待した指摘「$expect」が出ていない"
    printf '%s\n' "$out" | grep '^  NG' | sed 's/^/        実際: /'
    fail=1
  else
    echo "  OK: $n. $desc"
  fi
}

# **束の適用先は3つあるが、落ちる条件を持てるのは2つである。**
# 「先頭が - の Markdown をルート直下に置いても、リンク切れにならない」のケースが
# 与えているのは doc_parent の1つだけなので、検査1 の grep にも条件を与える。
#
# **なぜそのケースだけでは足りないか。** 検査1 の grep を素の "$f" に戻すと、
# grep が失敗してリンクを1件も返さず、while の本体に入らない。
# **NG が出ないためそのケースは「OK」と表示する。**
# しかもその状態では doc_parent を dirname に戻しても NG が出ない——
# **grep 側が壊れると、この束の唯一の落ちる条件まで一緒に消える。**
#
# **検査0 の awk には条件を与えない。与えられない。**
# awk は先頭が - のファイルを option と解釈しない（上の実測）。
# `./` を外しても落ちないため、**落ちる条件の無い確認になる。**
# このファイルが繰り返し禁じてきた形なので、置かない。
expect_ng_new "先頭が - の Markdown の壊れたリンクを、検査1 が見つける" -probe-dash-link.md \
  '[存在しない](./does-not-exist.md)' \
  '-probe-dash-link.md -> ./does-not-exist.md が存在しない'


# 検査0 の境界。**見るのは「セルの終端の連続空白」だけで、セルの途中の連続空白は見ない。**
# ここを広げると、本文にたまたま連続空白が入った表が NG になり、
# 「整形された」という誤った原因を出す。整形ツールは終端を埋めるのであって、途中は埋めない。
expect_ok "表のセルの途中に連続空白があっても、整形とみなさない" docs/probe-table-spacing.md \
  '| 見出し | 説明 |
|---|---|
| 値  の途中に連続空白がある | 終端の空白は1つ |' in
# KEEP の分岐（PRUNE に一致しても除外しない）を、doc_excluded の委譲と
# check-docs.sh の検査1 まで通して踏む唯一のケース。
#
# 0a にも KEEP の確認があるが、あちらは doc_excluded_name を単体で呼ぶだけであり、
# doc_excluded が委譲していることも、検査1 がその結果でリンクを NG にすることも見ていない。
# 判定関数が正しくても、委譲や呼び出しが外れれば同じ穴が開く。守備範囲が違う。
#
# doc-scope.sh は「.env.example は README から参照されやすいため除外から外している」と
# 目的まで宣言している。ここを踏まないと、README が .env.example を参照した瞬間に
# 正当なリンクが「リンク先にできない」で NG になる。
#
# ケースが成立していることを先に見る。対象が PRUNE のパターンに一致しなければ、
# KEEP が無くてもこのリンクは通る。つまり KEEP を何も検査していないことになる。
#
# 名前は1箇所に置く。成立判定・説明文・リンク本文・$extra に別々に書くと、
# 成立判定だけがケースの触っていない名前を見ることになり、落ちる条件が消える。
keep_pruned=0
keep_target=.env.example   # case の対象を変数にする（定数を直接書くと shellcheck SC2194）
for g in "${DOC_PRUNE_FILES[@]}"; do
  # shellcheck disable=SC2254
  case "$keep_target" in $g) keep_pruned=1 ;; esac
done
if [ "$keep_pruned" = 0 ]; then
  echo "  NG: $keep_target が DOC_PRUNE_FILES のどれにも一致しない。KEEP を踏むケースが成立していない"
  fail=1
fi
expect_ok "KEEP に挙げた $keep_target へのリンクは「リンク先にできない」にならない" \
  probe-env-example-link.md "[環境変数の例]($keep_target)" in "$keep_target"

# $extra の「既にあればそのまま使う」分岐に落ちる条件を持たせる。
#
# 分岐が外れると `: >` で空に切り詰めたうえ made 経由で消される。
# 「KEEP に挙げた .env.example へのリンクは『リンク先にできない』にならない」のケースは
# リンク先が存在しさえすれば通るため、切り詰めても消されても緑のままである。
# 実体が元のままであることを見るのは、ここだけである。
#
# 名前は1箇所に置く。呼び出しと cmp に別々に書くと、片方だけ差し替えたときに
# cmp がケースの触っていないファイルを比べ、落ちる条件が消える。
existing_target=package.json   # DOC_PRUNE_DIRS にも DOC_PRUNE_FILES にも当たらず、複製ループで必ず $work に入る
expect_ok "既に複製にある実体をリンク先にしても、その実体を壊さない" \
  probe-existing-target.md "[ルートの $existing_target]($existing_target)" in "$existing_target"
if ! cmp -s "$repo/$existing_target" "$work/$existing_target"; then
  echo "  NG: 既に \$work にあった $existing_target が壊れた（\$extra を上書き・削除している）"
  fail=1
fi

# $extra の「作る側」に落ちる条件を持たせる。
#
# 上の2つの $extra は複製ループが $work に入れるため、どちらも `[ -e ] && continue` を通る。
# mkdir -p / `: >` / made+= の3行は一度も実行されない。**丸ごと削っても、
# made+= だけを落としても、全ケースが緑で通る。** made+= が落ちた形は特に静かで、
# 作った $extra が $work に残り続け、以降のケースが前のケースの置き土産の上で回る。
#
# 複製ループが拾わない名前を渡す。リポジトリに実在せず、
# DOC_PRUNE_DIRS にも DOC_PRUNE_FILES にも当たらない綴りである。
#
# **階層を1つ持たせる。** ルート直下の名前だと doc_parent が `.` を返し、
# mkdir -p が `$work/.`（既にある）になって何もしないため、その1行だけを削っても
# このケースが緑で通る。階層があれば、削った時点で `: >` が失敗して落ちる。
fresh_target='probe-fresh-dir/target.txt'
expect_ok "複製に無い実体をリンク先にすると、置かれて、後片付けされる" \
  probe-fresh-target.md "[新しく置く実体]($fresh_target)" in "$fresh_target"
if [ -e "$work/$fresh_target" ]; then
  echo "  NG: $fresh_target が \$work に残っている（made に入れていない）"
  fail=1
fi

# --- 「N通り」の宣言が実数と一致すること -------------------------------------
# check-docs.sh の3章は「合計 N 件」「全 N 件」「機能N件」を照合するが、
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
