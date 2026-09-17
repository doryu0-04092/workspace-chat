import type { S3Client } from '@aws-sdk/client-s3';
import { Inject, Injectable, Module, type OnApplicationShutdown } from '@nestjs/common';
import { API_CONFIG, type ApiConfig } from '../config/api-config';
import { createUploadSigningClient } from './upload-signer';
import { UPLOAD_SIGNING_CLIENT, UploadStorage } from './upload-storage';

@Injectable()
class UploadSigningClientCloser implements OnApplicationShutdown {
  constructor(@Inject(UPLOAD_SIGNING_CLIENT) private readonly client: S3Client) {}
  onApplicationShutdown(): void {
    this.client.destroy();
  }
}

/**
 * アップロードの S3 の段（機能一覧 11.1・1.3）。アバター（UsersModule）と添付が同じ段を使う。
 * **署名のクライアントは確定のクライアント（StorageModule の `S3_CLIENT`）と分ける**（#427。upload-signer.ts）。
 */
@Module({
  providers: [
    {
      provide: UPLOAD_SIGNING_CLIENT,
      inject: [API_CONFIG],
      useFactory: (config: ApiConfig) => createUploadSigningClient(config),
    },
    UploadSigningClientCloser,
    UploadStorage,
  ],
  exports: [UploadStorage],
})
export class UploadsModule {}
