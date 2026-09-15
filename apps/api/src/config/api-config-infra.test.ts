import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { API_SETTINGS } from './api-config';

// secret: true の設定は、本番で Parameter Store の暗号化パラメータと ECS の secrets で渡す（api-config.ts の Setting の注記）。
// Terraform の側を直し忘れても terraform validate は落ちず、apply の後のタスクの起動で初めて落ちる。environment に誤って書くと、
// 落ちずに秘密が平文でタスク定義に残る（#483）。API_SETTINGS と infra/production の3箇所——タスク定義の secrets・
// 実行ロールの ssm:GetParameters の resources・aws_ssm_parameter——が揃っていることを、Terraform のファイルを読んで確かめる。
// **読めない書き方を、黙って数え上げから外さずに落とす**——environment の側は「含まない」の否定形のため、取りこぼすと緑のまま通る。
// そのため、コメントを除いてから読み、**すべてのタスク定義の、すべてのコンテナの、同じキーのすべてのリストの、すべての要素**を数え上げ、
// **読む箇所（ファイル・ブロック・コンテナ・リスト・要素）ごとに、書き方を問わずにゆるく数えた出現と読めた出現が一致しなければ落とす**。

const infraDir = join(__dirname, '..', '..', '..', '..', 'infra', 'production');

/** 文字列（`"…"`）の外のコメント（`#`・`//` から行末まで、`/* … *\/`）を空白に置き換える（行の位置は変えない）。 */
function withoutComments(text: string): string {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i] ?? '';
    const next = text[i + 1] ?? '';
    if (inString) {
      out += char;
      if (char === '\\') {
        out += next;
        i += 1;
      } else if (char === '"') {
        inString = false;
      }
    } else if (char === '"') {
      inString = true;
      out += char;
    } else if (char === '#' || (char === '/' && next === '/')) {
      while (i < text.length && text[i] !== '\n') {
        out += ' ';
        i += 1;
      }
      out += text[i] ?? '';
    } else if (char === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end < 0 ? text.length : end + 2;
      out += text.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop - 1;
    } else {
      out += char;
    }
  }
  return out;
}

// Terraform が読むのは、ディレクトリの直下の .tf と .tf.json だけである（サブディレクトリは module で呼んだときだけ読まれる）。
const infraFiles = readdirSync(infraDir);
const terraform = withoutComments(
  infraFiles
    .filter((file) => file.endsWith('.tf'))
    .map((file) => readFileSync(join(infraDir, file), 'utf8'))
    .join('\n'),
);

/** `<kind> "<type>" "<name>" {` から、行頭の `}` までの本文を、その種類のブロックすべてについて返す。 */
function blocksOf(kind: 'resource' | 'data', type: string): { name: string; body: string }[] {
  return [...terraform.matchAll(new RegExp(`^${kind} "${type}" "(\\w+)" \\{$`, 'gm'))].map(
    (match) => ({
      name: match[1] ?? '',
      body: terraform.slice(match.index, terraform.indexOf('\n}\n', match.index)),
    }),
  );
}

function block(kind: 'resource' | 'data', type: string, name: string): string {
  const found = blocksOf(kind, type).find((candidate) => candidate.name === name);
  if (!found) throw new Error(`${kind} "${type}" "${name}" が infra/production に無い`);
  return found.body;
}

/** 文字列の外で括弧の深さを数え、`text[open]` の括弧に対応する閉じ括弧までの中身を返す。 */
function enclosed(text: string, open: number): string {
  let depth = 0;
  let inString = false;
  for (let i = open; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (char === '\\') i += 1;
      else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
    } else if (char === '[' || char === '{' || char === '(') {
      depth += 1;
    } else if (char === ']' || char === '}' || char === ')') {
      depth -= 1;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  throw new Error('括弧が閉じていない');
}

/** リストの中身を、最も外側の `,` で要素に分ける（末尾の `,` は数えない）。 */
function splitItems(inner: string): string[] {
  const items: string[] = [];
  let depth = 0;
  let inString = false;
  let start = 0;
  for (let i = 0; i < inner.length; i += 1) {
    const char = inner[i];
    if (inString) {
      if (char === '\\') i += 1;
      else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
    } else if (char === '[' || char === '{' || char === '(') {
      depth += 1;
    } else if (char === ']' || char === '}' || char === ')') {
      depth -= 1;
    } else if (char === ',' && depth === 0) {
      items.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  items.push(inner.slice(start));
  return items.map((item) => item.trim()).filter((item) => item !== '');
}

/** 属性の書き方（`key = …`・`"key" = …`・`key: …`）を問わずに、キーの出現に当たる正規表現の断片。 */
const attribute = (key: string) => `\\b${key}"?\\s*[=:]`;

/** 本文の中の `<key> = [ … ]` のリスト**すべて**の要素（最初の1つだけを読まない）。 */
function itemsOf(body: string, key: string): string[] {
  return [...body.matchAll(new RegExp(`${attribute(key)}\\s*\\[`, 'g'))].flatMap((match) =>
    splitItems(enclosed(body, match.index + match[0].length - 1)),
  );
}

function countOf(text: string, pattern: RegExp): number {
  return [...text.matchAll(pattern)].length;
}

/** 要素の中の、値が文字列の属性（読めなければ undefined）。 */
function stringAttribute(item: string, key: string): string | undefined {
  return new RegExp(`${attribute(key)}\\s*"([^"]+)"`).exec(item)?.[1];
}

const secretEnvs = Object.values(API_SETTINGS)
  .filter((setting) => setting.secret)
  .map((setting) => setting.env)
  .sort();

const taskDefinitions = blocksOf('resource', 'aws_ecs_task_definition');
const secrets = taskDefinitions.flatMap(({ name: task, body }) =>
  itemsOf(body, 'secrets').map((item) => ({
    task,
    item,
    env: stringAttribute(item, 'name'),
    parameter: new RegExp(`${attribute('valueFrom')}\\s*aws_ssm_parameter\\.(\\w+)\\.arn\\b`).exec(
      item,
    )?.[1],
  })),
);
const environment = taskDefinitions.flatMap(({ name: task, body }) =>
  itemsOf(body, 'environment').map((item) => ({ task, item, env: stringAttribute(item, 'name') })),
);
const executionResources = itemsOf(
  block('data', 'aws_iam_policy_document', 'task_execution_parameters'),
  'resources',
).map((item) => ({ item, parameter: /^aws_ssm_parameter\.(\w+)\.arn$/.exec(item)?.[1] }));

const envsOf = (task: string) =>
  secrets
    .filter((secret) => secret.task === task)
    .map(({ env }) => env)
    .sort();

describe('secret: true の設定と、Terraform での秘密の渡し方', () => {
  // 数え上げが空で通らないように。
  it('数え上げる対象がある', () => {
    expect(secretEnvs.length).toBeGreaterThanOrEqual(3);
    expect(taskDefinitions.map(({ name }) => name).sort()).toEqual(['api', 'migrate']);
    expect(environment.filter(({ task }) => task === 'api').length).toBeGreaterThanOrEqual(1);
  });

  // 読む箇所（ファイル・ブロック・コンテナ・リスト）ごとに、書き方を問わずにゆるく数えた出現と、読めた出現を突き合わせる。
  // 一致しなければ、読めない書き方（名前が \w の外・リストでない式・locals に置いたコンテナなど）があり、その中身は数え上げに入っていない。
  it('ファイル・タスク定義のブロック・コンテナ・environment / secrets・実行ロールの resources は、どれも読める書き方である（ゆるく数えた出現と読めた出現が一致する）', () => {
    // .tf.json と module は、ここで読む .tf の本文の外に構成を足す。
    expect(infraFiles.filter((file) => file.endsWith('.tf.json'))).toEqual([]);
    expect(countOf(terraform, /\bmodule\s+"/g)).toBe(0);

    expect(countOf(terraform, /\bresource\s+"aws_ecs_task_definition"/g)).toBe(
      taskDefinitions.length,
    );
    for (const { name, body } of taskDefinitions) {
      // コンテナの一覧は jsonencode([ … ]) の1つだけで、その要素はどれもオブジェクトをその場に書いたもの（local.x・関数・for で作らない）。
      const lists = [...body.matchAll(/\bcontainer_definitions\s*=\s*jsonencode\(\s*\[/g)];
      expect(countOf(body, /\bcontainer_definitions\s*=/g), name).toBe(lists.length);
      expect(lists, name).toHaveLength(1);
      const containers = lists.flatMap((match) =>
        splitItems(enclosed(body, match.index + match[0].length - 1)),
      );
      expect(
        containers.filter((container) => !(container.startsWith('{') && container.endsWith('}'))),
        name,
      ).toEqual([]);

      expect(countOf(body, new RegExp(attribute('(?:environment|secrets)'), 'g')), name).toBe(
        countOf(body, new RegExp(`${attribute('(?:environment|secrets)')}\\s*\\[`, 'g')),
      );
    }
    expect(
      countOf(terraform, /\bdata\s+"aws_iam_policy_document"\s+"task_execution_parameters"/g),
    ).toBe(1);
    const policy = block('data', 'aws_iam_policy_document', 'task_execution_parameters');
    expect(countOf(policy, new RegExp(attribute('resources'), 'g'))).toBe(
      countOf(policy, new RegExp(`${attribute('resources')}\\s*\\[`, 'g')),
    );
  });

  it('タスク定義の environment・secrets と実行ロールの resources の要素は、どれも読める（読めない要素を黙って外さない）', () => {
    expect(environment.filter(({ env }) => env === undefined).map(({ item }) => item)).toEqual([]);
    expect(
      secrets
        .filter(({ env, parameter }) => env === undefined || parameter === undefined)
        .map(({ item }) => item),
    ).toEqual([]);
    expect(
      executionResources.filter(({ parameter }) => parameter === undefined).map(({ item }) => item),
    ).toEqual([]);
  });

  it('api のタスク定義の secrets は、secret: true の設定とちょうど同じ名前を持つ', () => {
    expect(envsOf('api')).toEqual(secretEnvs);
  });

  // service.tf の「踏むと壊れる」: マイグレーション用のタスク定義は運用者が ECS Exec で入る先であり、DATABASE_URL のほかを渡さない。
  it('マイグレーション用のタスク定義の secrets は DATABASE_URL だけである', () => {
    expect(envsOf('migrate')).toEqual(['DATABASE_URL']);
  });

  it('どのタスク定義の environment にも、secret: true の設定を書かない', () => {
    expect(
      environment
        .filter(({ env }) => env !== undefined && secretEnvs.includes(env))
        .map(({ task, env }) => `${task}: ${env}`),
    ).toEqual([]);
  });

  it('task_execution_parameters のポリシーが読めるパラメータは、タスク定義の secrets が指すパラメータとちょうど同じである', () => {
    expect(executionResources.map(({ parameter }) => parameter).sort()).toEqual(
      [...new Set(secrets.map(({ parameter }) => parameter))].sort(),
    );
  });

  // 実行ロールが読める秘密の範囲は、ポリシーの中身だけでなく、実行ロールに結び付くものすべてで決まる（付け替え・2つ目の結び付きも含む）。
  it('実行ロールに結び付くのは ECS の管理ポリシーと task_execution_parameters のポリシーの2つだけで、パラメータを読む操作を与えるのはそのポリシーの ssm:GetParameters だけである', () => {
    // 実行ロールへの参照は、この2つの結び付きと、タスク定義の execution_role_arn だけである（足した・付け替えた結び付きは数が合わない）。
    expect(countOf(terraform, /\baws_iam_role\.task_execution\b/g)).toBe(
      2 + countOf(terraform, /\bexecution_role_arn\s*=\s*aws_iam_role\.task_execution\.arn\b/g),
    );
    // ロール名の文字列で結び付けると、参照の数に現れない。ロール名は自分のブロックの1箇所だけに書き、role を文字列で書かない。
    // ロールのブロックの中で結び付ける引数（managed_policy_arns・inline_policy）も使わない。
    const executionRole = block('resource', 'aws_iam_role', 'task_execution');
    const executionRoleName = stringAttribute(executionRole, 'name') ?? '';
    expect(executionRoleName).not.toBe('');
    expect(terraform.split(`"${executionRoleName}"`).length - 1).toBe(1);
    expect(countOf(terraform, new RegExp(`${attribute('roles?')}\\s*\\[?\\s*"`, 'g'))).toBe(0);
    expect(
      countOf(executionRole, new RegExp(attribute('(?:managed_policy_arns|inline_policy)'), 'g')) +
        countOf(executionRole, /\binline_policy\s*\{/g),
    ).toBe(0);
    const managed = block('resource', 'aws_iam_role_policy_attachment', 'task_execution_managed');
    expect(managed).toMatch(/\brole\s*=\s*aws_iam_role\.task_execution\.name\b/);
    expect(/\bpolicy_arn\s*=\s*"([^"]+)"/.exec(managed)?.[1]).toBe(
      'arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy',
    );
    const parameters = block('resource', 'aws_iam_role_policy', 'task_execution_parameters');
    expect(parameters).toMatch(/\brole\s*=\s*aws_iam_role\.task_execution\.id\b/);
    expect(parameters).toMatch(
      /\bpolicy\s*=\s*data\.aws_iam_policy_document\.task_execution_parameters\.json\b/,
    );
    const policy = block('data', 'aws_iam_policy_document', 'task_execution_parameters');
    expect(countOf(policy, /\bstatement\s*\{/g)).toBe(1);
    expect(itemsOf(policy, 'actions')).toEqual(['"ssm:GetParameters"']);
    // パラメータを読む操作は、ほかのどのポリシーにも書かない（コメントは除いてから数える）。
    expect(countOf(terraform, /ssm:GetParameter/g)).toBe(1);
  });

  // 名前ごとに最初の1件だけを見ると、2つ目のタスク定義の同じ名前の要素が照合されない。secrets の要素すべてを照合する。
  it.each(secrets.map(({ task, env, parameter }) => [task, env ?? '', parameter ?? ''] as const))(
    '%s の %s を渡すパラメータ（%s）は、その名前で終わる暗号化パラメータ（SecureString）である',
    (_task, env, parameter) => {
      expect(parameter).not.toBe('');
      const body = block('resource', 'aws_ssm_parameter', parameter);
      expect(stringAttribute(body, 'name')).toMatch(new RegExp(`/${env}$`));
      const type = new RegExp(`${attribute('type')}\\s*(\\S+)`).exec(body)?.[1];
      const resolved =
        type === 'local.parameter_type'
          ? new RegExp(`${attribute('parameter_type')}\\s*"([^"]+)"`).exec(terraform)?.[1]
          : type?.replaceAll('"', '');
      expect(resolved).toBe('SecureString');
    },
  );
});
