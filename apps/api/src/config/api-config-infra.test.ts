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
// コンテナの属性のキーは許可したものだけにする（秘密を渡す別の経路を、キーを1つずつ禁じる形では塞ぎ切れないため）。

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

/**
 * `<kind> "<type>" "<name>" {` から、行頭の `}` までの本文を、その種類のブロックすべてについて返す（`type` は正規表現の断片）。
 * 中身の無いブロック（`{}` の1行）は、見出しの行の `{` までを本文にする。
 */
function blocksOf(
  kind: 'resource' | 'data',
  type: string,
  source: string = terraform,
): { type: string; name: string; body: string }[] {
  return [...source.matchAll(new RegExp(`^${kind} "(${type})" "(\\w+)" \\{(\\})?$`, 'gm'))].map(
    (match) => ({
      type: match[1] ?? '',
      name: match[2] ?? '',
      body:
        match[3] === undefined
          ? source.slice(match.index, source.indexOf('\n}\n', match.index))
          : match[0].slice(0, -1),
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

/** オブジェクト・ブロック（`{ … }`）の最も外側の属性と入れ子のブロックを、最も外側の `,` と改行で分けて返す。 */
function entriesOf(object: string): string[] {
  const inner = object.trim().slice(1, -1);
  const entries: string[] = [];
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
    } else if ((char === ',' || char === '\n') && depth === 0) {
      entries.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  entries.push(inner.slice(start));
  return entries.map((entry) => entry.trim()).filter((entry) => entry !== '');
}

/** オブジェクト（`{ … }`）の最も外側の属性のキー。キーとして読めない属性は `undefined` にする（黙って外さない）。 */
function topLevelKeys(object: string): (string | undefined)[] {
  return entriesOf(object).map((entry) => /^"?([A-Za-z_][\w-]*)"?\s*[=:]/.exec(entry)?.[1]);
}

type Hcl = { [key: string]: string | string[] | Hcl[] };

/**
 * ブロック（`{ … }`）を、キーごとの値に読む。属性の値は、リスト（`[ … ]`）なら要素の配列、それ以外は式の文字列のまま。
 * 入れ子のブロック（`key { … }`）は、同じキーのブロックすべてを配列にする。キーとして読めない行（`dynamic "…" {`・ヒアドキュメントの中身など）と、
 * 同じキーの2つ目は `?` に集める（黙って外さず、照合で落とす）。
 */
function hclOf(object: string): Hcl {
  const hcl: Hcl = {};
  const unreadable: string[] = [];
  for (const entry of entriesOf(object)) {
    const nested = /^([A-Za-z_]\w*)\s*\{/.exec(entry);
    const assignment = /^"?([A-Za-z_][\w-]*)"?\s*[=:]\s*/.exec(entry);
    if (
      nested?.[1] !== undefined &&
      enclosed(entry, nested[0].length - 1).length === entry.length - nested[0].length - 1
    ) {
      const child = hclOf(entry.slice(nested[0].length - 1));
      const existing: string | (string | Hcl)[] | undefined = hcl[nested[1]];
      if (existing === undefined) {
        hcl[nested[1]] = [child];
      } else if (
        Array.isArray(existing) &&
        existing.length > 0 &&
        existing.every((item) => typeof item !== 'string')
      ) {
        existing.push(child);
      } else {
        unreadable.push(entry);
      }
    } else if (assignment?.[1] !== undefined && !Object.hasOwn(hcl, assignment[1])) {
      const value = entry.slice(assignment[0].length);
      hcl[assignment[1]] =
        value.startsWith('[') && enclosed(value, 0).length === value.length - 2
          ? splitItems(enclosed(value, 0))
          : value;
    } else {
      unreadable.push(entry);
    }
  }
  if (unreadable.length > 0) hcl['?'] = unreadable;
  return hcl;
}

/** `blocksOf` の本文（見出しの行から、閉じ括弧の手前まで）を読む。 */
const hclOfBlock = (body: string): Hcl => hclOf(`${body.slice(body.indexOf('{'))}\n}`);

/** 入れ子のブロックの中も含めた、すべての属性の `[キー, 値]`（リストは要素を `, ` でつなぐ。`?` は読めない行ごと）。 */
function flatEntries(hcl: Hcl): [string, string][] {
  return Object.entries(hcl).flatMap(([key, value]): [string, string][] => {
    if (typeof value === 'string') return [[key, value]];
    const items: (string | Hcl)[] = value;
    const strings = items.filter((item): item is string => typeof item === 'string');
    if (strings.length === items.length) {
      return key === '?'
        ? strings.map((raw): [string, string] => [key, raw])
        : [[key, strings.join(', ')]];
    }
    return items.flatMap((item) => (typeof item === 'string' ? [] : flatEntries(item)));
  });
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

/**
 * **Terraform の外（AWS CLI）で値を置くパラメータ**（#427）。Terraform は値を作らず読まず、`locals` の名前（`<local>_name`）から
 * ARN（`<local>_arn`）を組み立てて、タスク定義の secrets と実行ロールの ssm:GetParameters に渡すだけにする。
 * 値を置く手順は `script` にある。**ここに無いパラメータは、Terraform が ephemeral の乱数から write-only 引数で値を作る**（下の検査）。
 * 足すときは、この表と、値を置く手順の両方に足す。
 */
const externalParameters = [
  {
    env: 'CLOUDFRONT_PRIVATE_KEY',
    local: 'cloudfront_private_key_parameter',
    script: 'scripts/cloudfront-signing-key.sh',
  },
] as const;

/**
 * パラメータの ARN を指す式を、`aws_ssm_parameter.<名前>`（Terraform が値を作る）か `local.<名前>`（外で置く。`_arn` を除いた名前）に読む。
 * それ以外の書き方は undefined（黙って外さない）。
 */
function parameterSourceOf(expression: string | undefined): string | undefined {
  if (expression === undefined) return undefined;
  const managed = /^aws_ssm_parameter\.(\w+)\.arn$/.exec(expression)?.[1];
  if (managed !== undefined) return `aws_ssm_parameter.${managed}`;
  const external = /^local\.(\w+)_arn$/.exec(expression)?.[1];
  return external === undefined ? undefined : `local.${external}`;
}

const taskDefinitions = blocksOf('resource', 'aws_ecs_task_definition');
const secrets = taskDefinitions.flatMap(({ name: task, body }) =>
  itemsOf(body, 'secrets').map((item) => {
    const valueFrom = item.startsWith('{') ? hclOf(item).valueFrom : undefined;
    return {
      task,
      item,
      env: stringAttribute(item, 'name'),
      parameter: parameterSourceOf(typeof valueFrom === 'string' ? valueFrom : undefined),
    };
  }),
);
const environment = taskDefinitions.flatMap(({ name: task, body }) =>
  itemsOf(body, 'environment').map((item) => ({ task, item, env: stringAttribute(item, 'name') })),
);
const executionResources = itemsOf(
  block('data', 'aws_iam_policy_document', 'task_execution_parameters'),
  'resources',
).map((item) => ({ item, parameter: parameterSourceOf(item) }));

/** `locals` に書いた `<name> = <式>` の式（ちょうど1つでなければ、その数を示して落ちる）。 */
function localValue(name: string): string {
  const found = [...terraform.matchAll(new RegExp(`^\\s*${name}\\s*=\\s*(.+?)\\s*$`, 'gm'))];
  if (found.length !== 1) throw new Error(`locals の ${name} が ${found.length} 個ある`);
  return found[0]?.[1] ?? '';
}

/**
 * 構成（コメントを除いた .tf の本文）の IAM の面（aws_iam_ で始まるブロックと、policy・assume_role_policy を持つブロック）が、
 * 表とちょうど同じであることを確かめる。
 */
function expectIamSurface(source: string, table: Record<string, Hcl>): void {
  const blocks = (['resource', 'data'] as const).flatMap((kind) =>
    blocksOf(kind, '\\w+', source).map(({ type, name, body }) => ({
      key: `${kind}.${type}.${name}`,
      type,
      hcl: hclOfBlock(body),
    })),
  );
  // 書き方を問わずに数えたブロックと、読めたブロックが一致する（読めないブロックの中の IAM を黙って外さない）。
  expect(countOf(source, /\b(?:resource|data)\s+"/g)).toBe(blocks.length);
  const policyKey = /^(?:assume_role_)?policy$/;
  const surface = blocks.filter(
    ({ type, hcl }) =>
      type.startsWith('aws_iam_') || Object.keys(hcl).some((key) => policyKey.test(key)),
  );
  expect(Object.fromEntries(surface.map(({ key, hcl }) => [key, hcl]))).toEqual(table);
  // ポリシーを受ける属性は、面のブロックの最も外側にしか無い（入れ子のブロックの中に書いたものを黙って外さない）。
  expect(countOf(source, new RegExp(attribute('(?:assume_role_)?policy'), 'g'))).toBe(
    surface.flatMap(({ hcl }) => Object.keys(hcl)).filter((key) => policyKey.test(key)).length,
  );
}

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

  // この検査が infra/production 全体に課す条件は main.tf の冒頭の1箇所に置く。条件を破る変更をする人がどの .tf を開いても辿れるように、
  // main.tf のほかのどの .tf にも、そこを指す1行を置かせる（新しい .tf にも）。
  it('main.tf の冒頭に検査の条件があり、main.tf のほかのどの .tf にも、それを指す1行がある', () => {
    const others = infraFiles.filter((file) => file.endsWith('.tf') && file !== 'main.tf');
    expect(others.length).toBeGreaterThanOrEqual(1);
    expect(
      others.filter(
        (file) =>
          !readFileSync(join(infraDir, file), 'utf8').includes(
            'このファイルにも main.tf の冒頭の検査の条件が掛かる',
          ),
      ),
    ).toEqual([]);
    expect(readFileSync(join(infraDir, 'main.tf'), 'utf8')).toContain(
      '踏むと壊れる（検査の条件）: apps/api/src/config/api-config-infra.test.ts',
    );
  });

  // 読む箇所（ファイル・ブロック・コンテナ・リスト）ごとに、書き方を問わずにゆるく数えた出現と、読めた出現を突き合わせる。
  // 一致しなければ、読めない書き方（名前が \w の外・リストでない式・locals に置いたコンテナなど）があり、その中身は数え上げに入っていない。
  it('ファイル・タスク定義のブロック・コンテナ・environment / secrets・実行ロールの resources は、どれも読める書き方である（ゆるく数えた出現と読めた出現が一致する）', () => {
    // .tf.json と module は、ここで読む .tf の本文の外に構成を足す。
    expect(infraFiles.filter((file) => file.endsWith('.tf.json'))).toEqual([]);
    expect(countOf(terraform, /\bmodule\s+"/g)).toBe(0);

    // ブロックの本文の終わりを、行頭の `}` と、文字列の外で数えた括弧の深さの2通りで求める。ヒアドキュメントの中の行頭の `}` で
    // 本文が途中で切れると、後ろの属性（平文の password など）が黙って数え上げから外れる。
    expect(
      [...terraform.matchAll(/^(?:resource|data) "\w+" "\w+" \{$/gm)]
        .filter((match) => {
          const open = match.index + match[0].length - 1;
          return (
            open + enclosed(terraform, open).length + 1 !==
            terraform.indexOf('\n}\n', match.index) + 1
          );
        })
        .map((match) => match[0]),
    ).toEqual([]);

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

      // コンテナの属性のキーの層: 許可したキーだけを使う。environmentFiles・secretOptions など、秘密を渡す別の経路を黙って足させない
      // （キーを1つずつ禁じると、次のキーで同じことが起きる）。キーとして読めない属性も落とす。
      const containerKeys = [
        'name',
        'image',
        'essential',
        'portMappings',
        'environment',
        'secrets',
      ];
      expect(
        containers
          .flatMap((container) => topLevelKeys(container))
          .filter(
            (key) => key === undefined || ![...containerKeys, 'logConfiguration'].includes(key),
          ),
        name,
      ).toEqual([]);
      const logConfigurations = containers.flatMap((container) =>
        [...container.matchAll(new RegExp(`${attribute('logConfiguration')}\\s*\\{`, 'g'))].map(
          (match) => `{${enclosed(container, match.index + match[0].length - 1)}}`,
        ),
      );
      expect(
        countOf(containers.join('\n'), new RegExp(attribute('logConfiguration'), 'g')),
        name,
      ).toBe(logConfigurations.length);
      expect(
        logConfigurations
          .flatMap((configuration) => topLevelKeys(configuration))
          .filter((key) => key === undefined || !['logDriver', 'options'].includes(key)),
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

  // 外で置くパラメータを「Terraform が値を作るパラメータ」の検査から外すだけにすると、どの secrets でも locals の式で書けば
  // 値の作り方の検査を黙って通り抜けられる。外で置くものを表で名指しし、その形を1つに固定する。
  it('Terraform の外で値を置くパラメータは表のものだけで、名前から ARN を組み立て、Terraform はそのパラメータを作らない', () => {
    expect(
      secrets
        .filter(({ parameter }) => parameter?.startsWith('local.'))
        .map(({ env, parameter }) => `${env} ← ${parameter}`)
        .sort(),
    ).toEqual(externalParameters.map(({ env, local }) => `${env} ← local.${local}`).sort());
    const managedNames = blocksOf('resource', 'aws_ssm_parameter').map(({ body }) =>
      stringAttribute(body, 'name'),
    );
    for (const { env, local } of externalParameters) {
      // 環境ごとに分ける（#686）。名前の元は下の「環境ごとの名前」が確かめる。
      const name = `/\${local.name}/${env}`;
      expect(localValue(`${local}_name`), env).toBe(`"${name}"`);
      expect(localValue(`${local}_arn`), env).toBe(
        `"arn:aws:ssm:\${data.aws_region.current.region}:\${data.aws_caller_identity.current.account_id}:parameter\${local.${local}_name}"`,
      );
      expect(managedNames, env).not.toContain(name);
    }
  });

  // 外で置くパラメータの「暗号化パラメータ（SecureString）である」は Terraform に現れない。置く手順のスクリプトで固定する。
  // 既定の鍵（aws/ssm）で暗号化する——実行ロールに kms:Decrypt を足していないため、別の鍵を指すとタスクが起動しない。
  it.each(externalParameters.map((parameter) => [parameter.env, parameter] as const))(
    '外で置く %s は、手順のスクリプトが同じ名前の SecureString として既定の鍵で置く',
    (env, { script }) => {
      const text = readFileSync(join(__dirname, '..', '..', '..', '..', script), 'utf8');
      // 名前の元は Terraform の local.name と同じ規則で作る（本番は workspace-chat、ほかは workspace-chat-<環境>）。
      expect(text).toContain(`"/\${prefix}/${env}"`);
      expect(text).toMatch(/^ {2}production\) prefix="workspace-chat" ;;$/m);
      expect(text).toMatch(/^ {2}staging\) prefix="workspace-chat-\$environment" ;;$/m);
      expect(text).toMatch(/aws ssm put-parameter\b/);
      expect(text).toMatch(/--type SecureString\b/);
      expect(text).not.toMatch(/--key-id\b/);
    },
  );

  // 秘密鍵と、api に渡すキーペア ID（delivery.tf の cloudfront_signing_key_name の公開鍵）が対でないと、発行した Cookie がすべて署名の検査に落ちる。
  it('鍵の対を作るスクリプトの既定の鍵の名前は、api が署名に使う鍵の名前と同じである', () => {
    const text = readFileSync(
      join(__dirname, '..', '..', '..', '..', 'scripts', 'cloudfront-signing-key.sh'),
      'utf8',
    );
    const defaultName = /^name="\$\{2:-([a-z0-9-]+)\}"$/m.exec(text)?.[1];
    expect(defaultName).toBeDefined();
    expect(localValue('cloudfront_signing_key_name')).toBe(`"${defaultName}"`);
  });

  // 秘密のパラメータを誰がどの操作で読めるかは、付いているポリシーの操作と、そのロールを引き受けられる相手の両方で決まる。
  // 操作やキーを1つずつ数える・禁じる形では、ワイルドカード（ssm:*）・信頼する相手・次のキーで同じことが起きるため、
  // IAM の面（aws_iam_ で始まるブロックと、policy・assume_role_policy を持つブロック）の全体を、この表とちょうど同じかで照合する。
  it('IAM の面（ロール・ポリシーの文書・ポリシーを受けるブロック・結び付き）は、表とちょうど同じである', () => {
    const iamSurface: Record<string, Hcl> = {
      'data.aws_iam_policy_document.ecs_tasks_assume': {
        statement: [
          {
            actions: ['"sts:AssumeRole"'],
            principals: [{ type: '"Service"', identifiers: ['"ecs-tasks.amazonaws.com"'] }],
          },
        ],
      },
      'resource.aws_iam_role.task_execution': {
        name: '"${local.name}-task-execution"',
        assume_role_policy: 'data.aws_iam_policy_document.ecs_tasks_assume.json',
      },
      'resource.aws_iam_role_policy_attachment.task_execution_managed': {
        role: 'aws_iam_role.task_execution.name',
        policy_arn: '"arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"',
      },
      'data.aws_iam_policy_document.task_execution_parameters': {
        // resources は、上の「ちょうど同じ」の検査が secrets の指すパラメータと照合する。
        statement: [
          {
            actions: ['"ssm:GetParameters"'],
            resources: executionResources.map(({ item }) => item),
          },
        ],
      },
      'resource.aws_iam_role_policy.task_execution_parameters': {
        name: '"parameters"',
        role: 'aws_iam_role.task_execution.id',
        policy: 'data.aws_iam_policy_document.task_execution_parameters.json',
      },
      'resource.aws_iam_role.migrate_task': {
        name: '"${local.name}-migrate-task"',
        assume_role_policy: 'data.aws_iam_policy_document.ecs_tasks_assume.json',
      },
      'data.aws_iam_policy_document.task_exec_command': {
        statement: [
          {
            actions: [
              '"ssmmessages:CreateControlChannel"',
              '"ssmmessages:CreateDataChannel"',
              '"ssmmessages:OpenControlChannel"',
              '"ssmmessages:OpenDataChannel"',
            ],
            resources: ['"*"'],
          },
        ],
      },
      'resource.aws_iam_role_policy.task_exec_command': {
        name: '"exec-command"',
        role: 'aws_iam_role.migrate_task.id',
        policy: 'data.aws_iam_policy_document.task_exec_command.json',
      },
      'data.aws_iam_policy_document.web_bucket': {
        statement: [
          {
            actions: ['"s3:GetObject"'],
            resources: ['"${aws_s3_bucket.web.arn}/*"'],
            principals: [{ type: '"Service"', identifiers: ['"cloudfront.amazonaws.com"'] }],
            condition: [
              {
                test: '"StringEquals"',
                variable: '"AWS:SourceArn"',
                values: ['aws_cloudfront_distribution.main.arn'],
              },
            ],
          },
        ],
      },
      'resource.aws_s3_bucket_policy.web': {
        bucket: 'aws_s3_bucket.web.id',
        policy: 'data.aws_iam_policy_document.web_bucket.json',
      },
      // api のタスクロール: アップロードの確定の主体（機能一覧 11.1・1.3。技術スタックの添付ファイルの行）と、署名者のロールの引き受け（#427）。
      'resource.aws_iam_role.api_task': {
        name: '"${local.name}-api-task"',
        assume_role_policy: 'data.aws_iam_policy_document.ecs_tasks_assume.json',
      },
      'data.aws_iam_policy_document.api_task_storage': {
        statement: [
          {
            actions: ['"s3:GetObject"', '"s3:GetObjectVersion"', '"s3:DeleteObject"'],
            resources: [
              '"${aws_s3_bucket.attachments.arn}/quarantine/avatars/*"',
              '"${aws_s3_bucket.attachments.arn}/quarantine/workspace/*"',
            ],
          },
          {
            actions: ['"s3:PutObject"'],
            resources: [
              '"${aws_s3_bucket.attachments.arn}/avatars/*"',
              '"${aws_s3_bucket.attachments.arn}/workspace/*"',
            ],
          },
          {
            actions: ['"sts:AssumeRole"'],
            resources: ['aws_iam_role.upload_signer.arn'],
          },
        ],
      },
      'resource.aws_iam_role_policy.api_task_storage': {
        name: '"storage"',
        role: 'aws_iam_role.api_task.id',
        policy: 'data.aws_iam_policy_document.api_task_storage.json',
      },
      // アップロード用の署名付き URL の署名者: quarantine/ にだけ書ける。引き受けられるのは api のタスクロールだけ。
      'data.aws_iam_policy_document.upload_signer_assume': {
        statement: [
          {
            actions: ['"sts:AssumeRole"'],
            principals: [{ type: '"AWS"', identifiers: ['aws_iam_role.api_task.arn'] }],
          },
        ],
      },
      'resource.aws_iam_role.upload_signer': {
        name: '"${local.name}-upload-signer"',
        assume_role_policy: 'data.aws_iam_policy_document.upload_signer_assume.json',
      },
      'data.aws_iam_policy_document.upload_signer': {
        statement: [
          {
            actions: ['"s3:PutObject"'],
            resources: ['"${aws_s3_bucket.attachments.arn}/quarantine/*"'],
          },
        ],
      },
      'resource.aws_iam_role_policy.upload_signer': {
        name: '"quarantine-put"',
        role: 'aws_iam_role.upload_signer.id',
        policy: 'data.aws_iam_policy_document.upload_signer.json',
      },
      // 添付のバケット: CloudFront（このディストリビューション）は配信用の接頭辞だけを読める。配信用の接頭辞へ書けるのは api のタスクロールだけ。
      // **「CloudFront の OAC からのみ」に閉じない**（閉じると、ブラウザから quarantine/ への署名付き PUT が通らない。#427）。
      'data.aws_iam_policy_document.attachments_bucket': {
        statement: [
          {
            actions: ['"s3:GetObject"'],
            resources: [
              '"${aws_s3_bucket.attachments.arn}/avatars/*"',
              '"${aws_s3_bucket.attachments.arn}/workspace/*"',
            ],
            principals: [{ type: '"Service"', identifiers: ['"cloudfront.amazonaws.com"'] }],
            condition: [
              {
                test: '"StringEquals"',
                variable: '"AWS:SourceArn"',
                values: ['aws_cloudfront_distribution.main.arn'],
              },
            ],
          },
          {
            effect: '"Deny"',
            actions: ['"s3:PutObject"'],
            resources: [
              '"${aws_s3_bucket.attachments.arn}/avatars/*"',
              '"${aws_s3_bucket.attachments.arn}/workspace/*"',
            ],
            principals: [{ type: '"*"', identifiers: ['"*"'] }],
            condition: [
              {
                test: '"ArnNotEquals"',
                variable: '"aws:PrincipalArn"',
                values: ['aws_iam_role.api_task.arn'],
              },
            ],
          },
        ],
      },
      'resource.aws_s3_bucket_policy.attachments': {
        bucket: 'aws_s3_bucket.attachments.id',
        policy: 'data.aws_iam_policy_document.attachments_bucket.json',
      },
    };
    expectIamSurface(terraform, iamSurface);
  });

  // タスクロールの資格情報はコンテナに渡る。api のタスクに運用者の入口（ECS Exec）の権限を、マイグレーションのタスク（運用者が入る先）に
  // 添付のバケットの権限と署名者のロールの引き受けを渡さない（要件定義書 4.2 手順 5 の「踏むと壊れる」）。
  it('タスクロールは、api が api_task、マイグレーションが migrate_task である', () => {
    const taskRoles = Object.fromEntries(
      taskDefinitions.map(({ name, body }) => [name, hclOfBlock(body).task_role_arn]),
    );
    expect(taskRoles).toEqual({
      api: 'aws_iam_role.api_task.arn',
      migrate: 'aws_iam_role.migrate_task.arn',
    });
  });

  // 実行ロールを execution_role_arn のほか（task_role_arn など）から指すと、その先のコンテナが実行ロールの権限でパラメータを読める。
  it('実行ロールを指すのは、表の結び付き2つとタスク定義の execution_role_arn だけで、ロール名を文字列で書かない', () => {
    // 実行ロールへの参照は、この2つの結び付きと、タスク定義の execution_role_arn だけである（足した・付け替えた結び付きは数が合わない）。
    expect(countOf(terraform, /\baws_iam_role\.task_execution\b/g)).toBe(
      2 + countOf(terraform, /\bexecution_role_arn\s*=\s*aws_iam_role\.task_execution\.arn\b/g),
    );
    // ロール名の文字列で結び付けると、参照の数に現れない。ロール名は自分のブロックの1箇所だけに書き、role を文字列で書かない。
    const executionRole = block('resource', 'aws_iam_role', 'task_execution');
    const executionRoleName = stringAttribute(executionRole, 'name') ?? '';
    expect(executionRoleName).not.toBe('');
    expect(terraform.split(`"${executionRoleName}"`).length - 1).toBe(1);
    expect(countOf(terraform, new RegExp(`${attribute('roles?')}\\s*\\[?\\s*"`, 'g'))).toBe(0);
  });

  // 秘密の値は state とプランに残さない（cache.tf・database.tf の冒頭）。パラメータの name と type だけを見ると、value_wo を value に替えても緑になる。
  it('秘密の値は、ephemeral の random_password から write-only 引数（*_wo）でだけ渡す', () => {
    const resources = blocksOf('resource', '\\w+').map(({ type, name, body }) => ({
      at: `${type}.${name}`,
      type,
      hcl: hclOfBlock(body),
    }));
    expect(countOf(terraform, /\bresource\s+"/g)).toBe(resources.length);
    // 乱数の元は ephemeral の random_password だけ（resource・data で作ると、値が state に残る）。値を読むデータソース aws_ssm_parameter も使わない。
    expect(countOf(terraform, /"random_(?:password|string)"/g)).toBe(
      countOf(terraform, /^ephemeral "random_password" "\w+" \{$/gm),
    );
    const parameters = resources.filter(({ type }) => type === 'aws_ssm_parameter');
    expect(countOf(terraform, /"aws_ssm_parameter"/g)).toBe(parameters.length);
    // パラメータのキーは許可したものだけ（value・insecure_value で平文を渡させない。読めない行も `?` として外に出る）。
    // 外で置くパラメータ（externalParameters）は Terraform が作らないため、下限から除く。
    const managedSecretCount = secretEnvs.length - externalParameters.length;
    expect(parameters.length).toBeGreaterThanOrEqual(managedSecretCount);
    expect(
      parameters
        .map(({ at, hcl }) => `${at}: ${Object.keys(hcl).sort().join(', ')}`)
        .filter((keys) => !keys.endsWith(': name, tier, type, value_wo, value_wo_version')),
    ).toEqual([]);
    // どのリソースでも、password・secret・token を含むキーは write-only 引数とその版だけ（読めない行に含まれていても落とす）。
    const secretWord = /password|secret|token/i;
    const entries = resources.flatMap(({ at, hcl }) =>
      flatEntries(hcl).map(([key, value]) => ({ at, key, value })),
    );
    expect(
      entries
        .filter(({ key, value }) =>
          key === '?'
            ? secretWord.test(value)
            : secretWord.test(key) && !/_wo(?:_version)?$/.test(key),
        )
        .map(({ at, key }) => `${at}: ${key}`),
    ).toEqual([]);
    // write-only 引数の値は ephemeral の random_password から作る（リテラルの秘密をファイルに書かない）。書き方を問わずに数えた *_wo と数が合う。
    const writeOnly = entries.filter(({ key }) => key.endsWith('_wo'));
    expect(writeOnly.length).toBe(countOf(terraform, new RegExp(attribute('\\w+_wo'), 'g')));
    expect(writeOnly.length).toBeGreaterThanOrEqual(managedSecretCount);
    expect(
      writeOnly
        .filter(({ value }) => !value.includes('ephemeral.random_password.'))
        .map(({ at, key }) => `${at}: ${key}`),
    ).toEqual([]);
  });

  // 名前ごとに最初の1件だけを見ると、2つ目のタスク定義の同じ名前の要素が照合されない。secrets の要素すべてを照合する。
  it.each(
    secrets
      .filter(({ parameter }) => !parameter?.startsWith('local.'))
      .map(({ task, env, parameter }) => [task, env ?? '', parameter ?? ''] as const),
  )(
    '%s の %s を渡すパラメータ（%s）は、その名前で終わる暗号化パラメータ（SecureString）である',
    (_task, env, parameter) => {
      expect(parameter).toMatch(/^aws_ssm_parameter\.\w+$/);
      const body = block('resource', 'aws_ssm_parameter', parameter.split('.')[1] ?? '');
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

// 共有の層（infra/shared。#685）の IAM の面。GitHub Actions が OIDC で引き受けるロールの信頼条件と権限を、表とちょうど同じかで固定する。
// 信頼条件を広げる・権限を足すと、main 以外のブランチや別のリポジトリのワークフローが、ECR への push やそれ以上のことをできる。
const sharedDir = join(infraDir, '..', 'shared');

describe('共有の層（infra/shared）の IAM の面', () => {
  const shared = withoutComments(readFileSync(join(sharedDir, 'main.tf'), 'utf8'));

  it('Terraform が読むのは main.tf だけで、module も呼ばない（ほかの場所に置いた構成を、この検査が読み落とさない）', () => {
    expect(
      readdirSync(sharedDir).filter((file) => file.endsWith('.tf') || file.endsWith('.tf.json')),
    ).toEqual(['main.tf']);
    expect(countOf(shared, /\bmodule\s+"/g)).toBe(0);
  });

  it('IAM の面（OIDC・CD のロール・ポリシー）は、表とちょうど同じである', () => {
    expectIamSurface(shared, {
      'resource.aws_iam_openid_connect_provider.github_actions': {
        url: 'local.github_actions_oidc_url',
        client_id_list: ['local.github_actions_audience'],
        thumbprint_list: ['local.github_actions_oidc_thumbprint'],
      },
      'data.aws_iam_policy_document.cd_assume': {
        statement: [
          {
            actions: ['"sts:AssumeRoleWithWebIdentity"'],
            principals: [
              {
                type: '"Federated"',
                identifiers: ['aws_iam_openid_connect_provider.github_actions.arn'],
              },
            ],
            condition: [
              {
                test: '"StringEquals"',
                variable: '"token.actions.githubusercontent.com:aud"',
                values: ['local.github_actions_audience'],
              },
              {
                test: '"StringEquals"',
                variable: '"token.actions.githubusercontent.com:sub"',
                values: ['local.github_repo_main_subject'],
              },
            ],
          },
        ],
      },
      'resource.aws_iam_role.cd': {
        name: '"workspace-chat-cd"',
        assume_role_policy: 'data.aws_iam_policy_document.cd_assume.json',
      },
      'data.aws_iam_policy_document.cd_ecr': {
        statement: [
          {
            actions: ['"ecr:GetAuthorizationToken"'],
            resources: ['"*"'],
          },
          {
            actions: [
              '"ecr:BatchCheckLayerAvailability"',
              '"ecr:PutImage"',
              '"ecr:InitiateLayerUpload"',
              '"ecr:UploadLayerPart"',
              '"ecr:CompleteLayerUpload"',
            ],
            resources: ['aws_ecr_repository.api.arn', 'aws_ecr_repository.migrate.arn'],
          },
        ],
      },
      'resource.aws_iam_role_policy.cd_ecr': {
        name: '"ecr-push"',
        role: 'aws_iam_role.cd.id',
        policy: 'data.aws_iam_policy_document.cd_ecr.json',
      },
      // CD のステージングへのデプロイ（#688）。同じアカウントに本番があるため、ステージングの名前とタグの外に届かない。
      'resource.aws_iam_role.staging_deploy': {
        name: '"${local.staging_name}-deploy"',
        assume_role_policy: 'data.aws_iam_policy_document.cd_assume.json',
      },
      'data.aws_iam_policy_document.staging_deploy': {
        statement: [
          {
            sid: '"FindStaging"',
            actions: ['"ecs:DescribeClusters"'],
            resources: ['"${local.ecs_arn}:cluster/${local.staging_name}"'],
          },
          {
            sid: '"ReadTaskDefinitions"',
            actions: ['"ecs:DescribeTaskDefinition"', '"cloudfront:ListDistributions"'],
            resources: ['"*"'],
          },
          {
            sid: '"RegisterStagingTaskDefinitions"',
            actions: ['"ecs:RegisterTaskDefinition"', '"ecs:ListTagsForResource"'],
            resources: ['"${local.ecs_arn}:task-definition/${local.staging_name}-*:*"'],
          },
          {
            sid: '"TagOnRegister"',
            actions: ['"ecs:TagResource"'],
            resources: ['"${local.ecs_arn}:task-definition/${local.staging_name}-*:*"'],
            condition: [
              {
                test: '"StringEquals"',
                variable: '"ecs:CreateAction"',
                values: ['"RegisterTaskDefinition"'],
              },
            ],
          },
          {
            sid: '"RunStagingMigration"',
            actions: ['"ecs:RunTask"'],
            resources: ['"${local.ecs_arn}:task-definition/${local.staging_name}-migrate:*"'],
            condition: [
              {
                test: '"ArnEquals"',
                variable: '"ecs:cluster"',
                values: ['"${local.ecs_arn}:cluster/${local.staging_name}"'],
              },
            ],
          },
          {
            sid: '"WatchStagingTasks"',
            actions: ['"ecs:DescribeTasks"'],
            resources: ['"${local.ecs_arn}:task/${local.staging_name}/*"'],
          },
          {
            sid: '"UpdateStagingService"',
            actions: ['"ecs:DescribeServices"', '"ecs:UpdateService"'],
            resources: [
              '"${local.ecs_arn}:service/${local.staging_name}/${local.staging_name}-api"',
            ],
          },
          {
            sid: '"PassStagingRoles"',
            actions: ['"iam:PassRole"'],
            resources: [
              '"arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/${local.staging_name}-*"',
            ],
            condition: [
              {
                test: '"StringEquals"',
                variable: '"iam:PassedToService"',
                values: ['"ecs-tasks.amazonaws.com"'],
              },
            ],
          },
          {
            sid: '"ListStagingWeb"',
            actions: ['"s3:ListBucket"'],
            resources: [
              '"arn:aws:s3:::${local.staging_name}-web-${data.aws_caller_identity.current.account_id}"',
            ],
          },
          {
            sid: '"WriteStagingWeb"',
            actions: ['"s3:PutObject"', '"s3:DeleteObject"'],
            resources: [
              '"arn:aws:s3:::${local.staging_name}-web-${data.aws_caller_identity.current.account_id}/*"',
            ],
          },
          {
            sid: '"InvalidateStagingCache"',
            actions: ['"cloudfront:CreateInvalidation"', '"cloudfront:GetInvalidation"'],
            resources: [
              '"arn:aws:cloudfront::${data.aws_caller_identity.current.account_id}:distribution/*"',
            ],
            condition: [
              {
                test: '"StringEquals"',
                variable: '"aws:ResourceTag/Environment"',
                values: ['"staging"'],
              },
            ],
          },
        ],
      },
      'resource.aws_iam_role_policy.staging_deploy': {
        name: '"staging-deploy"',
        role: 'aws_iam_role.staging_deploy.id',
        policy: 'data.aws_iam_policy_document.staging_deploy.json',
      },
    });
  });

  const localsOf = (names: string[]) =>
    Object.fromEntries(
      names.map((name) => {
        const found = [...shared.matchAll(new RegExp(`^\\s*${name}\\s*=\\s*(.+?)\\s*$`, 'gm'))];
        expect(found, name).toHaveLength(1);
        return [name, found[0]?.[1]];
      }),
    );

  // 引き受けられる相手は、このリポジトリ（不変 ID を含む形。#679）の main ブランチへの push で動くワークフローだけである。
  it('信頼条件の audience と sub は、このリポジトリの main ブランチだけを指す', () => {
    expect(
      localsOf(['github_actions_oidc_url', 'github_actions_audience', 'github_repo_main_subject']),
    ).toEqual({
      github_actions_oidc_url: '"https://token.actions.githubusercontent.com"',
      github_actions_audience: '"sts.amazonaws.com"',
      github_repo_main_subject:
        '"repo:doryu0-04092@292095077/workspace-chat@1355868496:ref:refs/heads/main"',
    });
  });

  // 表はデプロイ用ロールの権限を local.staging_name で書く。その値が本番の名前（workspace-chat）に当たると、
  // main へのマージが人の確認なしに本番を書き換えうる。値そのものを固定する（#688）。
  it('ステージングへのデプロイ用ロールが指す名前は workspace-chat-staging で、本番の名前に当たらない', () => {
    expect(localsOf(['staging_name', 'ecs_arn'])).toEqual({
      staging_name: '"workspace-chat-staging"',
      ecs_arn:
        '"arn:aws:ecs:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}"',
    });
  });

  // CD が宛先にする名前（scripts/deploy-staging.sh）と、デプロイ用ロールが許す名前が食い違うと、CD が本番の資源を見に行く
  // （書き込みは IAM で拒まれるが、読み取りと「立っているか」の判定が本番に当たる）。2つを同じ値に固定する（#688）。
  it('CD が宛先にする名前（scripts/deploy-staging.sh の name）は、デプロイ用ロールが許す staging_name と同じである', () => {
    const script = readFileSync(
      join(__dirname, '..', '..', '..', '..', 'scripts', 'deploy-staging.sh'),
      'utf8',
    );
    const names = [...script.matchAll(/^name="([^"]*)"$/gm)].map((match) => `"${match[1]}"`);
    expect(names).toEqual([localsOf(['staging_name']).staging_name]);
  });
});

// 同じ構成を本番とステージングに当てる（#686）。同じアカウントで名前がぶつかると、作成の API が同名の既存を返す資源
// （ECS のクラスターなど）は、Terraform がもう一方の環境の資源を自分の state に取り込み、destroy で消しうる。
// そのため名前はすべて local.name（workspace から決まる）から組み立て、直書きは名前の元と、環境をまたいで共有する ECR の名前だけにする。
describe('環境ごとの名前', () => {
  const allowed = [
    /^\s*project_name\s*=\s*"workspace-chat"$/,
    /^\s*ecr_(api|migrate)_repository_name\s*=\s*"workspace-chat-(api|migrate)"$/,
  ];

  it('workspace-chat の直書きは、名前の元（project_name）と共有の ECR の名前だけである', () => {
    const literal = terraform
      .split('\n')
      .filter((line) => line.includes('workspace-chat'))
      .filter((line) => !allowed.some((pattern) => pattern.test(line)))
      .map((line) => line.trim());
    expect(literal).toEqual([]);
  });

  it('名前の元は、本番（default の workspace）では workspace-chat、ほかの workspace では workspace-chat-<workspace> である', () => {
    expect(terraform).toMatch(
      /^\s*environment\s*=\s*terraform\.workspace == "default" \? "production" : terraform\.workspace$/m,
    );
    expect(terraform).toMatch(
      /^\s*name\s*=\s*local\.environment == "production" \? local\.project_name : "\$\{local\.project_name\}-\$\{local\.environment\}"$/m,
    );
  });
});
