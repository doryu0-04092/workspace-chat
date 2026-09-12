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
import { TEST_WEB_ORIGIN, stubApiEnv } from '../testing/api-env';
import { CapturingLogger } from '../testing/capturing-logger';
import { POSTGRES_STARTUP_TIMEOUT_MS, startMigratedPostgres } from '../testing/postgres';
import { startValkey } from '../testing/valkey';
import { hashSecret } from './secret-hash';

type RefreshResponse =
  paths['/auth/refresh']['post']['responses'][200]['content']['application/json'];
type ErrorResponse = paths['/auth/refresh']['post']['responses'][
  401 | 403 | 429]['content']['application/json'];

let sequence = 0;
function uniqueUserId(): string {
  sequence += 1;
  return `Refresh_${Date.now().toString(36)}_${sequence}`;
}

let ipSequence = 0;
function nextIp(): string {
  ipSequence += 1;
  return `2001:db8::2:${ipSequence.toString(16)}`;
}

/** ブラウザが同じ origin から送るときのヘッダー（独自のヘッダーと Sec-Fetch-Site）。 */
const SAME_ORIGIN = { 'x-requested-by': 'workspace-chat', 'sec-fetch-site': 'same-origin' };

function setCookie(res: Response): string | undefined {
  return res.headers.getSetCookie().find((c) => c.startsWith('refresh_token='));
}

function cookieValue(res: Response): string | undefined {
  const cookie = setCookie(res);
  return cookie === undefined
    ? undefined
    : decodeURIComponent(cookie.split(';')[0]!.slice('refresh_token='.length));
}

/** Cookie を消す Set-Cookie（値が空で、期限が過去）か。Path が一致しないと、ブラウザは元の Cookie を消さない。 */
function isClearingCookie(res: Response): boolean {
  const cookie = setCookie(res);
  if (cookie === undefined) return false;
  const expires = /Expires=([^;]+)/i.exec(cookie)?.[1];
  return (
    cookie.startsWith('refresh_token=;') &&
    cookie.includes('Path=/api/auth') &&
    expires !== undefined &&
    new Date(expires).getTime() < Date.now()
  );
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

describe('POST /api/auth/refresh・/api/auth/logout（F-02）', () => {
  let postgres: StartedPostgreSqlContainer;
  let valkey: StartedTestContainer;
  let app: INestApplication;
  let base: string;
  let prisma: PrismaService;
  const logger = new CapturingLogger();

  function post(
    path: 'refresh' | 'logout',
    token: string | undefined,
    headers: Record<string, string> = SAME_ORIGIN,
  ): Promise<Response> {
    return fetch(`${base}/api/auth/${path}`, {
      method: 'POST',
      headers: {
        'x-forwarded-for': nextIp(),
        ...(token === undefined ? {} : { cookie: `refresh_token=${encodeURIComponent(token)}` }),
        ...headers,
      },
    });
  }

  /** 利用者を作ってログインし、リフレッシュトークンと User.id を返す。 */
  async function login(
    options: { deleted?: boolean } = {},
  ): Promise<{ token: string; userId: string }> {
    const loginId = uniqueUserId();
    const user = await prisma.user.create({
      data: {
        loginId,
        displayName: '更新する人',
        passwordHash: await hashSecret('refresh-password'),
      },
    });
    const res = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': nextIp() },
      body: JSON.stringify({ userId: loginId, password: 'refresh-password' }),
    });
    expect(res.status).toBe(200);
    if (options.deleted) {
      await prisma.user.update({ where: { id: user.id }, data: { deletedAt: new Date() } });
    }
    return { token: cookieValue(res)!, userId: user.id };
  }

  /** 発行から `hours` 時間経ったことにする。入れ替えは発行から1日を過ぎたトークンでだけ起きる（#303）。 */
  async function age(token: string, hours = 25): Promise<void> {
    await prisma.refreshToken.update({
      where: { tokenHash: sha256Hex(token) },
      data: { createdAt: new Date(Date.now() - hours * 60 * 60 * 1000) },
    });
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

  describe('リフレッシュ', () => {
    it('発行から1日を過ぎたトークンなら、新しいアクセストークンを返し、リフレッシュトークンを同じ系列の新しいものに入れ替える', async () => {
      const { token, userId } = await login();
      await age(token);
      const res = await post('refresh', token);

      expect(res.status).toBe(200);
      const body = (await res.json()) as RefreshResponse;
      expect(body.tokenType).toBe('Bearer');
      expect(body.expiresIn).toBe(15 * 60);
      expect(app.get(JwtService).verify<{ sub: string }>(body.accessToken).sub).toBe(userId);

      const next = cookieValue(res);
      expect(next).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(next).not.toBe(token);
      expect(setCookie(res)).toMatch(/HttpOnly/);
      expect(setCookie(res)).toMatch(/Secure/);
      expect(setCookie(res)).toMatch(/SameSite=Strict/);
      expect(setCookie(res)).toMatch(/Path=\/api\/auth/);

      const old = await prisma.refreshToken.findUniqueOrThrow({
        where: { tokenHash: sha256Hex(token) },
      });
      const current = await prisma.refreshToken.findUniqueOrThrow({
        where: { tokenHash: sha256Hex(next!) },
      });
      expect(old.revokedAt).not.toBeNull();
      expect(current.revokedAt).toBeNull();
      expect(current.familyId).toBe(old.familyId);
    });

    // 決定・2026-09-12・依頼側（#303）: 入れ替えは1日に1回。発行から1日以内は入れ替えず、アクセストークンだけを返す。
    it('発行から1日以内のトークンなら、入れ替えずにアクセストークンだけを返し、同じトークンで何度でもリフレッシュできる', async () => {
      const { token, userId } = await login();
      await age(token, 23);
      const rows = await prisma.refreshToken.count({ where: { userId } });

      for (const res of [await post('refresh', token), await post('refresh', token)]) {
        expect(res.status).toBe(200);
        const body = (await res.json()) as RefreshResponse;
        expect(app.get(JwtService).verify<{ sub: string }>(body.accessToken).sub).toBe(userId);
        // Cookie は出し直さない（今の Cookie をそのまま使う）。
        expect(setCookie(res)).toBeUndefined();
      }
      expect(await prisma.refreshToken.count({ where: { userId } })).toBe(rows);
      const row = await prisma.refreshToken.findUniqueOrThrow({
        where: { tokenHash: sha256Hex(token) },
      });
      expect(row.revokedAt).toBeNull();
    });

    it('発行から1日以内なら、同じトークンで同時にリフレッシュしても両方通る', async () => {
      const { token } = await login();
      const results = await Promise.all([post('refresh', token), post('refresh', token)]);
      expect(results.map((res) => res.status)).toEqual([200, 200]);
    });

    it('入れ替えた後のトークンで、もう一度リフレッシュできる', async () => {
      const { token } = await login();
      await age(token);
      const next = cookieValue(await post('refresh', token))!;
      expect((await post('refresh', next)).status).toBe(200);
    });

    // RFC 9700 4.14.2: 入れ替え済みのトークンが出されたら、盗まれたものとみなして系列ごと失効させる。
    it('入れ替え済みのトークンが出されたら 401 を返し、その系列の新しいトークンも失効させる', async () => {
      const { token } = await login();
      await age(token);
      const next = cookieValue(await post('refresh', token))!;

      const reused = await post('refresh', token);
      expect(reused.status).toBe(401);
      expect(((await reused.json()) as ErrorResponse).code).toBe('invalid_token');
      expect((await post('refresh', next)).status).toBe(401);
    });

    // 期限は入れ替えのたびに延びるため、系列が生きたまま、入れ替え済みの古いトークンだけが期限切れになる。
    it('入れ替え済みのトークンが期限切れでも、出されたら系列ごと失効させる', async () => {
      const { token } = await login();
      await age(token);
      const next = cookieValue(await post('refresh', token))!;
      await prisma.refreshToken.update({
        where: { tokenHash: sha256Hex(token) },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      expect((await post('refresh', token)).status).toBe(401);
      expect((await post('refresh', next)).status).toBe(401);
    });

    it('発行から1日を過ぎたトークンで同時にリフレッシュしても、入れ替えに成功するのは1つだけである', async () => {
      const { token } = await login();
      await age(token);
      const results = await Promise.all([post('refresh', token), post('refresh', token)]);
      expect(results.filter((res) => res.status === 200)).toHaveLength(1);
    });

    it.each([
      ['Cookie が無い', undefined],
      ['知らないトークン', 'A'.repeat(43)],
    ])('%s なら 401 で、Cookie を消す', async (_label, token) => {
      const res = await post('refresh', token);
      expect(res.status).toBe(401);
      expect(((await res.json()) as ErrorResponse).code).toBe('invalid_token');
      expect(isClearingCookie(res)).toBe(true);
      // Cookie の経路の 401 は Bearer で守る資源ではないため、WWW-Authenticate は付けない（#297）。
      expect(res.headers.get('www-authenticate')).toBeNull();
    });

    it('期限切れのトークンは 401', async () => {
      const { token } = await login();
      await prisma.refreshToken.update({
        where: { tokenHash: sha256Hex(token) },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      expect((await post('refresh', token)).status).toBe(401);
    });

    // 機能一覧 1.5: 退会したらトークンの再発行はできない。
    it('退会済みの利用者のトークンは 401', async () => {
      const { token } = await login({ deleted: true });
      expect((await post('refresh', token)).status).toBe(401);
    });
  });

  describe('ログアウト', () => {
    it('204 を返して Cookie を消し、そのトークンではもうリフレッシュできない', async () => {
      const { token } = await login();
      const res = await post('logout', token);
      expect(res.status).toBe(204);
      expect(isClearingCookie(res)).toBe(true);
      expect((await post('refresh', token)).status).toBe(401);
    });

    it('入れ替えた後にログアウトしたら、その系列のどのトークンでもリフレッシュできない', async () => {
      const { token } = await login();
      await age(token);
      const next = cookieValue(await post('refresh', token))!;
      expect((await post('logout', next)).status).toBe(204);
      expect((await post('refresh', next)).status).toBe(401);
    });

    // 入れ替え前の古いトークンでログアウトしても、系列の今のトークンまで失効させる（使ったトークンの行だけを失効させない）。
    it('入れ替え前のトークンでログアウトしても、系列の今のトークンでリフレッシュできない', async () => {
      const { token } = await login();
      await age(token);
      const next = cookieValue(await post('refresh', token))!;
      expect((await post('logout', token)).status).toBe(204);
      expect((await post('refresh', next)).status).toBe(401);
    });

    it('別のログイン（別の系列）のトークンは失効させない', async () => {
      const first = await login();
      const secondRes = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': nextIp() },
        body: JSON.stringify({
          userId: (await prisma.user.findUniqueOrThrow({ where: { id: first.userId } })).loginId,
          password: 'refresh-password',
        }),
      });
      const second = cookieValue(secondRes)!;
      expect((await post('logout', first.token)).status).toBe(204);
      expect((await post('refresh', second)).status).toBe(200);
    });

    it.each([
      ['Cookie が無い', undefined],
      ['知らないトークン', 'A'.repeat(43)],
    ])('%s でも 204 で、Cookie を消す', async (_label, token) => {
      const res = await post('logout', token);
      expect(res.status).toBe(204);
      expect(isClearingCookie(res)).toBe(true);
    });
  });

  // 機能一覧 1.2 / 要件定義書 4.3: Cookie を使う2つのエンドポイントは、独自のヘッダーの無い要求と、同じ origin からでない要求を拒否する。
  describe.each(['refresh', 'logout'] as const)('/api/auth/%s の CSRF の対処', (path) => {
    it('X-Requested-By が無ければ 400 で、トークンを使わない', async () => {
      const { token } = await login();
      if (path === 'refresh') await age(token);
      const res = await post(path, token, { 'sec-fetch-site': 'same-origin' });
      expect(res.status).toBe(400);
      expect((await post('refresh', token)).status).toBe(200);
    });

    it.each([
      ['Sec-Fetch-Site が cross-site', { 'sec-fetch-site': 'cross-site', origin: TEST_WEB_ORIGIN }],
      ['Origin が別の origin', { origin: 'https://evil.example.com' }],
      ['Referer が別の origin', { referer: 'https://evil.example.com/' }],
      ['Sec-Fetch-Site・Origin・Referer のどれも無い', {}],
    ])('%s なら 403（csrf_rejected）で、トークンを使わない', async (_label, headers) => {
      const { token } = await login();
      // 発行直後のトークンは1日以内で入れ替わらないため、age せずに続くリフレッシュが 200 であることを見ても
      // 「拒否された要求がトークンを消費したか」は見分けられない。refresh の経路では age してから確かめる（#328）。
      if (path === 'refresh') await age(token);
      const res = await post(path, token, { 'x-requested-by': 'workspace-chat', ...headers });
      expect(res.status).toBe(403);
      expect(((await res.json()) as ErrorResponse).code).toBe('csrf_rejected');
      expect((await post('refresh', token)).status).toBe(200);
    });

    it.each([
      ['Origin が web の origin', { origin: TEST_WEB_ORIGIN }],
      ['Referer が web の origin の下', { referer: `${TEST_WEB_ORIGIN}/channels` }],
    ])('%s なら通す', async (_label, headers) => {
      const { token } = await login();
      const res = await post(path, token, { 'x-requested-by': 'workspace-chat', ...headers });
      expect(res.status).toBe(path === 'refresh' ? 200 : 204);
    });
  });

  // 決定・2026-09-12・依頼側（#270）: 発信元単位で 15 分に 60 回。超過と、失効済みトークンの再利用は不正アクセスの疑いとして記録する。
  describe('レート制限と記録（#270）', () => {
    const LIMIT = 60;

    it('リフレッシュは同じ発信元から 61 回目で 429（Retry-After は 15 分）', async () => {
      const ip = nextIp();
      for (let i = 0; i < LIMIT; i += 1) {
        expect(
          (await post('refresh', undefined, { ...SAME_ORIGIN, 'x-forwarded-for': ip })).status,
        ).toBe(401);
      }
      const res = await post('refresh', undefined, { ...SAME_ORIGIN, 'x-forwarded-for': ip });
      expect(res.status).toBe(429);
      expect(((await res.json()) as ErrorResponse).code).toBe('too_many_requests');
      const retryAfter = Number(res.headers.get('retry-after'));
      expect(retryAfter).toBeGreaterThan(850);
      expect(retryAfter).toBeLessThanOrEqual(900);
    });

    it('ログアウトも同じ上限で、別の発信元は止めない', async () => {
      const ip = nextIp();
      for (let i = 0; i < LIMIT; i += 1) {
        expect(
          (await post('logout', undefined, { ...SAME_ORIGIN, 'x-forwarded-for': ip })).status,
        ).toBe(204);
      }
      expect(
        (await post('logout', undefined, { ...SAME_ORIGIN, 'x-forwarded-for': ip })).status,
      ).toBe(429);
      expect(
        (await post('logout', undefined, { ...SAME_ORIGIN, 'x-forwarded-for': nextIp() })).status,
      ).toBe(204);
    });

    it('CSRF で拒否された要求も枠を使う（レート制限は CSRF の判定より先に数える）', async () => {
      const ip = nextIp();
      for (let i = 0; i < LIMIT; i += 1) {
        const res = await post('refresh', undefined, {
          'x-requested-by': 'workspace-chat',
          'sec-fetch-site': 'cross-site',
          origin: TEST_WEB_ORIGIN,
          'x-forwarded-for': ip,
        });
        expect(res.status).toBe(403);
      }
      const res = await post('refresh', undefined, { ...SAME_ORIGIN, 'x-forwarded-for': ip });
      expect(res.status).toBe(429);
    });

    // 機能一覧 1.2: 独自ヘッダーの無い要求は仕様の検証で 400 になり、レート制限の枠を消費しない。
    it('独自ヘッダーの無い要求は、上限を超えて送っても 400 のままで、枠を消費しない', async () => {
      const ip = nextIp();
      for (let i = 0; i <= LIMIT; i += 1) {
        const res = await post('refresh', undefined, {
          'sec-fetch-site': 'same-origin',
          'x-forwarded-for': ip,
        });
        expect(res.status).toBe(400);
      }
      // 枠を消費していなければ、続く正当な要求はまだ 1 回目であり 429 にはならない（トークンが無いので 401）。
      const res = await post('refresh', undefined, { ...SAME_ORIGIN, 'x-forwarded-for': ip });
      expect(res.status).toBe(401);
    });

    it('上限の超過を、制限の種類（ip）・発信元・パスとともに記録する', async () => {
      const ip = nextIp();
      const before = logger.lines.length;
      for (let i = 0; i <= LIMIT; i += 1) {
        await post('refresh', undefined, { ...SAME_ORIGIN, 'x-forwarded-for': ip });
      }
      const line = logger.lines.slice(before).find((l) => l.includes('rate_limit_exceeded'));
      expect(line).toBeDefined();
      expect(line).toContain('/api/auth/refresh');
      expect(line).toContain(ip);
      expect(line).toContain('"limit":"ip"');
    });

    it('入れ替え済みのトークンの再利用を、系列と利用者の ID で記録し、トークンは載せない', async () => {
      const { token, userId } = await login();
      await age(token);
      const next = cookieValue(await post('refresh', token))!;
      const before = logger.lines.length;
      expect((await post('refresh', token)).status).toBe(401);

      const family = (
        await prisma.refreshToken.findUniqueOrThrow({ where: { tokenHash: sha256Hex(token) } })
      ).familyId;
      const line = logger.lines.slice(before).find((l) => l.includes('refresh_token_reuse'));
      expect(line).toBeDefined();
      expect(line).toContain(family);
      expect(line).toContain(userId);
      expect(line).not.toContain(token);
      expect(line).not.toContain(next);
    });
  });

  // 決定・2026-09-12・依頼側（#270）: 期限切れ・失効から 30 日で消す。
  describe('使い終わった行の後始末（#270）', () => {
    it('ログインのたびに、その利用者の期限切れ・失効のうち早く起きた方から 30 日を過ぎた行を消し、それ以外は残す', async () => {
      const { userId } = await login();
      const day = 24 * 60 * 60 * 1000;
      const old = new Date(Date.now() - 31 * day);
      const recent = new Date(Date.now() - 29 * day);
      const future = new Date(Date.now() + 14 * day);
      await prisma.refreshToken.createMany({
        data: [
          { userId, tokenHash: sha256Hex('old-expired'), expiresAt: old },
          { userId, tokenHash: sha256Hex('old-revoked'), expiresAt: future, revokedAt: old },
          { userId, tokenHash: sha256Hex('recent-revoked'), expiresAt: future, revokedAt: recent },
          { userId, tokenHash: sha256Hex('recent-expired'), expiresAt: recent },
          // 期限切れの後に失効した行（期限は古く、失効は直近）。早い側（期限切れ）から 30 日で消える（#312）。
          {
            userId,
            tokenHash: sha256Hex('old-expired-recent-revoked'),
            expiresAt: old,
            revokedAt: recent,
          },
        ],
      });
      // 別の利用者の期限切れの行は、その利用者がログインしても消えない（後始末はログインした本人の行だけに限る。#320）。
      const other = await login();
      await prisma.refreshToken.update({
        where: { tokenHash: sha256Hex(other.token) },
        data: { expiresAt: old },
      });

      const loginId = (await prisma.user.findUniqueOrThrow({ where: { id: userId } })).loginId;
      const res = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': nextIp() },
        body: JSON.stringify({ userId: loginId, password: 'refresh-password' }),
      });
      expect(res.status).toBe(200);

      const remaining = (await prisma.refreshToken.findMany({ where: { userId } })).map(
        (r) => r.tokenHash,
      );
      expect(remaining).not.toContain(sha256Hex('old-expired'));
      expect(remaining).not.toContain(sha256Hex('old-revoked'));
      expect(remaining).not.toContain(sha256Hex('old-expired-recent-revoked'));
      expect(remaining).toContain(sha256Hex('recent-revoked'));
      expect(remaining).toContain(sha256Hex('recent-expired'));
      // いま生きている2本（最初のログインと今回のログイン）
      expect(remaining).toHaveLength(4);

      const otherRemaining = (
        await prisma.refreshToken.findMany({ where: { userId: other.userId } })
      ).map((r) => r.tokenHash);
      expect(otherRemaining).toContain(sha256Hex(other.token));
    });

    // 決定・2026-09-12・依頼側（#303）: 使い続ける利用者はログインし直さないため、入れ替え（1日に1回）のときにも同じ後始末をする。
    it('入れ替えのときにも、その利用者の期限切れ・失効のうち早く起きた方から 30 日を過ぎた行を消す', async () => {
      const { token, userId } = await login();
      await age(token);
      const day = 24 * 60 * 60 * 1000;
      const future = new Date(Date.now() + 14 * day);
      await prisma.refreshToken.createMany({
        data: [
          {
            userId,
            tokenHash: sha256Hex('rotate-old-revoked'),
            expiresAt: future,
            revokedAt: new Date(Date.now() - 31 * day),
          },
          {
            userId,
            tokenHash: sha256Hex('rotate-recent-revoked'),
            expiresAt: future,
            revokedAt: new Date(Date.now() - 29 * day),
          },
        ],
      });

      const res = await post('refresh', token);
      expect(res.status).toBe(200);
      expect(cookieValue(res)).toBeDefined();

      const remaining = (await prisma.refreshToken.findMany({ where: { userId } })).map(
        (r) => r.tokenHash,
      );
      expect(remaining).not.toContain(sha256Hex('rotate-old-revoked'));
      expect(remaining).toContain(sha256Hex('rotate-recent-revoked'));
    });
  });

  it('トークンをログに出さない', async () => {
    const { token } = await login();
    await age(token);
    const res = await post('refresh', token);
    const next = cookieValue(res)!;
    const { accessToken } = (await res.json()) as RefreshResponse;
    await post('refresh', token); // 再利用の検知の経路
    await post('logout', next);

    const all = logger.lines.join('\n');
    expect(all).not.toContain(token);
    expect(all).not.toContain(next);
    expect(all).not.toContain(accessToken);
  });
});
