import { execFile, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

/**
 * テストで実際の PostgreSQL を使うための部品。**製品コードから読み込まない**（tsconfig.build.json が外す）。
 *
 * ## 実行の前提: **Docker のデーモンが動いていること**
 *
 * Testcontainers で PostgreSQL 17 のコンテナを起動する。動いていない環境では起動できず、
 * **これを使うテストが一式落ちる。** 落ちたメッセージに `docker` /
 * `Could not find a working container runtime` が出ているなら、疑うのはテストの対象ではなく Docker である。
 *
 * ## イメージは開発環境の db と同じ Dockerfile から作る
 *
 * **マイグレーションが `CREATE EXTENSION pg_bigm` を含む**（全文検索。F-30）。公式の `postgres:17` には pg_bigm が無く、
 * そのままではマイグレーションが通らない。**docker/postgres/Dockerfile から、起動のたびに `docker build --pull` で作る**
 * （土台の取り直しは作るたびに入る。手元に同じタグがあっても古い土台のまま通さない）。
 * **代償: 土台を起動するたびにレジストリへ問い合わせるため npm test が遅くなり、手元に作った層が無い最初の1回は pg_bigm のビルドを待つ。
 * レジストリと pg_bigm の取得元に届かない環境では、手元にイメージがあっても起動できない**（scripts/api-image.test.sh と同じ）。
 */
/**
 * テストの PostgreSQL のイメージの名前（手元で作る。レジストリには無い）。
 * **踏むと壊れる: この値は scripts/api-image.test.sh も読み、同じ Dockerfile から同じ名前で作る**——開発環境の db（`workspace-chat-db:local`）とは別の名前にし、
 * テストの `--pull` が開発環境のイメージを差し替えないようにする。
 * 土台（docker/postgres/Dockerfile の POSTGRES_IMAGE）は Dependabot で追わないと決めており、タグごとの経路の一覧は .github/dependabot.yml の末尾にある。
 */
export const POSTGRES_IMAGE = 'workspace-chat-db:test';

/**
 * コンテナの起動とマイグレーションの適用を待つ時間（10 分）。起動のたびにイメージを作ってレジストリへ土台を問い合わせ、手元に層が無い・土台の版が変わったときは取得と pg_bigm のビルドが入る。
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

const postgresImageContext = join(repositoryRoot, 'docker', 'postgres');

/**
 * コンテナを起動し、空の DB にマイグレーションを適用して返す。
 * イメージは起動のたびに docker/postgres/Dockerfile から作る（`--pull`。上の説明）。**`shared_preload_libraries=pg_bigm` は開発環境（compose.yaml）と本番（infra/production/database.tf）と揃える。**
 */
export async function startMigratedPostgres(): Promise<StartedPostgreSqlContainer> {
  await promisify(execFile)(
    'docker',
    ['build', '--pull', '--quiet', '--tag', POSTGRES_IMAGE, postgresImageContext],
    { maxBuffer: 16 * 1024 * 1024 },
  );
  const container = await new PostgreSqlContainer(POSTGRES_IMAGE)
    .withCommand(['postgres', '-c', 'shared_preload_libraries=pg_bigm'])
    .start();
  // ここが落ちるなら、マイグレーションが実際の PostgreSQL に適用できていない。
  runPrisma(['migrate', 'deploy', '--schema', schemaPath], container.getConnectionUri());
  return container;
}
