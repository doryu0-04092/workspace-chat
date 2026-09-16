import { GenericContainer, PullPolicy, type StartedTestContainer, Wait } from 'testcontainers';

/**
 * テストで実際の Valkey を使うための部品。**製品コードから読み込まない**（tsconfig.build.json が外す）。
 * イメージは compose.yaml の redis サービスと同じ系列にそろえる。Docker が動いていることが前提（postgres.ts と同じ）。
 * **起動のたびにイメージを取り直す**（理由と代償は postgres.ts の POSTGRES_IMAGE と同じ）。
 * **踏むと壊れる: この取り直しが、この土台の更新を受け取る唯一の経路である**
 * （土台は Dependabot で追わない。理由は .github/dependabot.yml の末尾）。
 */
export const VALKEY_IMAGE = 'valkey/valkey:8-alpine';

export async function startValkey(): Promise<{ container: StartedTestContainer; url: string }> {
  const container = await new GenericContainer(VALKEY_IMAGE)
    .withPullPolicy(PullPolicy.alwaysPull())
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage('Ready to accept connections'))
    .start();
  return { container, url: `redis://${container.getHost()}:${container.getMappedPort(6379)}` };
}
