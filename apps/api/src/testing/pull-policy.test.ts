import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// #368: テストの土台（Testcontainers で起動するコンテナ）は、起動のたびに最新のイメージを取り直す（#296）。
// 取り直しの形は2つ: 起動の連なりに `withPullPolicy(PullPolicy.alwaysPull())` を持つか、同じ関数の中で
// `docker build --pull` で作った手元のイメージを起動する（postgres.ts）。新しい起動箇所を足して付け忘れても、ここで落ちる。
const SOURCE_ROOT = join(__dirname, '..');
const START = /new (GenericContainer|PostgreSqlContainer)\(/g;

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'generated' ? [] : sources(path);
    return /\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name) ? [path] : [];
  });
}

/** 起動箇所ごとに、取り直しの形を持つか。 */
function startSites(): { site: string; pulls: boolean }[] {
  return sources(SOURCE_ROOT).flatMap((path) => {
    const text = readFileSync(path, 'utf8');
    return [...text.matchAll(START)].map((match) => {
      const at = match.index;
      const chain = text.slice(at, text.indexOf('.start()', at));
      const enclosing = text.slice(text.lastIndexOf('function ', at), at);
      return {
        site: `${path}:${text.slice(0, at).split('\n').length}`,
        pulls:
          chain.includes('.withPullPolicy(PullPolicy.alwaysPull())') ||
          /'build',\s*'--pull'/.test(enclosing),
      };
    });
  });
}

describe('テストの土台のイメージの取り直し', () => {
  it('Testcontainers で起動する箇所が見つかる（検査が空回りしていない）', () => {
    expect(startSites().length).toBeGreaterThanOrEqual(3);
  });

  it('どの起動箇所も、起動のたびに最新のイメージを取り直す', () => {
    expect(startSites().filter(({ pulls }) => !pulls)).toEqual([]);
  });
});
