import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';

/**
 * テストで実際の Valkey を使うための部品。**製品コードから読み込まない**（tsconfig.build.json が外す）。
 * イメージは compose.yaml の redis サービスと同じ系列にそろえる。Docker が動いていることが前提（postgres.ts と同じ）。
 */
export const VALKEY_IMAGE = 'valkey/valkey:8-alpine';

export async function startValkey(): Promise<{ container: StartedTestContainer; url: string }> {
  const container = await new GenericContainer(VALKEY_IMAGE)
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage('Ready to accept connections'))
    .start();
  return { container, url: `redis://${container.getHost()}:${container.getMappedPort(6379)}` };
}
