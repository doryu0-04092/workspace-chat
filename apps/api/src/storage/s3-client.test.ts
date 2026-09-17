import { randomUUID } from 'node:crypto';
import {
  CreateBucketCommand,
  GetObjectCommand,
  PutBucketVersioningCommand,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { Test, type TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ApiConfigModule, resolveApiConfig } from '../config/api-config';
import { stubApiEnv } from '../testing/api-env';
import { type StartedMinio, startMinio } from '../testing/minio';
import { POSTGRES_STARTUP_TIMEOUT_MS } from '../testing/postgres';
import { S3_CLIENT, StorageModule } from './storage.module';

// 手元とテストでは S3 を MinIO で代える（#427）。api の設定（S3_ENDPOINT・S3_FORCE_PATH_STYLE・S3_BUCKET・S3_REGION）から
// モジュールが作るクライアントで、バージョニングを有効にしたバケットへ実際に読み書きできることを確かめる。
// 資格情報は設定に持たず、AWS SDK の既定の読み方（環境変数 AWS_ACCESS_KEY_ID など）に任せる——ここでもその経路で渡す。
describe('S3 のクライアント（StorageModule）', () => {
  let minio: StartedMinio | undefined;
  let moduleRef: TestingModule | undefined;
  let client: S3Client;
  const bucket = `avatars-test-${randomUUID()}`;

  beforeAll(async () => {
    minio = await startMinio();
    stubApiEnv({
      S3_BUCKET: bucket,
      S3_REGION: 'ap-northeast-1',
      S3_ENDPOINT: minio.endpoint,
      S3_FORCE_PATH_STYLE: 'true',
    });
    vi.stubEnv('AWS_ACCESS_KEY_ID', minio.accessKeyId);
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', minio.secretAccessKey);
    vi.stubEnv('AWS_SESSION_TOKEN', undefined);
    moduleRef = await Test.createTestingModule({
      imports: [ApiConfigModule.forRoot(resolveApiConfig(process.env)), StorageModule],
    }).compile();
    client = moduleRef.get<S3Client>(S3_CLIENT);
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
    await client.send(
      new PutBucketVersioningCommand({
        Bucket: bucket,
        VersioningConfiguration: { Status: 'Enabled' },
      }),
    );
  }, POSTGRES_STARTUP_TIMEOUT_MS);

  afterAll(async () => {
    await moduleRef?.close();
    await minio?.container.stop();
    vi.unstubAllEnvs();
  });

  const body = async (response: { Body?: { transformToString(): Promise<string> } }) =>
    response.Body?.transformToString();

  it('オブジェクトを置き、置いたものを読める', async () => {
    const key = `quarantine/avatars/${randomUUID()}/${randomUUID()}/avatar.png`;
    await client.send(
      new PutObjectCommand({ Bucket: bucket, Key: key, Body: 'first', ContentType: 'image/png' }),
    );

    const got = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    expect(await body(got)).toBe('first');
    expect(got.ContentType).toBe('image/png');
  });

  // 検証してから確定するまでの間に上書きされても、検証した版を読めるようにするため（機能一覧 11.1）。
  it('同じキーに置き直すと版が分かれ、版を指定して前の中身を読める', async () => {
    const key = `quarantine/avatars/${randomUUID()}/${randomUUID()}/avatar.png`;
    const first = await client.send(
      new PutObjectCommand({ Bucket: bucket, Key: key, Body: 'first' }),
    );
    const second = await client.send(
      new PutObjectCommand({ Bucket: bucket, Key: key, Body: 'second' }),
    );
    expect(first.VersionId).toEqual(expect.any(String));
    expect(second.VersionId).toEqual(expect.any(String));
    expect(first.VersionId).not.toBe('null');
    expect(second.VersionId).not.toBe(first.VersionId);

    const latest = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    expect(await body(latest)).toBe('second');
    expect(latest.VersionId).toBe(second.VersionId);

    const earlier = await client.send(
      new GetObjectCommand({ Bucket: bucket, Key: key, VersionId: first.VersionId }),
    );
    expect(await body(earlier)).toBe('first');
    expect(earlier.VersionId).toBe(first.VersionId);
  });

  it('モジュールを閉じると、クライアントの接続を片づける', async () => {
    const local = await Test.createTestingModule({
      imports: [ApiConfigModule.forRoot(resolveApiConfig(process.env)), StorageModule],
    }).compile();
    const destroy = vi.spyOn(local.get<S3Client>(S3_CLIENT), 'destroy');
    await local.close();
    expect(destroy).toHaveBeenCalledTimes(1);
  });
});
