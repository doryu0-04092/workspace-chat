import { describe, expect, it } from 'vitest';
import { storageProxies } from './storage-proxy';

// 手元には CloudFront が無いため、Vite の dev サーバーが配信 URL のパスを MinIO へ中継する（本番の形は CloudFront のビヘイビア。要件定義書 4.3）。
describe('手元の配信の中継（Vite の dev サーバー）', () => {
  const endpoint = 'http://127.0.0.1:9000';
  const bucket = 'workspace-chat-local';

  it('/avatars/* は、パスを剥がさずにバケットの avatars/ のキーへ中継する', () => {
    const proxy = storageProxies({ endpoint, bucket })['/avatars'];
    expect(proxy?.target).toBe(endpoint);
    expect(proxy?.rewrite?.('/avatars/u/id/me.png')).toBe(`/${bucket}/avatars/u/id/me.png`);
  });

  it('/files/* は /files を剥がして、バケットの workspace/ のキーへ中継する', () => {
    const proxy = storageProxies({ endpoint, bucket })['/files'];
    expect(proxy?.target).toBe(endpoint);
    expect(proxy?.rewrite?.('/files/workspace/w/channel/c/id/a.png')).toBe(
      `/${bucket}/workspace/w/channel/c/id/a.png`,
    );
  });

  it('S3 の宛先かバケットが無ければ中継しない（dev サーバーは起動する）', () => {
    expect(storageProxies({ endpoint: undefined, bucket })).toEqual({});
    expect(storageProxies({ endpoint, bucket: undefined })).toEqual({});
  });
});
