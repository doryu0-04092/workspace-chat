import { PutObjectCommand } from '@aws-sdk/client-s3';
import { AssumeRoleCommand } from '@aws-sdk/client-sts';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CREDENTIAL_MIN_REMAINING_MS,
  assumedRoleCredentials,
  createUploadSigningClient,
} from './upload-signer';

// #427 の決定: アップロード用の署名付き URL の署名者は、api のタスクロールが sts:AssumeRole で引き受ける別のロールにする
// （署名付き URL への PUT は、URL を署名したプリンシパルとして認証される。技術スタックの添付ファイルの行）。
// 設定 S3_UPLOAD_ROLE_ARN が無ければ（手元・テスト）、S3 のクライアントの既定の資格情報で署名する。
const ROLE_ARN = 'arn:aws:iam::123456789012:role/workspace-chat-upload-signer';
const BASE = {
  s3Region: 'ap-northeast-1',
  s3Endpoint: 'http://127.0.0.1:9000',
  s3ForcePathStyle: true,
} as const;

/** 呼ばれるたびに別の一時的な資格情報を、`expiresInMs` 後に切れるものとして返す偽の STS。 */
function fakeSts(expiresInMs = 60 * 60 * 1000) {
  let issued = 0;
  const send = vi.fn(async (command: unknown) => {
    expect(command).toBeInstanceOf(AssumeRoleCommand);
    issued += 1;
    return {
      Credentials: {
        AccessKeyId: `ASIATEMPORARY${issued}`,
        SecretAccessKey: `temporary-secret-${issued}`,
        SessionToken: `temporary-session-${issued}`,
        Expiration: new Date(Date.now() + expiresInMs),
      },
    };
  });
  return { send };
}

async function sign(client: ReturnType<typeof createUploadSigningClient>): Promise<URL> {
  return new URL(
    await getSignedUrl(
      client,
      new PutObjectCommand({ Bucket: 'bucket', Key: 'quarantine/x', ContentType: 'image/png' }),
      { expiresIn: 300 },
    ),
  );
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('アップロード用の署名付き URL の署名者', () => {
  it('S3_UPLOAD_ROLE_ARN があれば、そのロールを引き受けた一時的な資格情報で署名する', async () => {
    vi.stubEnv('AWS_ACCESS_KEY_ID', 'AKIADEFAULTCREDENTIAL');
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'default-secret');
    const sts = fakeSts();
    const client = createUploadSigningClient({ ...BASE, s3UploadRoleArn: ROLE_ARN }, sts);

    const url = await sign(client);

    expect(url.searchParams.get('X-Amz-Credential')).toMatch(/^ASIATEMPORARY1\//);
    expect(url.searchParams.get('X-Amz-Security-Token')).toBe('temporary-session-1');
    expect(sts.send).toHaveBeenCalledTimes(1);
    const input = (sts.send.mock.calls[0]?.[0] as AssumeRoleCommand).input;
    expect(input.RoleArn).toBe(ROLE_ARN);
    expect(input.RoleSessionName).toEqual(expect.any(String));
    client.destroy();
  });

  it('S3_UPLOAD_ROLE_ARN が無ければ、既定の資格情報で署名し、ロールを引き受けない', async () => {
    vi.stubEnv('AWS_ACCESS_KEY_ID', 'AKIADEFAULTCREDENTIAL');
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'default-secret');
    vi.stubEnv('AWS_SESSION_TOKEN', undefined);
    const sts = fakeSts();
    const client = createUploadSigningClient({ ...BASE, s3UploadRoleArn: undefined }, sts);

    const url = await sign(client);

    expect(url.searchParams.get('X-Amz-Credential')).toMatch(/^AKIADEFAULTCREDENTIAL\//);
    expect(sts.send).not.toHaveBeenCalled();
    client.destroy();
  });

  // 署名付き URL は、署名した資格情報が切れた時点で使えなくなる。URL の期限（5 分）より先に切れる資格情報で署名しない。
  describe('一時的な資格情報の取り直し', () => {
    it('残りが十分なうちは取り直さず、同じ資格情報を返す', async () => {
      const sts = fakeSts();
      const provider = assumedRoleCredentials(sts, ROLE_ARN);
      const first = await provider();
      const second = await provider();
      expect(second.accessKeyId).toBe(first.accessKeyId);
      expect(sts.send).toHaveBeenCalledTimes(1);
    });

    it('残りが URL の期限と余裕を合わせた長さを切ったら、取り直す', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      const sts = fakeSts(CREDENTIAL_MIN_REMAINING_MS + 60_000);
      const provider = assumedRoleCredentials(sts, ROLE_ARN);
      expect((await provider()).accessKeyId).toBe('ASIATEMPORARY1');

      vi.advanceTimersByTime(59_000);
      expect((await provider()).accessKeyId).toBe('ASIATEMPORARY1');

      vi.advanceTimersByTime(2_000);
      expect((await provider()).accessKeyId).toBe('ASIATEMPORARY2');
      expect(sts.send).toHaveBeenCalledTimes(2);
    });

    it('余裕は URL の期限（5 分）より長い', () => {
      expect(CREDENTIAL_MIN_REMAINING_MS).toBeGreaterThan(300_000);
    });

    it('STS が資格情報を返さなければ、署名せずに失敗する', async () => {
      const provider = assumedRoleCredentials({ send: async () => ({}) }, ROLE_ARN);
      await expect(provider()).rejects.toThrow(/AssumeRole/);
    });
  });
});
