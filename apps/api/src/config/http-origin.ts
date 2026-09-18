/**
 * `raw` が http(s) の origin（`スキーム://ホスト[:ポート]`）そのものか。末尾の `/`・パス・資格情報（`user:pass@`）が付くと偽。
 * WEB_ORIGIN（api-config.ts）と S3_ENDPOINT（storage/s3-config.ts）の検証が使う。
 */
export function isHttpOrigin(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  return (url.protocol === 'https:' || url.protocol === 'http:') && url.origin === raw;
}
