import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

/**
 * テストで実際の PostgreSQL を使うための部品。**製品コードから読み込まない**（tsconfig.build.json が外す）。
 *
 * ## 実行の前提: **Docker のデーモンが動いていること**
 *
 * Testcontainers で `postgres:17` のコンテナを起動する。動いていない環境では起動できず、
 * **これを使うテストが一式落ちる。** 落ちたメッセージに `docker` /
 * `Could not find a working container runtime` が出ているなら、疑うのはテストの対象ではなく Docker である。
 *
 * ## イメージに pg_bigm を含めない理由
 *
 * 全文検索（F-30）は別のイシューで扱う。**検索のモデルが入る時点で、pg_bigm を同梱した
 * イメージが別途必要になる**（イシュー #34 に代償として記録した）。
 */
/**
 * **踏むと壊れる: この値は scripts/api-image.test.sh も読み、毎回 `docker pull` する。レジストリから取れる名前にすること。**
 * 手元でビルドしただけのイメージ（docker/postgres のような形）にすると、`npm test` は通ったままイメージの検査だけが落ちる。
 */
export const POSTGRES_IMAGE = 'postgres:17';

/**
 * コンテナの起動とマイグレーションの適用を待つ時間（10 分）。初回はイメージの取得が入る。
 *
 * **ci.yml の timeout-minutes（15）より小さくする。** あちらはジョブ全体に掛かる。
 * ここに大きい値を置くと、先に GitHub Actions がジョブごと打ち切り、
 * **Vitest のメッセージも junit レポートも残らない**（reports/ が無いので
 * 保存のステップも飛ぶ）。落ちた人が、イメージの取得で待たされたのか
 * 検証で落ちたのかを区別できなくなる。
 */
export const POSTGRES_STARTUP_TIMEOUT_MS = 600_000;

/** リポジトリの根（`node_modules/prisma` を持つディレクトリ）を、cwd から遡って探す。 */
function findRepositoryRoot(): string {
  let dir = process.cwd();
  for (;;) {
    if (existsSync(join(dir, 'node_modules', 'prisma', 'build', 'index.js'))) return dir;
    const parent = dirname(dir);
    // 根に着いても見つからなければ、探し方が間違っている。黙って進むと
    // 後続の失敗が「prisma が壊れている」ように見える。
    if (parent === dir) throw new Error('prisma の CLI が見つからない');
    dir = parent;
  }
}

const repositoryRoot = findRepositoryRoot();
const prismaCli = join(repositoryRoot, 'node_modules', 'prisma', 'build', 'index.js');
export const schemaPath = join(repositoryRoot, 'apps', 'api', 'prisma', 'schema.prisma');

/**
 * prisma の CLI を実行する。
 *
 * `npx` を介さない。Windows では `npx` が `npx.cmd` になり、`execFile` で
 * 直接起動できない。**手元と CI で起動の仕方を変えると、片方でしか通らない
 * テストになる。** Node で CLI の実体を直接動かせば、どちらも同じ経路になる。
 */
export function runPrisma(args: string[], databaseUrl: string): string {
  return execFileSync(process.execPath, [prismaCli, ...args], {
    cwd: repositoryRoot,
    // Prisma 7 は .env を自動で読み込まない。接続先はここで明示的に渡す。
    env: { ...process.env, DATABASE_URL: databaseUrl },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** コンテナを起動し、空の DB にマイグレーションを適用して返す。 */
export async function startMigratedPostgres(): Promise<StartedPostgreSqlContainer> {
  const container = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
  // ここが落ちるなら、マイグレーションが実際の PostgreSQL に適用できていない。
  runPrisma(['migrate', 'deploy', '--schema', schemaPath], container.getConnectionUri());
  return container;
}
