import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// npm test の土台（Testcontainers で起動する PostgreSQL・Valkey）は、起動のたびにイメージを取り直す（postgres.ts の POSTGRES_IMAGE の注記。#296）。
// 取り直しの設定を1行消しても型検査・テスト・CI のどれも落ちず、土台を起動する箇所を新しく足したときの付け忘れにも気づけない。
// そこで、ソースを読んで、土台を起動する箇所がすべて取り直しの設定を持つことを確かめる（#368）。

const srcDir = join(__dirname, '..');

/** src の下の .ts（生成物の generated と、このファイル自身を除く）。 */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'generated' ? [] : sourceFiles(path);
    return entry.name.endsWith('.ts') && path !== __filename ? [path] : [];
  });
}

/** コンテナを作る式の、`new` から文の終わり（`;`）まで。 */
const startups = sourceFiles(srcDir).flatMap((file) => {
  const text = readFileSync(file, 'utf8');
  return [...text.matchAll(/\bnew\s+(?:GenericContainer|PostgreSqlContainer)\s*\(/g)].map(
    (match) => ({
      where: `${relative(srcDir, file)}:${text.slice(0, match.index).split('\n').length}`,
      chain: text.slice(match.index, text.indexOf(';', match.index)),
    }),
  );
});

describe('Testcontainers で土台を起動する箇所', () => {
  // 数え上げが空で通らないように（postgres.ts の PostgreSQL と valkey.ts の Valkey）。
  it('数え上げる対象がある', () => {
    expect(startups.length).toBeGreaterThanOrEqual(2);
  });

  it('すべて、起動のたびにイメージを取り直す設定（withPullPolicy(PullPolicy.alwaysPull())）を持つ', () => {
    expect(
      startups
        .filter(({ chain }) => !/\.withPullPolicy\(\s*PullPolicy\.alwaysPull\(\)\s*\)/.test(chain))
        .map(({ where }) => where),
    ).toEqual([]);
  });
});
