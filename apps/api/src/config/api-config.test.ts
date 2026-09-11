import { describe, expect, it } from 'vitest';
import { resolveApiConfig, resolveDatabaseUrl, resolveJwtSecret } from './api-config';

// RFC 7518 3.2「A key of the same size as the hash output (for instance, 256 bits for "HS256") or larger MUST be used」。
describe('アクセストークンの署名の鍵（JWT_SECRET）', () => {
  it('32 バイト以上なら、その値を使う', () => {
    const secret = 'k'.repeat(32);
    expect(resolveJwtSecret(secret)).toBe(secret);
  });

  it.each([undefined, ''])('%j は起動時に落とす', (raw) => {
    expect(() => resolveJwtSecret(raw)).toThrow(/JWT_SECRET/);
  });

  // 文字数ではなくバイト数で数える（「あ」は UTF-8 で 3 バイト）。
  it.each([
    ['31 バイトの ASCII', 'k'.repeat(31)],
    ['30 バイトの「あ」10 文字', 'あ'.repeat(10)],
  ])('%s は短すぎるため起動時に落とし、値を載せない', (_label, raw) => {
    expect(() => resolveJwtSecret(raw)).toThrow(/JWT_SECRET/);
    try {
      resolveJwtSecret(raw);
    } catch (error) {
      expect((error as Error).message).not.toContain(raw);
    }
  });

  it('11 文字でも 33 バイトの「あ」なら通す', () => {
    expect(resolveJwtSecret('あ'.repeat(11))).toBe('あ'.repeat(11));
  });
});

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
  JWT_SECRET: 'jwt-key-9x'.repeat(4),
};

describe('起動の設定（resolveApiConfig）', () => {
  it('環境変数から、起動に要る設定をまとめて組み立てる', () => {
    expect(resolveApiConfig(VALID_ENV)).toEqual({
      databaseUrl: VALID_ENV.DATABASE_URL,
      redisUrl: VALID_ENV.REDIS_URL,
      trustProxyHops: 2,
      apiTaskCount: 3,
      registrationEnabled: false,
      jwtSecret: VALID_ENV.JWT_SECRET,
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
      'JWT_SECRET',
    ]) {
      expect(message).toContain(name);
    }
  });

  // 起動の失敗はログに出る。接続先には資格情報が入り、JWT_SECRET は署名の鍵そのものである。
  it('失敗のメッセージに接続先の値を載せない', () => {
    const env = { ...VALID_ENV, TRUST_PROXY_HOPS: undefined };
    expect(() => resolveApiConfig(env)).toThrow(/TRUST_PROXY_HOPS/);
    try {
      resolveApiConfig(env);
    } catch (error) {
      expect((error as Error).message).not.toContain('pw-db-9x');
      expect((error as Error).message).not.toContain('pw-redis-9x');
      expect((error as Error).message).not.toContain(VALID_ENV.JWT_SECRET);
    }
  });
});
