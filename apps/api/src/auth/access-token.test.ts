import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { type INestApplication, RequestMethod, type Type } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ModulesContainer, Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { paths } from '@workspace-chat/shared';
import type { StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { createApp } from '../app-setup';
import { OPENAPI_SPEC_PATH } from '../openapi-validation';
import { PrismaService } from '../prisma.service';
import { stubApiEnv } from '../testing/api-env';
import { CapturingLogger } from '../testing/capturing-logger';
import { POSTGRES_STARTUP_TIMEOUT_MS, startMigratedPostgres } from '../testing/postgres';
import { startValkey } from '../testing/valkey';
import { isPublicRoute } from './access-token.guard';
import { hashSecret } from './secret-hash';

type ErrorResponse = paths['/users/me']['get']['responses'][401]['content']['application/json'];

let sequence = 0;
let ipSequence = 0;
function nextIp(): string {
  ipSequence += 1;
  return `2001:db8::7:${ipSequence.toString(16)}`;
}

function base64url(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch'] as const;

/** 仕様の操作ごとに、認証を要さない（`security: []`）かどうか。`METHOD パス` の形で並べる。 */
function specRoutes(): string[] {
  const spec = parse(readFileSync(OPENAPI_SPEC_PATH, 'utf8')) as {
    security?: unknown;
    paths: Record<string, Partial<Record<(typeof HTTP_METHODS)[number], { security?: unknown }>>>;
  };
  expect(spec.security).toEqual([{ bearerAuth: [] }]);
  return Object.entries(spec.paths).flatMap(([path, item]) =>
    HTTP_METHODS.filter((method) => item[method] !== undefined).map((method) => {
      const security = item[method]!.security;
      const open = Array.isArray(security) && security.length === 0;
      return `${method.toUpperCase()} ${path.replace(/\{(\w+)\}/g, ':$1')} ${open ? 'public' : 'auth'}`;
    }),
  );
}

/** Nest に登録したルートごとに、`@Public()` かどうか。前置き /api は仕様の servers にあたるため付けない。 */
function nestRoutes(app: INestApplication): string[] {
  const reflector = app.get(Reflector);
  const routes: string[] = [];
  for (const module of app.get(ModulesContainer).values()) {
    for (const wrapper of module.controllers.values()) {
      const controller = wrapper.metatype as Type<unknown> | null;
      if (!controller) continue;
      const prefix = String(Reflect.getMetadata(PATH_METADATA, controller) ?? '');
      const prototype = controller.prototype as Record<string, unknown>;
      for (const name of Object.getOwnPropertyNames(prototype)) {
        const handler = prototype[name];
        if (typeof handler !== 'function' || name === 'constructor') continue;
        const method = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
        if (method === undefined) continue;
        const path = `/${prefix}/${String(Reflect.getMetadata(PATH_METADATA, handler) ?? '')}`
          .replace(/\/+/g, '/')
          .replace(/(.)\/$/, '$1');
        const open = isPublicRoute(reflector, handler as () => unknown, controller);
        routes.push(`${RequestMethod[method]} ${path} ${open ? 'public' : 'auth'}`);
      }
    }
  }
  return routes;
}

// 機能一覧 1.4（F-05）: トークンから利用者を解決する入口。退会済みのトークンは読み取り・書き込みを問わず 401 で、
// 応答は無効なトークンと同じにする（RFC 6750 の invalid_token）。
describe('アクセストークンの入口（F-05）', () => {
  let postgres: StartedPostgreSqlContainer;
  let valkey: StartedTestContainer;
  let app: INestApplication;
  let base: string;
  let prisma: PrismaService;
  const logger = new CapturingLogger();

  /** 利用者を作ってログインし、アクセストークンと User.id を返す。 */
  async function login(): Promise<{ accessToken: string; id: string }> {
    sequence += 1;
    const loginId = `Access_${Date.now().toString(36)}_${sequence}`;
    const user = await prisma.user.create({
      data: {
        loginId,
        displayName: '入口の人',
        passwordHash: await hashSecret('access-password'),
      },
    });
    const res = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': nextIp() },
      body: JSON.stringify({ userId: loginId, password: 'access-password' }),
    });
    expect(res.status).toBe(200);
    const { accessToken } = (await res.json()) as { accessToken: string };
    return { accessToken, id: user.id };
  }

  function getMe(authorization?: string): Promise<Response> {
    return fetch(`${base}/api/users/me`, {
      headers: authorization === undefined ? {} : { authorization },
    });
  }

  function patchMe(authorization: string | undefined, body: object): Promise<Response> {
    return fetch(`${base}/api/users/me`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        ...(authorization === undefined ? {} : { authorization }),
      },
      body: JSON.stringify(body),
    });
  }

  async function expectInvalidToken(res: Response): Promise<void> {
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Bearer error="invalid_token"');
    expect((await res.json()) as ErrorResponse).toEqual({
      code: 'invalid_token',
      message: 'ログインし直してください',
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

  // 既定ですべてのルートに掛け、外すものを明示する形にした以上、外し忘れ・外し過ぎは仕様とのずれとして出る。
  it('認証を要さないルート（@Public）は、仕様で security: [] を持つ操作と一致する', () => {
    expect(nestRoutes(app).sort()).toEqual(specRoutes().sort());
  });

  it('トークンがあれば、その利用者として通す（Bearer の大文字小文字は問わない）', async () => {
    const { accessToken, id } = await login();
    const res = await getMe(`Bearer ${accessToken}`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { id: string }).id).toBe(id);
    expect((await getMe(`bearer ${accessToken}`)).status).toBe(200);
  });

  it.each([
    ['Authorization ヘッダーが無い', undefined],
    ['Bearer 以外の方式', 'Basic dXNlcjpwYXNz'],
  ])('%s: 401（authentication_required）と WWW-Authenticate: Bearer', async (_label, header) => {
    const res = await getMe(header);
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Bearer');
    expect(((await res.json()) as ErrorResponse).code).toBe('authentication_required');
  });

  it('書き込み（PATCH）も、トークンが無ければ 401', async () => {
    const res = await patchMe(undefined, { displayName: '変える' });
    expect(res.status).toBe(401);
    expect(((await res.json()) as ErrorResponse).code).toBe('authentication_required');
  });

  describe('使えないトークンは、どれも同じ 401（invalid_token）', () => {
    it('JWT の形でない', async () => {
      await expectInvalidToken(await getMe('Bearer not-a-jwt'));
      await expectInvalidToken(await getMe('Bearer '));
    });

    it('別の鍵で署名した', async () => {
      const { id } = await login();
      const forged = new JwtService({ secret: 'x'.repeat(48) }).sign({ sub: id });
      await expectInvalidToken(await getMe(`Bearer ${forged}`));
    });

    it('期限が切れた', async () => {
      const { id } = await login();
      const expired = new JwtService({ secret: process.env.JWT_SECRET }).sign({
        sub: id,
        exp: Math.floor(Date.now() / 1000) - 10,
      });
      await expectInvalidToken(await getMe(`Bearer ${expired}`));
    });

    // RFC 8725 3.1: 検証するアルゴリズムを HS256 に限る。
    it('alg: none や HS256 以外のアルゴリズムを名乗る', async () => {
      const { id } = await login();
      const none = `${base64url({ alg: 'none', typ: 'JWT' })}.${base64url({ sub: id })}.`;
      await expectInvalidToken(await getMe(`Bearer ${none}`));
      const hs512 = new JwtService({ secret: process.env.JWT_SECRET }).sign(
        { sub: id },
        { algorithm: 'HS512' },
      );
      await expectInvalidToken(await getMe(`Bearer ${hs512}`));
    });

    it('sub が User.id の形でない・その利用者がいない（500 にしない）', async () => {
      const signer = new JwtService({ secret: process.env.JWT_SECRET });
      await expectInvalidToken(await getMe(`Bearer ${signer.sign({ sub: 'not-a-uuid' })}`));
      await expectInvalidToken(await getMe(`Bearer ${signer.sign({})}`));
      await expectInvalidToken(await getMe(`Bearer ${signer.sign({ sub: randomUUID() })}`));
    });

    // 機能一覧 1.4「退会済みのトークンで、読み取りと書き込みの両方が拒否されること」。
    it('退会済みの利用者のトークンは、読み取りも書き込みも拒否し、書き込みを反映しない', async () => {
      const { accessToken, id } = await login();
      await prisma.user.update({ where: { id }, data: { deletedAt: new Date() } });

      await expectInvalidToken(await getMe(`Bearer ${accessToken}`));
      await expectInvalidToken(await patchMe(`Bearer ${accessToken}`, { displayName: '退会後' }));
      expect((await prisma.user.findUniqueOrThrow({ where: { id } })).displayName).toBe('入口の人');
    });
  });

  it('アクセストークンをログに出さない', async () => {
    const { accessToken, id } = await login();
    await getMe(`Bearer ${accessToken}`);
    await prisma.user.update({ where: { id }, data: { deletedAt: new Date() } });
    await getMe(`Bearer ${accessToken}`);
    expect(logger.lines.join('\n')).not.toContain(accessToken);
  });
});
