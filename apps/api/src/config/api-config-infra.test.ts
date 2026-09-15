import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { API_SETTINGS } from './api-config';

// secret: true の設定は、本番で Parameter Store の暗号化パラメータと ECS の secrets で渡す（api-config.ts の Setting の注記）。
// Terraform の側を直し忘れても terraform validate は落ちず、apply の後のタスクの起動で初めて落ちる。environment に誤って書くと、
// 落ちずに秘密が平文でタスク定義に残る（#483）。API_SETTINGS と infra/production の3箇所——api のタスク定義の secrets・
// 実行ロールの ssm:GetParameters の resources・aws_ssm_parameter——が揃っていることを、Terraform のファイルを読んで確かめる。

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

/** `<key> = [ … ]` のリストの本文（中に `]` を含まないリストだけを読む）。 */
function list(body: string, key: string): string {
  const match = new RegExp(`\\b${key} = \\[([^\\]]*)\\]`).exec(body);
  if (match?.[1] === undefined) throw new Error(`${key} のリストが無い`);
  return match[1];
}

const secretEnvs = Object.values(API_SETTINGS)
  .filter((setting) => setting.secret)
  .map((setting) => setting.env)
  .sort();

const apiTask = block('resource', 'aws_ecs_task_definition', 'api');
const secretsList = list(apiTask, 'secrets');
const secrets = [
  ...secretsList.matchAll(/\{ name = "(\w+)", valueFrom = aws_ssm_parameter\.(\w+)\.arn \}/g),
].map(([, env, parameter]) => ({ env: env ?? '', parameter: parameter ?? '' }));
const environmentNames = [...list(apiTask, 'environment').matchAll(/\bname = "(\w+)"/g)].map(
  ([, env]) => env ?? '',
);
const executionParameters = [
  ...list(
    block('data', 'aws_iam_policy_document', 'task_execution_parameters'),
    'resources',
  ).matchAll(/aws_ssm_parameter\.(\w+)\.arn/g),
]
  .map(([, parameter]) => parameter ?? '')
  .sort();

describe('secret: true の設定と、Terraform での秘密の渡し方', () => {
  // 数え上げが空で通らないように。
  it('数え上げる対象がある', () => {
    expect(secretEnvs.length).toBeGreaterThanOrEqual(3);
    expect(environmentNames.length).toBeGreaterThanOrEqual(1);
  });

  it('api のタスク定義の secrets は、secret: true の設定とちょうど同じ名前を持つ', () => {
    // 読み取りの形から外れた書き方の行が、数え上げから黙って漏れないように。
    expect(secrets).toHaveLength(secretsList.split('{').length - 1);
    expect(secrets.map(({ env }) => env).sort()).toEqual(secretEnvs);
  });

  it('api のタスク定義の environment に、secret: true の設定を書かない', () => {
    expect(environmentNames.filter((env) => secretEnvs.includes(env))).toEqual([]);
  });

  it('実行ロールが読めるパラメータは、api のタスク定義の secrets が指すパラメータとちょうど同じである', () => {
    expect(executionParameters).toEqual(
      [...new Set(secrets.map(({ parameter }) => parameter))].sort(),
    );
  });

  it.each(secretEnvs)(
    '%s を渡すパラメータは、その名前で終わる暗号化パラメータ（SecureString）である',
    (env) => {
      const parameter = secrets.find((secret) => secret.env === env)?.parameter;
      expect(parameter).toBeDefined();
      const body = block('resource', 'aws_ssm_parameter', parameter ?? '');
      expect(/\bname += "([^"]+)"/.exec(body)?.[1]).toMatch(new RegExp(`/${env}$`));
      const type = /\btype += (\S+)/.exec(body)?.[1];
      const resolved =
        type === 'local.parameter_type'
          ? /\bparameter_type += "([^"]+)"/.exec(terraform)?.[1]
          : type?.replaceAll('"', '');
      expect(resolved).toBe('SecureString');
    },
  );
});
