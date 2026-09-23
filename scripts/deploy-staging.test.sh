#!/usr/bin/env bash
# scripts/deploy-staging.sh（CD がステージングへ出す手順。#688）が、落ちるべきときに落ち、順番を守ることを確かめる。
#
# なぜ要るか。この手順は main へのマージのたびに、人の確認なしで動く。**順番を誤ると、マイグレーションの前に
# 新しいコードが古い DB で動き、マイグレーションが落ちてもサービスが新しい版に切り替わる。** 本物の AWS に当てて
# 確かめることは CI ではできないため、偽の aws コマンドで、どの呼び出しがどの順に出たかを見る。
#
# 方針: PATH の先頭に偽の aws を置き、呼び出しを記録して、場面ごとの決めた値を返す。本物の AWS には何も送らない。
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
repo=$(pwd)

fail=0
work=$(mktemp -d)
# 後片付けはしない（CI のランナーは実行のたびに作り直される。rm -rf はプロジェクトの禁止事項）。
echo "作業ディレクトリ: $work"
mkdir -p "$work/bin" "$work/dist/assets"
echo '<!doctype html>' >"$work/dist/index.html"
echo 'console.log(1)' >"$work/dist/assets/index-abc.js"

cat >"$work/bin/aws" <<'FAKE'
#!/usr/bin/env bash
# 偽の aws。呼び出しを1行ずつ記録し、場面（FAKE_*）に応じた値を返す。
echo "$*" >>"$FAKE_LOG"
args="$*"
case "$1 $2" in
  "sts get-caller-identity") echo 111122223333 ;;
  "ecs describe-clusters") echo "$FAKE_CLUSTER_STATUS" ;;
  "ecs describe-services")
    case "$args" in
      *taskDefinition*) echo "arn:aws:ecs:ap-northeast-1:111122223333:task-definition/workspace-chat-staging-api:7" ;;
      *networkConfiguration*) echo '{"awsvpcConfiguration":{"subnets":["subnet-1"],"securityGroups":["sg-1"],"assignPublicIp":"ENABLED"}}' ;;
    esac
    ;;
  "ecs describe-task-definition")
    case "$args" in *migrate*) family=workspace-chat-staging-migrate ;; *) family=workspace-chat-staging-api ;; esac
    image="111122223333.dkr.ecr.ap-northeast-1.amazonaws.com/${family#workspace-chat-staging-}${FAKE_IMAGE_SUFFIX}"
    cat <<JSON
{"taskDefinition":{"taskDefinitionArn":"arn:aws:ecs:ap-northeast-1:111122223333:task-definition/${family}:7","family":"${family}","revision":7,"status":"ACTIVE","containerDefinitions":[{"name":"app","image":"${image}"}],"cpu":"256","memory":"512","requiresAttributes":[],"compatibilities":["FARGATE"],"registeredAt":"2026-09-23T00:00:00Z","registeredBy":"x"},"tags":[{"key":"Environment","value":"staging"}]}
JSON
    ;;
  "ecs register-task-definition")
    file=$(printf '%s\n' "$@" | sed -n 's|^file://||p')
    n=$(($(ls "$FAKE_DIR"/registered-*.json 2>/dev/null | wc -l) + 1))
    cp "$file" "$FAKE_DIR/registered-$n.json"
    family=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).family)' "$file")
    echo "arn:aws:ecs:ap-northeast-1:111122223333:task-definition/${family}:8"
    ;;
  "ecs run-task") echo "arn:aws:ecs:ap-northeast-1:111122223333:task/workspace-chat-staging/t1" ;;
  "ecs describe-tasks") echo "$FAKE_MIGRATION_EXIT" ;;
  "cloudfront list-distributions") echo "EDIST123" ;;
  "cloudfront create-invalidation") echo "INV1" ;;
esac
exit 0
FAKE
chmod +x "$work/bin/aws"

# 場面を1つ流す。$1 名前、$2 手順の引数、残りは FAKE_* の代入。出力と記録は $work/<名前>/ に置く。
run() {
  local name=$1 mode=$2
  shift 2
  local dir="$work/$name"
  mkdir -p "$dir"
  : >"$dir/aws.log"
  env PATH="$work/bin:$PATH" FAKE_LOG="$dir/aws.log" FAKE_DIR="$dir" \
    FAKE_CLUSTER_STATUS=ACTIVE FAKE_MIGRATION_EXIT=0 FAKE_IMAGE_SUFFIX=":old123" \
    IMAGE_TAG=new456 WEB_DIST="$work/dist" "$@" \
    bash "$repo/scripts/deploy-staging.sh" "$mode" >"$dir/out.txt" 2>&1
  echo $? >"$dir/exit"
}

ok() { echo "  OK: $1"; }
ng() {
  echo "  NG: $1"
  sed 's/^/      /' "$2/out.txt"
  fail=1
}
# 記録の中で、パターンに当たる最初の行の番号（無ければ 0）。
line_of() { grep -nE "$2" "$1/aws.log" | head -1 | cut -d: -f1 | grep . || echo 0; }

echo "== 1. ステージングが立っていなければ、飛ばして成功で終わる"
run absent-exists exists FAKE_CLUSTER_STATUS=None
d="$work/absent-exists"
[ "$(cat "$d/exit")" = 0 ] && [ "$(tail -1 "$d/out.txt")" = false ] &&
  ok "exists は false を出して exit 0" || ng "exists は false を出して exit 0 のはず" "$d"
run absent-deploy deploy FAKE_CLUSTER_STATUS=None
d="$work/absent-deploy"
[ "$(cat "$d/exit")" = 0 ] && ! grep -qE 'register-task-definition|update-service|run-task|s3 ' "$d/aws.log" &&
  ok "deploy も何も変えずに exit 0" || ng "立っていないのに何かを変えた、または落ちた" "$d"

echo "== 2. 立っていれば、新しいイメージでマイグレーション → サービスの更新 → web の順に出す"
run normal deploy
d="$work/normal"
[ "$(cat "$d/exit")" = 0 ] && ok "exit 0" || ng "exit 0 のはず" "$d"
for f in "$d"/registered-*.json; do
  image=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).containerDefinitions[0].image)' "$f")
  case "$image" in
    *:new456) ok "登録したタスク定義のイメージが新しいタグ（$(basename "$f")）" ;;
    *) ng "登録したタスク定義のイメージが新しいタグでない: $image" "$d" ;;
  esac
  # 登録の入力に、登録の結果にしか無い項目を渡すと AWS が断る。
  if node -e 'const t=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); process.exit(["taskDefinitionArn","revision","status","requiresAttributes","compatibilities","registeredAt","registeredBy"].some(k=>k in t)?1:0)' "$f"; then
    ok "登録の入力に結果の項目が無い（$(basename "$f")）"
  else
    ng "登録の入力に結果の項目が残っている（$(basename "$f")）" "$d"
  fi
done
[ "$(ls "$d"/registered-*.json | wc -l)" = 2 ] && ok "api と migrate の2つを登録" || ng "登録は2つのはず" "$d"
migrate=$(line_of "$d" 'ecs run-task .*workspace-chat-staging-migrate:8')
update=$(line_of "$d" 'ecs update-service .*workspace-chat-staging-api:8')
web=$(line_of "$d" 's3 cp .*index.html')
cleanup=$(line_of "$d" 's3 sync .*--delete')
invalidate=$(line_of "$d" 'cloudfront create-invalidation .*EDIST123')
[ "$migrate" -gt 0 ] && [ "$update" -gt "$migrate" ] && ok "マイグレーション（新しい版）の後にサービスを新しい版へ更新" ||
  ng "マイグレーション（$migrate 行目）の後にサービスの更新（$update 行目）が来るはず" "$d"
[ "$web" -gt "$update" ] && [ "$invalidate" -gt "$web" ] && [ "$cleanup" -gt "$invalidate" ] &&
  ok "サービスの後に web を置き、無効化の後で古い資産を消す" || ng "web の置き方の順番が違う（$web / $invalidate / $cleanup）" "$d"
grep -qE 'run-task .*--network-configuration .*subnet-1' "$d/aws.log" &&
  ok "マイグレーションはサービスと同じネットワークで動かす" || ng "run-task にサービスのネットワークの設定が渡っていない" "$d"

echo "== 3. マイグレーションが落ちたら、サービスも web も更新しない"
run migration-fails deploy FAKE_MIGRATION_EXIT=1
d="$work/migration-fails"
[ "$(cat "$d/exit")" != 0 ] && ! grep -qE 'update-service|s3 ' "$d/aws.log" &&
  ok "exit 0 以外で、更新は何も出ていない" || ng "マイグレーションが落ちたのに進んだ" "$d"

echo "== 4. タグの無いイメージ（digest 指定など）は差し替えずに落とす"
run digest deploy FAKE_IMAGE_SUFFIX="@sha256:abc"
d="$work/digest"
[ "$(cat "$d/exit")" != 0 ] && ! grep -qE 'register-task-definition|update-service' "$d/aws.log" &&
  ok "登録せずに落ちる" || ng "タグの無いイメージを差し替えようとした" "$d"

echo "== 5. IMAGE_TAG が無ければ何もしないで落とす"
run no-tag deploy IMAGE_TAG=
d="$work/no-tag"
[ "$(cat "$d/exit")" != 0 ] && [ ! -s "$d/aws.log" ] && ok "aws を呼ばずに落ちる" || ng "IMAGE_TAG が無いのに進んだ" "$d"

if [ "$fail" = 0 ]; then
  echo "ステージングへのデプロイの手順の検査を通過した"
else
  echo "NG: ステージングへのデプロイの手順の検査に落ちた"
  exit 1
fi
