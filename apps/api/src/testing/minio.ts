import { randomBytes } from 'node:crypto';
import { GenericContainer, PullPolicy, type StartedTestContainer, Wait } from 'testcontainers';

/**
 * テストで S3 の代わりに S3 互換のストレージ（MinIO）を使うための部品。**製品コードから読み込まない**（tsconfig.build.json が外す）。
 * 手元とテストでは S3 を MinIO で代える（#427 の決定）。Docker が動いていることが前提（postgres.ts と同じ）。
 * **起動のたびにイメージを取り直す**（理由と代償は postgres.ts の POSTGRES_IMAGE と同じ）。
 * **compose.yaml の minio とはイメージが違う**（下の理由）。取り直す経路は、これだけである
 * （タグごとの経路の一覧は .github/dependabot.yml の末尾）。
 *
 * **quay.io の minio/minio も Docker Hub の minio/minio も、認証なしでは取れない**（2026-09-25 にどちらも 401。#698）。
 * Chainguard が公開する MinIO を使う。無料で取れるのは latest のタグだけなので、**ダイジェストで固定する**
 * （取り直しても同じ版のまま）。起動の命令は minio の本体なので、`server /data` をそのまま渡す。
 * compose.yaml はシェルと mc でバケットを作るため、シェルを持たないこのイメージには替えられない。
 */
export const MINIO_IMAGE =
  'cgr.dev/chainguard/minio@sha256:bd014394a80898e68c149f2311fdf8d5a2c2f3bb2c33b9327ae6d02b4b065ae1';

export interface StartedMinio {
  readonly container: StartedTestContainer;
  /** S3 の宛先（`http://<ホスト>:<ポート>`。api の S3_ENDPOINT に渡す形）。 */
  readonly endpoint: string;
  /** MinIO の管理者の資格情報。起動のたびに乱数で作る（ソースに資格情報の形の文字列を置かない）。 */
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

export async function startMinio(): Promise<StartedMinio> {
  const accessKeyId = `test${randomBytes(8).toString('hex')}`;
  const secretAccessKey = randomBytes(24).toString('base64url');
  const container = await new GenericContainer(MINIO_IMAGE)
    .withPullPolicy(PullPolicy.alwaysPull())
    .withEnvironment({ MINIO_ROOT_USER: accessKeyId, MINIO_ROOT_PASSWORD: secretAccessKey })
    .withCommand(['server', '/data'])
    .withExposedPorts(9000)
    .withWaitStrategy(Wait.forHttp('/minio/health/live', 9000))
    .start();
  return {
    container,
    endpoint: `http://${container.getHost()}:${container.getMappedPort(9000)}`,
    accessKeyId,
    secretAccessKey,
  };
}
