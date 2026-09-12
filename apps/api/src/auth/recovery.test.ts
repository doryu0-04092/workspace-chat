import 'reflect-metadata';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
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

type RecoveryResponse =
  paths['/auth/recovery']['post']['responses'][200]['content']['application/json'];
type RegisterResponse =
  paths['/auth/register']['post']['responses'][201]['content']['application/json'];
type ErrorResponse = paths['/auth/recovery']['post']['responses'][
  401 | 429]['content']['application/json'];

const CODE_FORMAT = /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/;
/** 発信元単位の再設定の上限（1時間に10回）。 */
const RECOVERY_LIMIT_PER_IP = 10;

let sequence = 0;
function uniqueUserId(): string {
  sequence += 1;
  return `Recover_${Date.now().toString(36)}_${sequence}`;
}

let ipSequence = 0;
function nextIp(): string {
  ipSequence += 1;
  return `2001:db8::3:${ipSequence.toString(16)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('POST /api/auth/recovery（F-37）', () => {
  let postgres: StartedPostgreSqlContainer;
  let valkey: StartedTestContainer;
  let app: INestApplication;
  let base: string;
  let prisma: PrismaService;
  const logger = new CapturingLogger();

  function post(path: string, body: unknown, ip: string = nextIp()): Promise<Response> {
    return fetch(`${base}/api/auth/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
      body: JSON.stringify(body),
    });
  }

  /** 新規登録の API で利用者を作り、ユーザーID・パスワード・リカバリーコードを返す。 */
  async function register(): Promise<{
    userId: string;
    password: string;
    code: string;
    id: string;
  }> {
    const userId = uniqueUserId();
    const password = 'original-password';
    const res = await post('register', { userId, password, displayName: '復旧する人' });
    expect(res.status).toBe(201);
    const body = (await res.json()) as RegisterResponse;
    return { userId, password, code: body.recoveryCode, id: body.user.id };
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

  describe('再設定できる', () => {
    it('パスワードを入れ替え、使ったコードを無効にして、新しいコードを1つだけ発行する', async () => {
      const user = await register();
      const res = await post('recovery', {
        userId: user.userId,
        recoveryCode: user.code,
        newPassword: 'brand-new-password',
      });

      expect(res.status).toBe(200);
      const { recoveryCode } = (await res.json()) as RecoveryResponse;
      expect(recoveryCode).toMatch(CODE_FORMAT);
      expect(recoveryCode).not.toBe(user.code);

      expect(
        (await post('login', { userId: user.userId, password: 'brand-new-password' })).status,
      ).toBe(200);
      expect((await post('login', { userId: user.userId, password: user.password })).status).toBe(
        401,
      );

      const codes = await prisma.recoveryCode.findMany({ where: { userId: user.id } });
      expect(codes).toHaveLength(2);
      expect(codes.filter((code) => code.usedAt === null)).toHaveLength(1);
    });

    it('使ったコードはもう使えず、新しいコードで再設定できる', async () => {
      const user = await register();
      const first = await post('recovery', {
        userId: user.userId,
        recoveryCode: user.code,
        newPassword: 'second-password',
      });
      const { recoveryCode } = (await first.json()) as RecoveryResponse;
      await sleep(1_100); // 下の失敗の待ち時間を越えるため（アカウント単位の制限）

      expect(
        (
          await post('recovery', {
            userId: user.userId,
            recoveryCode: user.code,
            newPassword: 'third-password',
          })
        ).status,
      ).toBe(401);
      await sleep(1_100);
      expect(
        (
          await post('recovery', {
            userId: user.userId,
            recoveryCode,
            newPassword: 'third-password',
          })
        ).status,
      ).toBe(200);
    });

    // 機能一覧 1.1: ユーザーID は大文字小文字を区別しない。コードは紙に控えて打ち直すため、小文字・ハイフン無しも受け付ける。
    it('大文字小文字の違うユーザーID と、小文字・ハイフン無しのコードで再設定できる', async () => {
      const user = await register();
      const res = await post('recovery', {
        userId: user.userId.toLowerCase(),
        recoveryCode: user.code.replaceAll('-', '').toLowerCase(),
        newPassword: 'lowercase-password',
      });
      expect(res.status).toBe(200);
    });

    // OWASP Forgot Password Cheat Sheet「invalidate the sessions automatically」。
    it('その利用者のリフレッシュトークンをすべて失効させる', async () => {
      const user = await register();
      expect((await post('login', { userId: user.userId, password: user.password })).status).toBe(
        200,
      );
      expect((await post('login', { userId: user.userId, password: user.password })).status).toBe(
        200,
      );

      await post('recovery', {
        userId: user.userId,
        recoveryCode: user.code,
        newPassword: 'session-password',
      });

      const tokens = await prisma.refreshToken.findMany({ where: { userId: user.id } });
      expect(tokens).toHaveLength(2);
      expect(tokens.every((token) => token.revokedAt !== null)).toBe(true);
    });
  });

  describe('再設定できない', () => {
    it('コードが違う・ID が無い・退会済みは、同じ 401 の本体を返し、パスワードを変えない', async () => {
      const user = await register();
      const deleted = await register();
      const deletedBefore = await prisma.user.update({
        where: { id: deleted.id },
        data: { deletedAt: new Date() },
      });

      const responses = [
        await post('recovery', {
          userId: user.userId,
          recoveryCode: 'AAAA-AAAA-AAAA-AAAA',
          newPassword: 'wrong-code-pass',
        }),
        await post('recovery', {
          userId: uniqueUserId(),
          recoveryCode: user.code,
          newPassword: 'no-user-password',
        }),
        await post('recovery', {
          userId: deleted.userId,
          recoveryCode: deleted.code,
          newPassword: 'deleted-password',
        }),
      ];
      const bodies: ErrorResponse[] = [];
      for (const res of responses) {
        expect(res.status).toBe(401);
        bodies.push((await res.json()) as ErrorResponse);
      }
      expect(bodies[0]?.code).toBe('invalid_credentials');
      expect(bodies[1]).toEqual(bodies[0]);
      expect(bodies[2]).toEqual(bodies[0]);

      await sleep(1_100);
      expect((await post('login', { userId: user.userId, password: user.password })).status).toBe(
        200,
      );
      const deletedRow = await prisma.user.findUniqueOrThrow({ where: { id: deleted.id } });
      const unchanged = await prisma.recoveryCode.findMany({ where: { userId: deleted.id } });
      expect(deletedRow.passwordHash).toBe(deletedBefore.passwordHash);
      expect(unchanged).toHaveLength(1);
      expect(unchanged[0]?.usedAt).toBeNull();
    });
  });

  describe('レート制限', () => {
    it('アカウント単位: 失敗の直後は、正しいコードでも照合せず 429（Retry-After: 1）', async () => {
      const user = await register();
      await post('recovery', {
        userId: user.userId,
        recoveryCode: 'AAAA-AAAA-AAAA-AAAA',
        newPassword: 'whatever-pass',
      });

      const ip = nextIp();
      const blocked = await post(
        'recovery',
        { userId: user.userId, recoveryCode: user.code, newPassword: 'whatever-pass' },
        ip,
      );
      expect(blocked.status).toBe(429);
      expect(blocked.headers.get('retry-after')).toBe('1');
      expect(((await blocked.json()) as ErrorResponse).code).toBe('too_many_requests');
      // アカウント単位の超過も、発信元単位と同じ形で記録する（#270 第3巡）。
      expect(
        logger.lines.find((l) => l.includes('rate_limit_exceeded') && l.includes(ip)),
      ).toContain('/api/auth/recovery');
    });

    // ログインの失敗と再設定の失敗を同じキーで数えると、パスワードを忘れて何度か誤った利用者が、再設定まで待たされる。
    it('ログインの失敗とは別に数える', async () => {
      const user = await register();
      expect(
        (await post('login', { userId: user.userId, password: 'wrong-password' })).status,
      ).toBe(401);
      const res = await post('recovery', {
        userId: user.userId,
        recoveryCode: user.code,
        newPassword: 'separate-password',
      });
      expect(res.status).toBe(200);
    });

    it('発信元単位: 同じ発信元から 11 回目は 429', async () => {
      const ip = nextIp();
      for (let i = 0; i < RECOVERY_LIMIT_PER_IP; i++) {
        const res = await post(
          'recovery',
          {
            userId: uniqueUserId(),
            recoveryCode: 'AAAA-AAAA-AAAA-AAAA',
            newPassword: 'whatever-pass',
          },
          ip,
        );
        expect(res.status).toBe(401);
      }
      const res = await post(
        'recovery',
        {
          userId: uniqueUserId(),
          recoveryCode: 'AAAA-AAAA-AAAA-AAAA',
          newPassword: 'whatever-pass',
        },
        ip,
      );
      expect(res.status).toBe(429);
      expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(3500);
    });
  });

  it('パスワードとコードをログに出さない', async () => {
    const user = await register();
    const res = await post('recovery', {
      userId: user.userId,
      recoveryCode: user.code,
      newPassword: 'log-hidden-password',
    });
    const { recoveryCode } = (await res.json()) as RecoveryResponse;

    const all = logger.lines.join('\n');
    expect(all).not.toContain('log-hidden-password');
    expect(all).not.toContain(user.code);
    expect(all).not.toContain(recoveryCode);
  });
});
