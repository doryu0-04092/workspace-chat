import 'reflect-metadata';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { paths } from '@workspace-chat/shared';
import type { StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app-setup';
import { PrismaService } from '../prisma.service';
import { stubApiEnv } from '../testing/api-env';
import { CapturingLogger } from '../testing/capturing-logger';
import { POSTGRES_STARTUP_TIMEOUT_MS, startMigratedPostgres } from '../testing/postgres';
import { startValkey } from '../testing/valkey';
import { hashSecret } from './secret-hash';

type LoginResponses = paths['/auth/login']['post']['responses'];
type LoginResponse = LoginResponses[200]['content']['application/json'];
type ErrorResponse = LoginResponses[401 | 429]['content']['application/json'];

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
const REFRESH_TOKEN_TTL_SECONDS = 14 * 24 * 60 * 60;
/** 発信元単位のログインの上限（15 分に 20 回）。 */
const LOGIN_LIMIT_PER_IP = 20;

let sequence = 0;
/** テストごとに重ならないユーザーID（3〜30文字の英数字とアンダースコア）。 */
function uniqueUserId(): string {
  sequence += 1;
  return `Login_${Date.now().toString(36)}_${sequence}`;
}

let ipSequence = 0;
/** 要求ごとに違う発信元（文書用の IPv6 の範囲 2001:db8::/32）。発信元単位の上限に、別のテストの要求を数えさせない。 */
function nextIp(): string {
  ipSequence += 1;
  return `2001:db8::1:${ipSequence.toString(16)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Set-Cookie から refresh_token の値と属性を取り出す。 */
function refreshCookie(res: Response): { value: string; attributes: string[] } | undefined {
  const cookie = res.headers.getSetCookie().find((c) => c.startsWith('refresh_token='));
  if (!cookie) return undefined;
  const [pair, ...attributes] = cookie.split(';').map((part) => part.trim());
  return { value: decodeURIComponent((pair ?? '').slice('refresh_token='.length)), attributes };
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

describe('POST /api/auth/login（F-02）', () => {
  let postgres: StartedPostgreSqlContainer;
  let valkey: StartedTestContainer;
  let app: INestApplication;
  let base: string;
  let prisma: PrismaService;
  const logger = new CapturingLogger();

  function postLogin(body: unknown, ip: string = nextIp()): Promise<Response> {
    return fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
      body: JSON.stringify(body),
    });
  }

  async function createUser(
    password: string,
    options: { deleted?: boolean } = {},
  ): Promise<{ id: string; userId: string; displayName: string }> {
    const userId = uniqueUserId();
    const user = await prisma.user.create({
      data: {
        loginId: userId,
        displayName: 'ログインする人',
        passwordHash: await hashSecret(password),
        deletedAt: options.deleted ? new Date() : null,
      },
    });
    return { id: user.id, userId, displayName: user.displayName };
  }

  beforeAll(async () => {
    postgres = await startMigratedPostgres();
    const started = await startValkey();
    valkey = started.container;
    stubApiEnv({
      DATABASE_URL: postgres.getConnectionUri(),
      REDIS_URL: started.url,
      TRUST_PROXY_HOPS: '1',
    });
    app = await createApp({ logger });
    await app.listen(0, '127.0.0.1');
    const { port } = app.getHttpServer().address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
    prisma = app.get(PrismaService);
  }, POSTGRES_STARTUP_TIMEOUT_MS);

  afterAll(async () => {
    await app?.close();
    await postgres?.stop();
    await valkey?.stop();
    vi.unstubAllEnvs();
  });

  describe('ログインできる', () => {
    it('200 でアクセストークン（JWT・15 分）と利用者を返す', async () => {
      const user = await createUser('correct horse battery');
      const res = await postLogin({ userId: user.userId, password: 'correct horse battery' });

      expect(res.status).toBe(200);
      const body = (await res.json()) as LoginResponse;
      expect(body.tokenType).toBe('Bearer');
      expect(body.expiresIn).toBe(ACCESS_TOKEN_TTL_SECONDS);
      expect(body.user).toEqual(user);

      // RFC 8725 3.1: 検証で受け付けるアルゴリズムを固定する。署名は HS256。
      const [header] = body.accessToken.split('.');
      expect(JSON.parse(Buffer.from(header ?? '', 'base64url').toString())).toMatchObject({
        alg: 'HS256',
      });
      const payload = app
        .get(JwtService)
        .verify<{ sub: string; iat: number; exp: number }>(body.accessToken);
      expect(payload.sub).toBe(user.id);
      expect(payload.exp - payload.iat).toBe(ACCESS_TOKEN_TTL_SECONDS);
    });

    // RFC 8725 3.1 / 3.2: 受け付けるアルゴリズムを固定し、alg: none や別のアルゴリズムを名乗るトークンを通さない。
    it.each([
      [
        'HS512 で署名したもの',
        (jwt: JwtService, secret: string) =>
          jwt.sign({ sub: 'someone' }, { algorithm: 'HS512', secret }),
      ],
      [
        'alg: none のもの',
        () =>
          `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${Buffer.from(
            `{"sub":"someone","exp":${Math.floor(Date.now() / 1000) + 600}}`,
          ).toString('base64url')}.`,
      ],
    ])('アクセストークンの検証は、%sを受け付けない', (_label, forge) => {
      const jwt = app.get(JwtService);
      const token = forge(jwt, process.env.JWT_SECRET as string);
      expect(() => jwt.verify(token)).toThrow();
    });

    it('リフレッシュトークンを Cookie（HttpOnly; Secure; SameSite=Strict; Path=/api/auth・14 日）で渡す', async () => {
      const user = await createUser('cookie-password');
      const res = await postLogin({ userId: user.userId, password: 'cookie-password' });

      expect(res.status).toBe(200);
      const cookie = refreshCookie(res);
      expect(cookie).toBeDefined();
      expect(cookie?.attributes).toEqual(
        expect.arrayContaining([
          'HttpOnly',
          'Secure',
          'SameSite=Strict',
          'Path=/api/auth',
          `Max-Age=${REFRESH_TOKEN_TTL_SECONDS}`,
        ]),
      );
      // OWASP Session Management: 128 ビット以上の乱数。32 バイトを base64url にすると 43 文字。
      expect(cookie?.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(await res.text()).not.toContain(cookie?.value ?? '(none)');
    });

    it('リフレッシュトークンは SHA-256 だけを保存し、新しい系列で 14 日の期限を付ける', async () => {
      const user = await createUser('stored-token-password');
      const before = Date.now();
      const res = await postLogin({ userId: user.userId, password: 'stored-token-password' });
      const cookie = refreshCookie(res);

      const rows = await prisma.refreshToken.findMany({ where: { userId: user.id } });
      expect(rows).toHaveLength(1);
      const [row] = rows;
      expect(row?.tokenHash).toBe(sha256Hex(cookie?.value ?? ''));
      // 要件定義書 3.5.2: 識別子は UUIDv7（索引に載る列の局所性を損なわない）。
      expect(row?.familyId).toMatch(UUID_V7);
      expect(row?.revokedAt).toBeNull();
      const expiresAt = row?.expiresAt.getTime() ?? 0;
      expect(expiresAt).toBeGreaterThanOrEqual(before + REFRESH_TOKEN_TTL_SECONDS * 1000);
      expect(expiresAt).toBeLessThanOrEqual(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000);
    });

    it('ログインのたびに別の系列を作る', async () => {
      const user = await createUser('family-password');
      await postLogin({ userId: user.userId, password: 'family-password' });
      await postLogin({ userId: user.userId, password: 'family-password' });

      const rows = await prisma.refreshToken.findMany({ where: { userId: user.id } });
      expect(rows).toHaveLength(2);
      expect(rows[0]?.familyId).not.toBe(rows[1]?.familyId);
    });

    // 機能一覧 1.1 / 1.2: ユーザーID は大文字小文字を区別しない。照合は lower() で引く。
    it('登録時と違う大文字小文字を打ってもログインできる', async () => {
      const user = await createUser('case-password');
      const res = await postLogin({
        userId: user.userId.toLowerCase(),
        password: 'case-password',
      });
      expect(res.status).toBe(200);
      expect(((await res.json()) as LoginResponse).user.userId).toBe(user.userId);
    });

    // NIST SP 800-63B-4 3.1.1.2。照合も secret-hash.ts の verifySecret（NFC への正規化）を通す。
    it('登録と違うコードポイント列（NFD）で送ってもログインできる', async () => {
      const user = await createUser('café-password'); // 合成済みの é
      const res = await postLogin({ userId: user.userId, password: 'café-password' }); // e + 結合用アキュート
      expect(res.status).toBe(200);
    });
  });

  describe('ログインできない', () => {
    // 機能一覧 1.2: 「ユーザーID が存在しない」と「パスワードが違う」を区別しない。退会済みも同じ応答にする。
    it('パスワードが違う・ID が無い・退会済みは、同じ 401 の本体を返し、Cookie を渡さない', async () => {
      const user = await createUser('the-right-password');
      const deleted = await createUser('deleted-password', { deleted: true });

      const responses = [
        await postLogin({ userId: user.userId, password: 'a-wrong-password' }),
        await postLogin({ userId: uniqueUserId(), password: 'the-right-password' }),
        await postLogin({ userId: deleted.userId, password: 'deleted-password' }),
      ];
      const bodies: ErrorResponse[] = [];
      for (const res of responses) {
        expect(res.status).toBe(401);
        expect(refreshCookie(res)).toBeUndefined();
        bodies.push((await res.json()) as ErrorResponse);
      }
      expect(bodies[0]?.code).toBe('invalid_credentials');
      expect(bodies[1]).toEqual(bodies[0]);
      expect(bodies[2]).toEqual(bodies[0]);

      expect(await prisma.refreshToken.count({ where: { userId: deleted.id } })).toBe(0);
    });
  });

  // アカウント単位: 連続して失敗した回数 n に対し 2^(n-1) 秒は照合しない（決定・2026-09-11・依頼側）。
  describe('アカウント単位の制限（失敗のたびに待ち時間を延ばす）', () => {
    it('失敗の直後は、正しいパスワードでも照合せず 429（Retry-After: 1）を返し、待てば通す', async () => {
      const user = await createUser('backoff-password');
      expect((await postLogin({ userId: user.userId, password: 'wrong-password' })).status).toBe(
        401,
      );

      const ip = nextIp();
      const blocked = await postLogin({ userId: user.userId, password: 'backoff-password' }, ip);
      expect(blocked.status).toBe(429);
      expect(blocked.headers.get('retry-after')).toBe('1');
      expect(((await blocked.json()) as ErrorResponse).code).toBe('too_many_requests');
      expect(refreshCookie(blocked)).toBeUndefined();
      // アカウント単位の超過も、発信元単位と同じ形で記録する（#270 第3巡）。
      const limited = logger.lines.find((l) => l.includes('rate_limit_exceeded') && l.includes(ip));
      expect(limited).toContain('/api/auth/login');
      expect(limited).toContain('"limit":"account"');

      await sleep(1_100);
      expect((await postLogin({ userId: user.userId, password: 'backoff-password' })).status).toBe(
        200,
      );
    });

    it('2回続けて失敗したら、待ち時間は 2 秒になる', async () => {
      const user = await createUser('twice-password');
      await postLogin({ userId: user.userId, password: 'wrong-1' });
      await sleep(1_100);
      await postLogin({ userId: user.userId, password: 'wrong-2' });

      const blocked = await postLogin({ userId: user.userId, password: 'twice-password' });
      expect(blocked.status).toBe(429);
      expect(blocked.headers.get('retry-after')).toBe('2');
    });

    it('成功したら数え直す', async () => {
      const user = await createUser('reset-password');
      await postLogin({ userId: user.userId, password: 'wrong-1' });
      await sleep(1_100);
      expect((await postLogin({ userId: user.userId, password: 'reset-password' })).status).toBe(
        200,
      );
      // 数え直していなければ、成功の直後の試行は前の待ち時間の中にあり、照合されずに 429 になる。
      expect((await postLogin({ userId: user.userId, password: 'wrong-2' })).status).toBe(401);

      const blocked = await postLogin({ userId: user.userId, password: 'reset-password' });
      expect(blocked.headers.get('retry-after')).toBe('1');
    });

    // 存在する ID だけを止めると、止まるかどうかで登録済みの ID を調べられる。
    it('存在しない ID も同じに止める', async () => {
      const missing = uniqueUserId();
      expect((await postLogin({ userId: missing, password: 'whatever' })).status).toBe(401);
      expect((await postLogin({ userId: missing, password: 'whatever' })).status).toBe(429);
    });

    it('大文字小文字だけが違う ID は、同じアカウントとして数える', async () => {
      const user = await createUser('case-backoff-password');
      await postLogin({ userId: user.userId.toUpperCase(), password: 'wrong-password' });
      const blocked = await postLogin({
        userId: user.userId.toLowerCase(),
        password: 'case-backoff-password',
      });
      expect(blocked.status).toBe(429);
    });
  });

  describe('発信元単位の制限（15 分に 20 回）', () => {
    it('同じ発信元から 21 回目は 429', async () => {
      const ip = nextIp();
      for (let i = 0; i < LOGIN_LIMIT_PER_IP; i++) {
        // ID を変えて、アカウント単位の制限に掛からないようにする。
        const res = await postLogin({ userId: uniqueUserId(), password: 'whatever' }, ip);
        expect(res.status).toBe(401);
      }
      const res = await postLogin({ userId: uniqueUserId(), password: 'whatever' }, ip);
      expect(res.status).toBe(429);
      const retryAfter = Number(res.headers.get('retry-after'));
      // 窓は 15 分。上限を超えた直後に見るため、ほぼ 900 秒になる（窓を縮めたら落ちるように下限を置く）。
      expect(retryAfter).toBeGreaterThan(800);
      expect(retryAfter).toBeLessThanOrEqual(900);
    });
  });

  it('パスワードとトークンをログに出さない', async () => {
    const password = 'log-must-not-see-this';
    const user = await createUser(password);
    const ok = await postLogin({ userId: user.userId, password });
    const { accessToken } = (await ok.json()) as LoginResponse;
    const refreshToken = refreshCookie(ok)?.value ?? '(none)';
    await postLogin({ userId: user.userId, password: `${password}-wrong` });

    const all = logger.lines.join('\n');
    expect(all).not.toContain(password);
    expect(all).not.toContain(accessToken);
    expect(all).not.toContain(refreshToken);
  });
});
