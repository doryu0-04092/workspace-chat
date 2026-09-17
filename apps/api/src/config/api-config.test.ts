import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { API_SETTINGS, resolveApiConfig, resolveJwtSecret, resolveWebOrigin } from './api-config';
import { resolveDatabaseUrl } from './database-url';

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

// CSRF の対処（要件定義書 4.3）で、Origin / Referer と突き合わせる web の origin。
describe('web の origin（WEB_ORIGIN）', () => {
  it.each(['https://chat.example.com', 'http://localhost:5173'])('%s を使う', (raw) => {
    expect(resolveWebOrigin(raw)).toBe(raw);
  });

  // origin は「スキーム://ホスト[:ポート]」だけである。末尾の / やパスが付くと、ブラウザが送る Origin と一致しなくなり、
  // 正規の要求がすべて 403 になる。起動時に落とす。
  it.each([
    undefined,
    '',
    'chat.example.com',
    'https://chat.example.com/',
    'https://chat.example.com/app',
    'ftp://chat.example.com',
  ])('%j は起動時に落とす', (raw) => {
    expect(() => resolveWebOrigin(raw)).toThrow(/WEB_ORIGIN/);
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
  WEB_ORIGIN: 'https://chat.example.com',
  S3_BUCKET: 'workspace-chat-attachments-123456789012',
  S3_REGION: 'ap-northeast-1',
  S3_ENDPOINT: 'http://127.0.0.1:9000',
  S3_FORCE_PATH_STYLE: 'true',
  CLOUDFRONT_KEY_PAIR_ID: 'K2JCJMDEHXQW5F',
  // テストのたびに作る鍵（ソースに鍵の形の文字列を置かない）
  CLOUDFRONT_PRIVATE_KEY: generateKeyPairSync('rsa', { modulusLength: 2048 })
    .privateKey.export({ type: 'pkcs8', format: 'pem' })
    .toString(),
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
      webOrigin: VALID_ENV.WEB_ORIGIN,
      s3Bucket: VALID_ENV.S3_BUCKET,
      s3Region: VALID_ENV.S3_REGION,
      s3Endpoint: VALID_ENV.S3_ENDPOINT,
      s3ForcePathStyle: true,
      cloudfrontKeyPairId: VALID_ENV.CLOUDFRONT_KEY_PAIR_ID,
      cloudfrontPrivateKey: VALID_ENV.CLOUDFRONT_PRIVATE_KEY,
    });
  });

  it('任意の設定は、未設定なら既定値になる', () => {
    const env = {
      ...VALID_ENV,
      API_TASK_COUNT: undefined,
      REGISTRATION_ENABLED: undefined,
      S3_ENDPOINT: undefined,
      S3_FORCE_PATH_STYLE: undefined,
      CLOUDFRONT_KEY_PAIR_ID: undefined,
      CLOUDFRONT_PRIVATE_KEY: undefined,
    };
    const config = resolveApiConfig(env);
    expect(config).toMatchObject({
      apiTaskCount: 1,
      registrationEnabled: true,
      s3ForcePathStyle: false,
    });
    expect(config.s3Endpoint).toBeUndefined();
    expect(config.cloudfrontKeyPairId).toBeUndefined();
    expect(config.cloudfrontPrivateKey).toBeUndefined();
  });

  // 片方だけでは Cookie を発行できない（キーペア ID だけなら発行のたびに落ち、秘密鍵だけなら黙って発行しない）。
  // 手元は両方とも設定しない。本番はタスク定義が両方を渡す（infra/production/service.tf）。
  it.each([
    [
      'CLOUDFRONT_KEY_PAIR_ID だけ',
      'CLOUDFRONT_PRIVATE_KEY',
      { CLOUDFRONT_PRIVATE_KEY: undefined },
    ],
    [
      'CLOUDFRONT_PRIVATE_KEY だけ',
      'CLOUDFRONT_KEY_PAIR_ID',
      { CLOUDFRONT_KEY_PAIR_ID: undefined },
    ],
  ])('%s を設定したら、もう片方が無いことを起動時に知らせる', (_label, missing, overrides) => {
    const env = { ...VALID_ENV, ...overrides };
    expect(() => resolveApiConfig(env)).toThrow(new RegExp(`${missing} が設定されていません`));
  });

  it('秘密鍵だけを設定したときのメッセージに、鍵の値を載せない', () => {
    let message = '';
    try {
      resolveApiConfig({ ...VALID_ENV, CLOUDFRONT_KEY_PAIR_ID: undefined });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toBe('');
    expect(message).not.toContain(VALID_ENV.CLOUDFRONT_PRIVATE_KEY.split('\n')[1]);
  });

  // 1つ直して起動し直すたびに次の不正が見つかる形だと、デプロイを設定の数だけ繰り返すことになる。
  it('不正な設定が複数あれば、そのすべてを1つの失敗で知らせる', () => {
    const env = {
      API_TASK_COUNT: '0',
      REGISTRATION_ENABLED: 'no',
      S3_ENDPOINT: '127.0.0.1:9000',
      S3_FORCE_PATH_STYLE: 'yes',
      CLOUDFRONT_KEY_PAIR_ID: 'lowercase',
      CLOUDFRONT_PRIVATE_KEY: 'not-a-key',
    };
    let message = '';
    try {
      resolveApiConfig(env);
    } catch (error) {
      message = (error as Error).message;
    }
    for (const name of Object.values(API_SETTINGS).map((setting) => setting.env)) {
      expect(message).toContain(name);
    }
  });
});
