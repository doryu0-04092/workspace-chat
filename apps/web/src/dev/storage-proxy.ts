/** Vite の dev サーバーの中継の設定1つ（`server.proxy` の値のうち、ここで使う分）。 */
export type StorageProxy = {
  readonly target: string;
  readonly changeOrigin: boolean;
  readonly rewrite: (path: string) => string;
};

/**
 * **手元だけの**配信の中継（vite.config.ts）。本番は CloudFront のビヘイビアが配信 URL のパスを添付のバケットへ渡し、署名付き Cookie を求める
 * （技術スタックの CloudFront の行）。手元には CloudFront が無いため、dev サーバーが MinIO（path style）へ中継する。
 *
 * - `/avatars/*` はパスを剥がさずに `/{バケット}/avatars/...` へ（キーが `avatars/` で始まる。要件定義書 4.3）
 * - `/files/*` は `/files` を剥がして `/{バケット}/...` へ（本番は CloudFront の viewer-request の関数が剥がす。キーは `workspace/` で始まる）
 *
 * **手元の MinIO は、この接頭辞だけを匿名で読めるようにしている**（compose.yaml の minio。署名付き Cookie の代わり）。
 * 中継はパスを書き換えるだけで、読めるキーの範囲を決めるのは MinIO の匿名の読み取りの範囲である（`quarantine/` は読めない）。
 * S3 の宛先かバケットが無ければ中継しない（アバターと添付の画像が出ないだけで、dev サーバーは起動する）。
 */
export function storageProxies({
  endpoint,
  bucket,
}: {
  endpoint: string | undefined;
  bucket: string | undefined;
}): Record<string, StorageProxy> {
  if (!endpoint || !bucket) return {};
  return {
    '/avatars': { target: endpoint, changeOrigin: true, rewrite: (path) => `/${bucket}${path}` },
    '/files': {
      target: endpoint,
      changeOrigin: true,
      rewrite: (path) => `/${bucket}${path.slice('/files'.length)}`,
    },
  };
}
