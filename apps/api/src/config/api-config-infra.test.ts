import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { API_SETTINGS } from './api-config';

// secret: true の設定は、本番で Parameter Store の暗号化パラメータと ECS の secrets で渡す（api-config.ts の Setting の注記）。
// Terraform の側を直し忘れても terraform validate は落ちず、apply の後のタスクの起動で初めて落ちる。environment に誤って書くと、
// 落ちずに秘密が平文でタスク定義に残る（#483）。API_SETTINGS と infra/production の3箇所——タスク定義の secrets・
// 実行ロールの ssm:GetParameters の resources・aws_ssm_parameter——が揃っていることを、Terraform のファイルを読んで確かめる。
// **読めない書き方を、黙って数え上げから外さずに落とす**——environment の側は「含まない」の否定形のため、取りこぼすと緑のまま通る。
// そのため、コメントを除いてから読み、**すべてのタスク定義の、同じキーのすべてのリストの、すべての要素**を数え上げる。

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

const terraform = withoutComments(
  readdirSync(infraDir)
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

/** 本文の中の `<key> = [ … ]` のリスト**すべて**の要素（最初の1つだけを読まない）。 */
function itemsOf(body: string, key: string): string[] {
  return [...body.matchAll(new RegExp(`\\b${key}\\s*=\\s*\\[`, 'g'))].flatMap((match) =>
    splitItems(enclosed(body, match.index + match[0].length - 1)),
  );
}

/** `{ name = "…", … }` の要素の name（読めなければ undefined）。 */
function nameOf(item: string): string | undefined {
  return /\bname\s*=\s*"([^"]+)"/.exec(item)?.[1];
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
    env: nameOf(item),
    parameter: /\bvalueFrom\s*=\s*aws_ssm_parameter\.(\w+)\.arn\b/.exec(item)?.[1],
  })),
);
const environment = taskDefinitions.flatMap(({ name: task, body }) =>
  itemsOf(body, 'environment').map((item) => ({ task, item, env: nameOf(item) })),
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

  it('実行ロールが読めるパラメータは、タスク定義の secrets が指すパラメータとちょうど同じである', () => {
    expect(executionResources.map(({ parameter }) => parameter).sort()).toEqual(
      [...new Set(secrets.map(({ parameter }) => parameter))].sort(),
    );
  });

  it.each(secretEnvs)(
    '%s を渡すパラメータは、その名前で終わる暗号化パラメータ（SecureString）である',
    (env) => {
      const parameter = secrets.find((secret) => secret.env === env)?.parameter;
      expect(parameter).toBeDefined();
      const body = block('resource', 'aws_ssm_parameter', parameter ?? '');
      expect(/\bname\s*=\s*"([^"]+)"/.exec(body)?.[1]).toMatch(new RegExp(`/${env}$`));
      const type = /\btype\s*=\s*(\S+)/.exec(body)?.[1];
      const resolved =
        type === 'local.parameter_type'
          ? /\bparameter_type\s*=\s*"([^"]+)"/.exec(terraform)?.[1]
          : type?.replaceAll('"', '');
      expect(resolved).toBe('SecureString');
    },
  );
});
