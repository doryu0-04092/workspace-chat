import { createHash, randomBytes } from 'node:crypto';

/** アクセストークン（JWT）の有効期間（秒）。15 分は慣行であり、一次情報に数値の推奨は無い。 */
export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
/** リフレッシュトークンの有効期間（秒）。14 日は慣行（RFC 9700 は数値を決めていない）。 */
export const REFRESH_TOKEN_TTL_SECONDS = 14 * 24 * 60 * 60;

/** リフレッシュトークンの Cookie の名前。`__Host-` は `Path=/` を必須とし、`Path=/api/auth` と両立しないため付けない。 */
export const REFRESH_TOKEN_COOKIE = 'refresh_token';

/**
 * リフレッシュトークンの Cookie の属性（機能一覧 1.2「HttpOnly; Secure; SameSite=Strict; Path=/api/auth」）。
 * **Cookie を送るのは /api/auth の下だけ**——他の API は Authorization ヘッダーで認証し、CSRF が成立しない（要件定義書 4.3）。
 */
export const REFRESH_TOKEN_CLEAR_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: 'strict',
  path: '/api/auth',
} as const;

/** 発行するときの属性。消すとき（REFRESH_TOKEN_CLEAR_COOKIE_OPTIONS）と Path を揃える——違うと、ブラウザは元の Cookie を消さない。 */
export const REFRESH_TOKEN_COOKIE_OPTIONS = {
  ...REFRESH_TOKEN_CLEAR_COOKIE_OPTIONS,
  maxAge: REFRESH_TOKEN_TTL_SECONDS * 1000,
} as const;

/** リフレッシュトークンを作る。32 バイト（256 ビット）の乱数（OWASP Session Management「128 ビット以上」）。 */
export function generateRefreshToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * 保存・照合に使うリフレッシュトークンのハッシュ（SHA-256 の16進）。**トークン自体は保存しない。**
 * パスワードと違って Argon2id を使わないのは、256 ビットの乱数は総当たりが成り立たず、遅いハッシュが守るもの
 * （推測しやすい入力）が無いためである。値で引けるように、ソルトも付けない。
 */
export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
