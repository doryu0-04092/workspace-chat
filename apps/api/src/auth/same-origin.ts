/** 要求のヘッダーのうち、同じ origin かの判定に使うもの（Node の IncomingHttpHeaders と同じく小文字の名前）。 */
export type OriginHeaders = Readonly<{
  'sec-fetch-site'?: string | string[];
  origin?: string | string[];
  referer?: string | string[];
}>;

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * 要求が web と同じ origin から送られたか（要件定義書 4.3 の CSRF の対処 ③）。
 *
 * OWASP CSRF Prevention Cheat Sheet の順で見る:
 * 1. **Sec-Fetch-Site があれば、それだけで決める**（`same-origin` だけを通す。`same-site` は別のサブドメインを含むため通さない）
 * 2. 無ければ **Origin** を web の origin と突き合わせる（`null` は通さない）
 * 3. それも無ければ **Referer** の origin と突き合わせる
 * 4. **どれも無ければ拒否する**（判定できない要求を通さない）
 *
 * 上の段にヘッダーがあるときは下の段を見ない——Origin が別の origin なのに Referer で通すと、Referer だけを細工した要求が通る。
 */
export function isSameOriginRequest(headers: OriginHeaders, webOrigin: string): boolean {
  const site = single(headers['sec-fetch-site']);
  if (site !== undefined) return site === 'same-origin';

  const origin = single(headers.origin);
  if (origin !== undefined) return origin === webOrigin;

  const referer = single(headers.referer);
  if (referer !== undefined) {
    try {
      return new URL(referer).origin === webOrigin;
    } catch {
      return false;
    }
  }
  return false;
}
