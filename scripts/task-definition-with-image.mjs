// `aws ecs describe-task-definition --include TAGS --output json` の出力（標準入力）から、イメージのタグだけを
// 引数のタグに替えた `register-task-definition --cli-input-json` の入力を作る（#688。scripts/deploy-staging.sh が使う）。
//
// 踏むと壊れる: 登録の結果にしか無い項目（下の RESULT_ONLY）を入力に残すと、AWS が登録を断る。
// タグの無いイメージ（digest で指定したものなど）は差し替えずに落とす——どこを替えるかが決まらない。
import { readFileSync } from 'node:fs';

const RESULT_ONLY = [
  'taskDefinitionArn',
  'revision',
  'status',
  'requiresAttributes',
  'compatibilities',
  'registeredAt',
  'registeredBy',
  'deregisteredAt',
];

const tag = process.argv[2];
if (!tag || !/^[\w][\w.-]{0,127}$/.test(tag)) {
  console.error(`イメージのタグとして使えない: ${tag ?? '（無し）'}`);
  process.exit(1);
}

const described = JSON.parse(readFileSync(0, 'utf8'));
const input = { ...described.taskDefinition };
for (const key of RESULT_ONLY) delete input[key];

input.containerDefinitions = input.containerDefinitions.map((container) => {
  // リポジトリの部分（レジストリのホストの :ポート を含みうる）の後ろの、最後の :タグ だけを替える。
  const match = /^([^@]+\/[^/:@]+):[\w][\w.-]*$/.exec(container.image);
  if (!match) {
    console.error(`タグの付いたイメージではない: ${container.image}`);
    process.exit(1);
  }
  return { ...container, image: `${match[1]}:${tag}` };
});

if (described.tags?.length) input.tags = described.tags;

process.stdout.write(JSON.stringify(input));
