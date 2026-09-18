import { S3Client } from '@aws-sdk/client-s3';
import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts';
import type { ApiConfig } from '../config/api-config';

/** アップロード用の署名付き URL の有効期限（5 分。決定・2026-09-10・依頼側。機能一覧 11.1）。 */
export const UPLOAD_URL_TTL_SECONDS = 300;

/**
 * 一時的な資格情報の残りがこれを切ったら取り直す（URL の期限 5 分と、余裕の 5 分）。
 * **署名付き URL は、署名した資格情報が切れた時点で使えなくなる**——残りが URL の期限より短い資格情報で署名すると、5 分の約束が黙って縮む。
 */
export const CREDENTIAL_MIN_REMAINING_MS = UPLOAD_URL_TTL_SECONDS * 1000 + 5 * 60 * 1000;

/** 引き受けたロールの資格情報の長さ（1 時間。AssumeRole の既定であり、ロールの最大の長さの既定でもある）。 */
const ASSUMED_ROLE_DURATION_SECONDS = 3600;

/** 署名に使う資格情報（AWS SDK の `credentials` に渡す関数の戻り値の形）。 */
type TemporaryCredentials = {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken: string;
  readonly expiration: Date;
};

/** AssumeRole を送れるもの（テストで差し替える）。 */
export type StsSender = { send(command: AssumeRoleCommand): Promise<unknown> };

/**
 * `roleArn` を引き受けた一時的な資格情報を返す関数（#427。署名者は `quarantine/` にだけ書けるロール）。
 * 残りが `CREDENTIAL_MIN_REMAINING_MS` を切るまでは同じものを返し、切ったら取り直す。**取り直しに失敗したら投げる**（既定の資格情報に倒さない）。
 */
export function assumedRoleCredentials(
  sts: StsSender,
  roleArn: string,
): () => Promise<TemporaryCredentials> {
  let cached: TemporaryCredentials | undefined;
  return async () => {
    if (cached && cached.expiration.getTime() - Date.now() >= CREDENTIAL_MIN_REMAINING_MS) {
      return cached;
    }
    const output = (await sts.send(
      new AssumeRoleCommand({
        RoleArn: roleArn,
        RoleSessionName: 'workspace-chat-upload-signer',
        DurationSeconds: ASSUMED_ROLE_DURATION_SECONDS,
      }),
    )) as {
      Credentials?: {
        AccessKeyId?: string;
        SecretAccessKey?: string;
        SessionToken?: string;
        Expiration?: Date;
      };
    };
    const credentials = output.Credentials;
    if (
      !credentials?.AccessKeyId ||
      !credentials.SecretAccessKey ||
      !credentials.SessionToken ||
      !credentials.Expiration
    ) {
      throw new Error('AssumeRole が一時的な資格情報を返さなかった');
    }
    cached = {
      accessKeyId: credentials.AccessKeyId,
      secretAccessKey: credentials.SecretAccessKey,
      sessionToken: credentials.SessionToken,
      expiration: credentials.Expiration,
    };
    return cached;
  };
}

/**
 * アップロード用の署名付き URL に署名する S3 のクライアント。**確定（読み出し・コピー・削除）には使わない**（確定は StorageModule の
 * `S3_CLIENT`＝既定の資格情報。#427 の決定: 確定の主体は api のタスクロール、署名者は別のロール）。
 *
 * - `s3UploadRoleArn` があれば、そのロールを引き受けた一時的な資格情報で署名する。無ければ既定の資格情報（手元・テスト）
 * - **`requestChecksumCalculation: 'WHEN_REQUIRED'`**——既定（`WHEN_SUPPORTED`）では、PutObject の署名付き URL に、署名の時点の空の本体のチェックサム
 *   （`x-amz-checksum-crc32` など）が載る（外すと載ることを avatar-upload.test.ts で確かめた）。S3 はブラウザが送る本体と照らすため、合わずに断られうる
 *   （**MinIO では断られなかった**ため、手元のテストで確かめているのは URL に載らないことだけである）
 */
export function createUploadSigningClient(
  config: Pick<ApiConfig, 's3Region' | 's3Endpoint' | 's3ForcePathStyle' | 's3UploadRoleArn'>,
  sts?: StsSender,
): S3Client {
  return new S3Client({
    region: config.s3Region,
    ...(config.s3Endpoint === undefined ? {} : { endpoint: config.s3Endpoint }),
    forcePathStyle: config.s3ForcePathStyle,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    ...(config.s3UploadRoleArn === undefined
      ? {}
      : {
          credentials: assumedRoleCredentials(
            sts ?? new STSClient({ region: config.s3Region }),
            config.s3UploadRoleArn,
          ),
        }),
  });
}
