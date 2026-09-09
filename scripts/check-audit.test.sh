#!/usr/bin/env bash
# check-audit.mjs が「落ちるべきときに落ちる」ことを確かめる。
#
# なぜ要るか。check-audit.mjs は **audit の合否を決める実装**であり、
# ここが黙って通すようになると、**脆弱性に気づく唯一の経路が形だけになる**
# （audit.yml の冒頭）。正常系を1回通すだけでは、それは分からない。
#
# **特に 2 の側（許可した id が出なくなったら落ちる）が要である。**
# あれが効かないと、上流が直っても許可が残り続け、「通している」ことを忘れる。
# そして**そのとき CI は緑のまま**であり、誰も気づかない。
#
# 方針: 合成した npm audit の出力と、合成した許可一覧を一時ディレクトリに置いて回す。
# 許可一覧はスクリプトと同じディレクトリから読まれるため、スクリプトごと複製する。
# **本物の scripts/audit-allowlist.json は書き換えない。**
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
repo=$(pwd)

fail=0
work=$(mktemp -d)
# 後片付けはしない。CI のランナーは実行のたびに作り直され、手元では TMPDIR に
# 残るだけで害が無い。プロジェクトの禁止事項により rm -rf は使わない。
echo "作業ディレクトリ: $work"
cp "$repo/scripts/check-audit.mjs" "$work/check-audit.mjs"

# 期待する終了コードと突き合わせる。
# **「落ちた」だけでは足りない。** 引数の誤り（2）と検査の失敗（1）を取り違えると、
# 「検査が動いていない」を「脆弱性がある」と読んでしまう。
expect() {
  local name=$1 want=$2 report=$3
  node "$work/check-audit.mjs" "$report" >"$work/out.txt" 2>&1
  local got=$?
  if [ "$got" = "$want" ]; then
    echo "  OK: $name（exit $got）"
  else
    echo "  NG: $name — exit $want を期待したが $got だった"
    sed 's/^/      /' "$work/out.txt"
    fail=1
  fi
}

# 許可一覧を置き換える。id を並べるだけでよい。
set_allow() {
  local ids=("$@")
  {
    printf '{ "allow": ['
    local first=1
    for id in "${ids[@]}"; do
      [ $first = 1 ] || printf ','
      first=0
      printf '{"id":"%s","package":"p","title":"t","issue":1,"until":"u","reason":"r"}' "$id"
    done
    printf '] }\n'
  } > "$work/audit-allowlist.json"
}

# 許可一覧をそのまま書く（形の検査用）。
set_allow_raw() { printf '%s
' "$1" > "$work/audit-allowlist.json"; }

# npm audit --json の出力を合成する。`id:severity` の並びを受け取る。
# via には文字列（別のパッケージ経由）が混ざる。**本物と同じ形にしておく**——
# 混ざらない形で試すと、文字列を物として読む欠陥を見逃す。
make_report() {
  local out=$1; shift
  {
    printf '{"auditReportVersion":2,"vulnerabilities":{"p":{"name":"p","severity":"high","via":["other-package"'
    for spec in "$@"; do
      printf ',{"source":1,"name":"p","dependency":"p","title":"題名 %s","url":"https://github.com/advisories/%s","severity":"%s","range":"<1.0.0"}' \
        "${spec%%:*}" "${spec%%:*}" "${spec##*:}"
    done
    printf ']}}}\n'
  } > "$out"
}

echo "1. 許可していない high が残っていれば落ちる"
set_allow
make_report "$work/r.json" "GHSA-aaaa-aaaa-aaaa:high"
expect "許可外の high" 1 "$work/r.json"

echo "2. 許可した id が出力に現れなければ落ちる（上流が直った合図）"
set_allow "GHSA-bbbb-bbbb-bbbb"
make_report "$work/r.json"
expect "許可の消し忘れ" 1 "$work/r.json"

echo "3. 許可した high が出ていれば通る"
set_allow "GHSA-aaaa-aaaa-aaaa"
make_report "$work/r.json" "GHSA-aaaa-aaaa-aaaa:high"
expect "許可どおり" 0 "$work/r.json"

echo "4. critical も落とす（high だけを見ていないこと）"
set_allow
make_report "$work/r.json" "GHSA-cccc-cccc-cccc:critical"
expect "許可外の critical" 1 "$work/r.json"

echo "5. moderate 以下は落とさない（閾値の位置）"
set_allow
make_report "$work/r.json" "GHSA-dddd-dddd-dddd:moderate" "GHSA-eeee-eeee-eeee:low"
expect "moderate と low だけ" 0 "$work/r.json"

echo "6. 脆弱性が1件も無く、許可も空なら通る"
set_allow
printf '{"auditReportVersion":2,"vulnerabilities":{}}\n' > "$work/r.json"
expect "検出ゼロ" 0 "$work/r.json"

echo "7. 許可外の high と、許可の消し忘れが同時にあっても落ちる"
set_allow "GHSA-bbbb-bbbb-bbbb"
make_report "$work/r.json" "GHSA-aaaa-aaaa-aaaa:high"
expect "両方同時" 1 "$work/r.json"

echo "8. 出力が JSON として読めなければ落ちる（registry の障害）"
set_allow
printf 'npm ERR! network timeout\n' > "$work/broken.json"
expect "JSON でない" 2 "$work/broken.json"

echo "9. 出力ファイルが無ければ落ちる"
set_allow
expect "ファイルが無い" 2 "$work/does-not-exist.json"

echo "10. 引数が無ければ落ちる"
set_allow
node "$work/check-audit.mjs" >"$work/out.txt" 2>&1
got=$?
if [ "$got" = 2 ]; then
  echo "  OK: 引数なし（exit 2）"
else
  echo "  NG: 引数なし — exit 2 を期待したが $got だった"
  fail=1
fi

echo "11. 本物の許可一覧が、本物の出力に対して通ること"
# **合成だけで終えない。** 合成の形が本物とずれていると、全ケースが緑のまま
# 本物では動かない状態になる。ここだけは本物の scripts/ を使う。
if npm audit --json > "$work/real.json" 2>/dev/null; [ -s "$work/real.json" ]; then
  node "$repo/scripts/check-audit.mjs" "$work/real.json" >"$work/out.txt" 2>&1
  got=$?
  if [ "$got" = 0 ]; then
    echo "  OK: 本物（exit 0）"
  else
    echo "  NG: 本物 — exit 0 を期待したが $got だった"
    echo "      **許可外の high が増えた可能性がある。npm audit の出力を先に読むこと。**"
    echo "      **壊れているのは判定ではなく依存かもしれない。**"
    sed 's/^/      /' "$work/out.txt"
    fail=1
  fi
else
  echo "  NG: npm audit --json の出力が空だった（registry に届いていない可能性）"
  fail=1
fi

echo "12. 監査レポートの形をしていない JSON は落ちる（偽の緑を作らない）"
# **JSON として読めることは、監査が走ったことを意味しない。**
# npm audit が失敗すると {"error": {...}} を返すことがあり、これは JSON として読める。
# 素通りすると「検出 0 件」になり、**許可一覧が空のときに exit 0** になる——
# 脆弱性に気づく唯一の経路が、監査が1件も走っていない状況で緑を返す。
# **許可一覧を空にして試す。** 空でないと stale 側が発火して、別の理由で落ちてしまう。
set_allow
printf '{"error":{"code":"ENETUNREACH","summary":"request to registry failed"}}
' > "$work/r.json"
expect "npm audit の error 応答" 2 "$work/r.json"

set_allow
printf '{}
' > "$work/r.json"
expect "空の JSON" 2 "$work/r.json"

set_allow
printf '{"vulnerabilities":{}}
' > "$work/r.json"
expect "auditReportVersion が無い" 2 "$work/r.json"

set_allow
printf '{"auditReportVersion":2}
' > "$work/r.json"
expect "vulnerabilities が無い" 2 "$work/r.json"

echo "13. 許可一覧の形が違えば落ちる（終了コードの契約を両方の入力で守る）"
make_report "$work/r.json" "GHSA-aaaa-aaaa-aaaa:high"
set_allow_raw '{"allow":{}}'
expect "allow が配列でない" 2 "$work/r.json"
set_allow_raw '{}'
expect "allow が無い" 2 "$work/r.json"
set_allow_raw '{"allow":["not-an-object"]}'
expect "行が物でない" 2 "$work/r.json"

echo "14. 許可行に期限・イシュー参照が無ければ落ちる"
set_allow_raw '{"allow":[{"id":"GHSA-aaaa-aaaa-aaaa","package":"p","issue":1}]}'
expect "until が無い" 2 "$work/r.json"
set_allow_raw '{"allow":[{"id":"GHSA-aaaa-aaaa-aaaa","package":"p","until":"u"}]}'
expect "issue が無い" 2 "$work/r.json"
set_allow_raw '{"allow":[{"id":"GHSA-aaaa-aaaa-aaaa","package":"p","until":"","issue":1}]}'
expect "until が空文字" 2 "$work/r.json"
# **4項目すべてを壊す。** id と package を落とさないと、REQUIRED からその2つを
# 外しても全ケースが緑のまま通る（合成行も本物の許可一覧も両方を持っているため）。
# **id を必須から外すと allowed のキーが undefined になり、stale 側が発火して
# 「上流が直った合図」という誤った案内で exit 1 になる。** その経路も塞ぐ。
set_allow_raw '{"allow":[{"package":"p","until":"u","issue":1}]}'
expect "id が無い" 2 "$work/r.json"
set_allow_raw '{"allow":[{"id":"GHSA-aaaa-aaaa-aaaa","until":"u","issue":1}]}'
expect "package が無い" 2 "$work/r.json"

echo "15. 許可した advisory の重大度が下がっても、一覧に出る"
# **合否は変わらない。** 変わるのは「通している」ことが人に見えるかどうかである。
set_allow "GHSA-aaaa-aaaa-aaaa"
make_report "$work/r.json" "GHSA-aaaa-aaaa-aaaa:moderate"
node "$work/check-audit.mjs" "$work/r.json" >"$work/out.txt" 2>&1
got=$?
if [ "$got" = 0 ] && grep -q "GHSA-aaaa-aaaa-aaaa" "$work/out.txt"; then
  echo "  OK: moderate に下がっても一覧に出る（exit 0）"
else
  echo "  NG: moderate に下がった許可が一覧から消えた（exit $got）"
  sed 's/^/      /' "$work/out.txt"
  fail=1
fi

echo ""
if [ "$fail" = 0 ]; then
  echo "check-audit.mjs の壊す確認を 24 通りすべて通過しました"
else
  echo "check-audit.mjs の壊す確認に失敗があります"
fi
exit "$fail"
