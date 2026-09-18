import { randomBytes } from 'node:crypto';
import { GenericContainer, PullPolicy, type StartedTestContainer, Wait } from 'testcontainers';

/**
 * テストで S3 の代わりに S3 互換のストレージ（MinIO）を使うための部品。**製品コードから読み込まない**（tsconfig.build.json が外す）。
 * 手元とテストでは S3 を MinIO で代える（#427 の決定）。Docker が動いていることが前提（postgres.ts と同じ）。
 * **起動のたびにイメージを取り直す**（理由と代償は postgres.ts の POSTGRES_IMAGE と同じ）。
 * **このタグは compose.yaml の minio・minio-init と同じである。** 取り直す経路は、これと `docker compose pull minio` の2本
 * （タグごとの経路の一覧は .github/dependabot.yml の末尾）。
 *
 * **Docker Hub の minio/minio は取れない**（2026-09-17 に Docker Hub の API が 404 を返した）。quay.io から取る。
 * quay.io の `.hotfix.` の付いたタグは使わない（付いていない最後の版がこれである。2026-09-17 に quay.io の API で確かめた）。
 */
export const MINIO_IMAGE = 'quay.io/minio/minio:RELEASE.2025-09-07T16-13-09Z';

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
