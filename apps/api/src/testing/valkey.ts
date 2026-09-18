import { GenericContainer, PullPolicy, type StartedTestContainer, Wait } from 'testcontainers';

/**
 * テストで実際の Valkey を使うための部品。**製品コードから読み込まない**（tsconfig.build.json が外す）。
 * イメージは compose.yaml の redis サービスと同じ系列にそろえる。Docker が動いていることが前提（postgres.ts と同じ）。
 * **起動のたびにイメージを取り直す**（理由と代償は postgres.ts の POSTGRES_IMAGE と同じ）。
 * **このタグは compose.yaml の redis と同じである。** 取り直す経路は、これと `docker compose pull redis` の2本。
 * **手元でテストを回さない人には compose pull だけが経路になる**ため、やめると、その人には更新が届かなくなる
 * （土台は Dependabot で追わない。タグごとの経路の一覧は .github/dependabot.yml の末尾）。
 */
export const VALKEY_IMAGE = 'valkey/valkey:8-alpine';

/**
 * Valkey だけを起動する `beforeAll` の待ち時間（120 秒）。`startValkey` は起動のたびに
 * レジストリからイメージを取り直す（手元に無い・タグの中身が変わったときは取得が入る。上の VALKEY_IMAGE の docblock）。
 * **取得に何秒かかるかは測っていない**——取り直す形になってから、これを使うテストの CI（`code` ジョブ）は
 * 毎回通っている（未確認: 取得が遅い環境での実績は無い）。
 * **ci.yml の timeout-minutes（15）より小さくする**（理由は postgres.ts の POSTGRES_STARTUP_TIMEOUT_MS と同じ）。
 */
export const VALKEY_STARTUP_TIMEOUT_MS = 120_000;

export async function startValkey(): Promise<{ container: StartedTestContainer; url: string }> {
  const container = await new GenericContainer(VALKEY_IMAGE)
    .withPullPolicy(PullPolicy.alwaysPull())
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage('Ready to accept connections'))
    .start();
  return { container, url: `redis://${container.getHost()}:${container.getMappedPort(6379)}` };
}
