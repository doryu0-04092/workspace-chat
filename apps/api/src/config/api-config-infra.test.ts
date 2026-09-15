import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { API_SETTINGS } from './api-config';

// secret: true の設定は、本番で Parameter Store の暗号化パラメータと ECS の secrets で渡す（api-config.ts の Setting の注記）。
// Terraform の側を直し忘れても terraform validate は落ちず、apply の後のタスクの起動で初めて落ちる。environment に誤って書くと、
// 落ちずに秘密が平文でタスク定義に残る（#483）。API_SETTINGS と infra/production の3箇所——api のタスク定義の secrets・
// 実行ロールの ssm:GetParameters の resources・aws_ssm_parameter——が揃っていることを、Terraform のファイルを読んで確かめる。
// **読めない書き方の要素は、黙って数え上げから外さずに落とす**——environment の側は「含まない」の否定形のため、取りこぼすと緑のまま通る。

const infraDir = join(__dirname, '..', '..', '..', '..', 'infra', 'production');
const terraform = readdirSync(infraDir)
  .filter((file) => file.endsWith('.tf'))
  .map((file) => readFileSync(join(infraDir, file), 'utf8'))
  .join('\n');

/** `<kind> "<type>" "<name>" {` から、行頭の `}` までの本文。 */
function block(kind: 'resource' | 'data', type: string, name: string): string {
  const start = terraform.indexOf(`${kind} "${type}" "${name}" {`);
  if (start < 0) throw new Error(`${kind} "${type}" "${name}" が infra/production に無い`);
  return terraform.slice(start, terraform.indexOf('\n}\n', start));
}

/** 文字列（`"…"`）の外で括弧の深さを数え、`text[open]` の括弧に対応する閉じ括弧までの中身を返す。 */
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

/** `<key> = [ … ]` のリストの要素（最も外側の `,` で区切る。末尾の `,` は数えない）。 */
function listItems(body: string, key: string): string[] {
  const match = new RegExp(`\\b${key}\\s*=\\s*\\[`).exec(body);
  if (!match) throw new Error(`${key} のリストが無い`);
  const inner = enclosed(body, match.index + match[0].length - 1);
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

/** `{ name = "…", … }` の要素の name（読めなければ undefined）。 */
function nameOf(item: string): string | undefined {
  return /\bname\s*=\s*"([^"]+)"/.exec(item)?.[1];
}

const secretEnvs = Object.values(API_SETTINGS)
  .filter((setting) => setting.secret)
  .map((setting) => setting.env)
  .sort();

const apiTask = block('resource', 'aws_ecs_task_definition', 'api');
const secrets = listItems(apiTask, 'secrets').map((item) => ({
  item,
  env: nameOf(item),
  parameter: /\bvalueFrom\s*=\s*aws_ssm_parameter\.(\w+)\.arn\b/.exec(item)?.[1],
}));
const environment = listItems(apiTask, 'environment').map((item) => ({ item, env: nameOf(item) }));
const executionResources = listItems(
  block('data', 'aws_iam_policy_document', 'task_execution_parameters'),
  'resources',
).map((item) => ({ item, parameter: /^aws_ssm_parameter\.(\w+)\.arn$/.exec(item)?.[1] }));

describe('secret: true の設定と、Terraform での秘密の渡し方', () => {
  // 数え上げが空で通らないように。
  it('数え上げる対象がある', () => {
    expect(secretEnvs.length).toBeGreaterThanOrEqual(3);
    expect(environment.length).toBeGreaterThanOrEqual(1);
  });

  it('api のタスク定義の environment と secrets の要素は、どれも name を読める（読めない要素を黙って外さない）', () => {
    expect(environment.filter(({ env }) => env === undefined).map(({ item }) => item)).toEqual([]);
    expect(secrets.filter(({ env }) => env === undefined).map(({ item }) => item)).toEqual([]);
  });

  it('api のタスク定義の secrets は、secret: true の設定とちょうど同じ名前を持ち、どれもパラメータの ARN を指す', () => {
    expect(secrets.map(({ env }) => env).sort()).toEqual(secretEnvs);
    expect(
      secrets.filter(({ parameter }) => parameter === undefined).map(({ item }) => item),
    ).toEqual([]);
  });

  it('api のタスク定義の environment に、secret: true の設定を書かない', () => {
    expect(
      environment
        .map(({ env }) => env)
        .filter((env) => env !== undefined && secretEnvs.includes(env)),
    ).toEqual([]);
  });

  it('実行ロールが読めるパラメータは、api のタスク定義の secrets が指すパラメータとちょうど同じである', () => {
    expect(
      executionResources.filter(({ parameter }) => parameter === undefined).map(({ item }) => item),
    ).toEqual([]);
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
