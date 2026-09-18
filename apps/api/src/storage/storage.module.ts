import { S3Client } from '@aws-sdk/client-s3';
import { Global, Inject, Injectable, Module, type OnApplicationShutdown } from '@nestjs/common';
import { API_CONFIG, type ApiConfig } from '../config/api-config';

/** 添付とアバターのバケットを読み書きする S3 のクライアントを注入するトークン。 */
export const S3_CLIENT = Symbol('S3_CLIENT');

/**
 * S3 のクライアントを設定から作る。**資格情報を渡さない**——本番は ECS のタスクロール、手元とテストは環境変数
 * （AWS_ACCESS_KEY_ID など）を、AWS SDK の既定の読み方が拾う（#427。s3-config.ts の冒頭）。
 * 宛先（`endpoint`）とパス形式（`forcePathStyle`）は、手元とテストの MinIO を指すときだけ設定する。
 */
export function createS3Client(
  config: Pick<ApiConfig, 's3Region' | 's3Endpoint' | 's3ForcePathStyle'>,
): S3Client {
  return new S3Client({
    region: config.s3Region,
    ...(config.s3Endpoint === undefined ? {} : { endpoint: config.s3Endpoint }),
    forcePathStyle: config.s3ForcePathStyle,
  });
}

@Injectable()
class S3ClientCloser implements OnApplicationShutdown {
  constructor(@Inject(S3_CLIENT) private readonly client: S3Client) {}
  onApplicationShutdown(): void {
    this.client.destroy();
  }
}

/** 接続の置き場を1つにするため、全モジュールで同じクライアントを使う（PrismaModule と同じ）。 */
@Global()
@Module({
  providers: [
    { provide: S3_CLIENT, inject: [API_CONFIG], useFactory: createS3Client },
    S3ClientCloser,
  ],
  exports: [S3_CLIENT],
})
export class StorageModule {}
