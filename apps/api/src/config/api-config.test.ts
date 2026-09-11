import { describe, expect, it } from 'vitest';
import { resolveApiConfig } from './api-config';
import { resolveDatabaseUrl } from './database-url';

describe('DB の接続先（DATABASE_URL）', () => {
  it('設定されていれば、その値を使う', () => {
    expect(resolveDatabaseUrl('postgresql://u@127.0.0.1:5432/d')).toBe(
      'postgresql://u@127.0.0.1:5432/d',
    );
  });

  // 未設定のまま起動すると、最初の問い合わせで原因の分かりにくいエラーになる。起動時に落とす。
  it.each([undefined, ''])('%j は起動時に落とす', (raw) => {
    expect(() => resolveDatabaseUrl(raw)).toThrow(/DATABASE_URL/);
  });
});

const VALID_ENV = {
  DATABASE_URL: 'postgresql://u:pw-db-9x@127.0.0.1:5432/d',
  REDIS_URL: 'redis://:pw-redis-9x@127.0.0.1:6379',
  TRUST_PROXY_HOPS: '2',
  API_TASK_COUNT: '3',
  REGISTRATION_ENABLED: 'false',
};

describe('起動の設定（resolveApiConfig）', () => {
  it('環境変数から、起動に要る設定をまとめて組み立てる', () => {
    expect(resolveApiConfig(VALID_ENV)).toEqual({
      databaseUrl: VALID_ENV.DATABASE_URL,
      redisUrl: VALID_ENV.REDIS_URL,
      trustProxyHops: 2,
      apiTaskCount: 3,
      registrationEnabled: false,
    });
  });

  it('任意の設定は、未設定なら既定値になる', () => {
    const env = { ...VALID_ENV, API_TASK_COUNT: undefined, REGISTRATION_ENABLED: undefined };
    expect(resolveApiConfig(env)).toMatchObject({ apiTaskCount: 1, registrationEnabled: true });
  });

  // 1つ直して起動し直すたびに次の不正が見つかる形だと、デプロイを設定の数だけ繰り返すことになる。
  it('不正な設定が複数あれば、そのすべてを1つの失敗で知らせる', () => {
    const env = { API_TASK_COUNT: '0', REGISTRATION_ENABLED: 'no' };
    let message = '';
    try {
      resolveApiConfig(env);
    } catch (error) {
      message = (error as Error).message;
    }
    for (const name of [
      'DATABASE_URL',
      'REDIS_URL',
      'TRUST_PROXY_HOPS',
      'API_TASK_COUNT',
      'REGISTRATION_ENABLED',
    ]) {
      expect(message).toContain(name);
    }
  });
});
