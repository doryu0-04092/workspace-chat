import { randomBytes } from 'node:crypto';
import { vi } from 'vitest';

/**
 * createApp が読む環境変数を、テスト用の値ですべて差し替える部品。**製品コードから読み込まない**（tsconfig.build.json が外す）。
 * 後片づけは呼び出し側の `vi.unstubAllEnvs()`。
 */

/** 繋がらない DB の宛先。接続は最初の問い合わせまで張られないため、問い合わせないテストはこれでよい。 */
export const UNREACHABLE_DATABASE_URL = 'postgresql://unused:unused@127.0.0.1:9/unused';
/** テストの web の origin（CSRF の対処で Origin / Referer と突き合わせる）。 */
export const TEST_WEB_ORIGIN = 'http://web.test';

/** 繋がらない Valkey の宛先。レート制限はメモリへ迂回する。 */
export const UNREACHABLE_REDIS_URL = 'redis://127.0.0.1:9';

type ApiEnvName =
  | 'DATABASE_URL'
  | 'REDIS_URL'
  | 'TRUST_PROXY_HOPS'
  | 'API_TASK_COUNT'
  | 'REGISTRATION_ENABLED'
  | 'JWT_SECRET'
  | 'WEB_ORIGIN';

/**
 * 起動の設定（config/api-config.ts）の環境変数を、既定のテスト用の値に `overrides` を重ねて差し替える。
 * `undefined` を渡した名前は未設定にする。
 *
 * **起動の設定を足したら、ここにも足す**——足さないと、手元の端末の環境変数がそのままテストに入る。
 * JWT_SECRET は呼ぶたびに乱数で作る（ソースに鍵の形の文字列を置かない）。
 */
export function stubApiEnv(overrides: Partial<Record<ApiEnvName, string | undefined>> = {}): void {
  const env: Record<ApiEnvName, string | undefined> = {
    DATABASE_URL: UNREACHABLE_DATABASE_URL,
    REDIS_URL: UNREACHABLE_REDIS_URL,
    TRUST_PROXY_HOPS: '0',
    API_TASK_COUNT: undefined,
    REGISTRATION_ENABLED: undefined,
    JWT_SECRET: randomBytes(32).toString('base64url'),
    WEB_ORIGIN: TEST_WEB_ORIGIN,
    ...overrides,
  };
  for (const [name, value] of Object.entries(env)) {
    vi.stubEnv(name, value);
  }
}
