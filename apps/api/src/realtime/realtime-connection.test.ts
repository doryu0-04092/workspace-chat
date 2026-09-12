import 'reflect-metadata';
import type { AddressInfo } from 'node:net';
import { type INestApplication, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { REALTIME_PATH, REALTIME_TRANSPORTS } from '@workspace-chat/shared';
import { io, type Socket } from 'socket.io-client';
import type { StartedTestContainer } from 'testcontainers';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app-setup';
import { AccessTokenResolver } from '../auth/access-token.guard';
import { hashSecret } from '../auth/secret-hash';
import { PrismaService } from '../prisma.service';
import { TEST_WEB_ORIGIN, stubApiEnv } from '../testing/api-env';
import { POSTGRES_STARTUP_TIMEOUT_MS, startMigratedPostgres } from '../testing/postgres';
import { startValkey } from '../testing/valkey';
import { RealtimeEmitter } from './realtime.emitter';

type Transport = 'websocket' | 'polling';

type ConnectOptions = {
  origin?: string;
  token?: unknown;
  cookie?: string;
  transport?: Transport;
  path?: string;
};

let sequence = 0;
let ipSequence = 0;
function nextIp(): string {
  ipSequence += 1;
  return `2001:db8::9:${ipSequence.toString(16)}`;
}

/**
 * 接続できれば Socket を、断られれば connect_error の Error を返す。
 * transports の既定はクライアントが使う形（REALTIME_TRANSPORTS）。transport はそれ以外の経路を確かめるときにだけ指定する。
 */
function connect(
  base: string,
  { origin = TEST_WEB_ORIGIN, token, cookie, transport, path = REALTIME_PATH }: ConnectOptions,
): Promise<
  { socket: Socket; error?: undefined } | { socket: Socket; error: Error & { data?: unknown } }
> {
  const socket = io(base, {
    path,
    transports: transport === undefined ? [...REALTIME_TRANSPORTS] : [transport],
    reconnection: false,
    forceNew: true,
    timeout: 5_000,
    ...(token === undefined ? {} : { auth: { token } }),
    extraHeaders: {
      ...(origin === '' ? {} : { origin }),
      ...(cookie === undefined ? {} : { cookie }),
    },
  });
  return new Promise((resolve) => {
    socket.once('connect', () => resolve({ socket }));
    socket.once('connect_error', (error) => {
      socket.close();
      resolve({ socket, error: error as Error & { data?: unknown } });
    });
  });
}

/** 次に届くイベントを待つ。届かなければ undefined。 */
function nextEvent(socket: Socket, event: string, timeoutMs = 2_000): Promise<unknown> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), timeoutMs);
    socket.once(event, (payload: unknown) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

// 機能一覧 5.2・9.2、要件定義書 4.2・4.3・4.8 の4（許可外の Origin からのハンドシェイクを拒否する）。
describe('Socket.IO の接続の入口（F-16）', () => {
  let postgres: StartedPostgreSqlContainer;
  let valkey: StartedTestContainer;
  let first: INestApplication;
  let second: INestApplication;
  let firstBase: string;
  let secondBase: string;
  let prisma: PrismaService;
  const opened: Socket[] = [];

  async function listen(app: INestApplication): Promise<string> {
    await app.listen(0, '127.0.0.1');
    const { port } = app.getHttpServer().address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  /** 利用者を作ってログインし、アクセストークンと User.id を返す。 */
  async function login(): Promise<{ token: string; id: string }> {
    sequence += 1;
    const loginId = `Socket_${Date.now().toString(36)}_${sequence}`;
    const user = await prisma.user.create({
      data: {
        loginId,
        displayName: '接続する人',
        passwordHash: await hashSecret('socket-password'),
      },
    });
    const res = await fetch(`${firstBase}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': nextIp() },
      body: JSON.stringify({ userId: loginId, password: 'socket-password' }),
    });
    expect(res.status).toBe(200);
    const { accessToken } = (await res.json()) as { accessToken: string };
    return { token: accessToken, id: user.id };
  }

  async function open(base: string, options: ConnectOptions) {
    const result = await connect(base, options);
    opened.push(result.socket);
    return result;
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
    // タスクを2つに見立てる。Valkey のアダプタを通さないと、別のタスクに繋いだ利用者へ届かない。
    first = await createApp({ logger: false });
    second = await createApp({ logger: false });
    firstBase = await listen(first);
    secondBase = await listen(second);
    prisma = first.get(PrismaService);
  }, POSTGRES_STARTUP_TIMEOUT_MS);

  afterEach(() => {
    for (const socket of opened.splice(0)) socket.close();
  });

  afterAll(async () => {
    await first?.close();
    await second?.close();
    await postgres?.stop();
    await valkey?.stop();
    vi.unstubAllEnvs();
  });

  describe('Origin（CSWSH の対処。allowRequest）', () => {
    it.each<Transport>(['websocket', 'polling'])(
      '許可した Origin からは接続できる（%s）',
      async (transport) => {
        const { token } = await login();
        const { error, socket } = await open(firstBase, { token, transport });
        expect(error).toBeUndefined();
        expect(socket.connected).toBe(true);
      },
    );

    it.each<[string, string, Transport]>([
      ['別の origin', 'http://evil.test', 'websocket'],
      ['別の origin', 'http://evil.test', 'polling'],
      ['ポートだけ違う origin', 'http://web.test:8080', 'websocket'],
      ['Origin を持たない', '', 'websocket'],
      ['Origin を持たない', '', 'polling'],
    ])(
      '%s（%s・%s）からは、トークンが正しくても接続できない',
      async (_label, origin, transport) => {
        const { token } = await login();
        const { error, socket } = await open(firstBase, { token, origin, transport });
        expect(error).toBeDefined();
        expect(socket.connected).toBe(false);
      },
    );
  });

  it('ハンドシェイクのパスは /api/socket.io/ で、既定の /socket.io/ では繋がらない', async () => {
    const { token } = await login();
    const { error } = await open(firstBase, { token, path: '/socket.io/' });
    expect(error).toBeDefined();
  });

  describe('トークン（ハンドシェイクの auth）', () => {
    it('auth にトークンが無ければ authentication_required で断る（Cookie では渡せない）', async () => {
      const { token } = await login();
      for (const options of [{}, { cookie: `access_token=${token}` }, { token: 42 }]) {
        const { error } = await open(firstBase, options);
        expect(error?.data).toEqual({ code: 'authentication_required' });
      }
    });

    it('使えないトークン・退会済みの利用者のトークンは、どれも invalid_token で断る', async () => {
      const { token, id } = await login();
      const other = await login();
      const forged = new JwtService({ secret: 'x'.repeat(48) }).sign({ sub: other.id });
      const expired = new JwtService({ secret: process.env.JWT_SECRET }).sign({
        sub: other.id,
        exp: Math.floor(Date.now() / 1000) - 10,
      });
      await prisma.user.update({ where: { id }, data: { deletedAt: new Date() } });

      for (const bad of ['not-a-jwt', forged, expired, token]) {
        const { error, socket } = await open(firstBase, { token: bad });
        expect(error?.data).toEqual({ code: 'invalid_token' });
        expect(socket.connected).toBe(false);
      }
    });
  });

  describe('利用者の部屋（機能一覧 9.2）', () => {
    it('利用者の部屋へ送ったイベントは、別のタスクに繋いだその利用者の接続すべてに1回ずつ届き、他の利用者には届かない', async () => {
      const alice = await login();
      const bob = await login();
      const aliceOnSecond = await open(secondBase, { token: alice.token });
      const aliceOnFirst = await open(firstBase, { token: alice.token });
      const bobOnSecond = await open(secondBase, { token: bob.token });

      const received = [
        nextEvent(aliceOnSecond.socket, 'presence:changed'),
        nextEvent(aliceOnFirst.socket, 'presence:changed'),
        nextEvent(bobOnSecond.socket, 'presence:changed', 1_000),
      ];
      first.get(RealtimeEmitter).toUsers([alice.id], 'presence:changed', { probe: 1 });

      expect(await Promise.all(received)).toEqual([{ probe: 1 }, { probe: 1 }, undefined]);
    });

    it('複数の利用者の部屋へ1回で送ると、両方の部屋に入っている接続にも1回だけ届く', async () => {
      const alice = await login();
      const bob = await login();
      const aliceSocket = (await open(firstBase, { token: alice.token })).socket;
      const bobSocket = (await open(secondBase, { token: bob.token })).socket;
      const count = { alice: 0, bob: 0 };
      aliceSocket.on('message:new', () => (count.alice += 1));
      bobSocket.on('message:new', () => (count.bob += 1));

      first.get(RealtimeEmitter).toUsers([alice.id, bob.id, alice.id], 'message:new', {});
      await new Promise((resolve) => setTimeout(resolve, 1_000));

      expect(count).toEqual({ alice: 1, bob: 1 });
    });

    // Socket.IO は宛先の部屋が空だと、部屋で絞らずに名前空間の全接続へ送る。宛先を確かめた結果が 0 人になる呼び出しはありうる。
    it('宛先が空なら、どの接続にも届かない', async () => {
      const alice = await login();
      const aliceSocket = (await open(firstBase, { token: alice.token })).socket;
      const received = nextEvent(aliceSocket, 'message:new', 1_000);

      first.get(RealtimeEmitter).toUsers([], 'message:new', { leaked: true });

      expect(await received).toBeUndefined();
    });
  });

  // 機能一覧 1.4 / error-response.ts と同じ決め: 想定外の失敗は、例外のメッセージを応答に載せず、ログに error で残す。
  it('ハンドシェイクの想定外の失敗は、例外のメッセージを渡さず internal_error で断り、ログに残す', async () => {
    const { token } = await login();
    const resolver = first.get(AccessTokenResolver);
    const failing = vi
      .spyOn(resolver, 'resolve')
      .mockRejectedValueOnce(new Error('secret-looking detail from prisma'));
    const logged = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      const { error, socket } = await open(firstBase, { token });
      expect(socket.connected).toBe(false);
      expect(error?.data).toEqual({ code: 'internal_error' });
      expect(`${error?.message} ${JSON.stringify(error?.data)}`).not.toContain('secret-looking');
      expect(logged).toHaveBeenCalledWith(
        expect.stringContaining('secret-looking'),
        expect.any(String),
      );
    } finally {
      failing.mockRestore();
      logged.mockRestore();
    }
  });

  // 要件定義書 4.6「WebSocket の接続数・切断率をメトリクスとして記録する」（決定・2026-09-12・依頼側。#287: 構造化ログと EMF の両方）。
  // アプリは logger: false で組み立てているため、Logger のメソッドを直接見張る。
  describe('接続と切断の記録（#287）', () => {
    /** 見張った Logger の呼び出しのうち、条件を満たすものが現れるまで待つ（切断はサーバー側で少し遅れて観測される）。 */
    async function waitForCall(
      spy: { mock: { calls: unknown[][] } },
      predicate: (text: string) => boolean,
      timeoutMs = 3_000,
    ): Promise<string | undefined> {
      const until = Date.now() + timeoutMs;
      while (Date.now() < until) {
        const hit = spy.mock.calls.map((call) => JSON.stringify(call)).find(predicate);
        if (hit !== undefined) return hit;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return undefined;
    }

    it('接続と切断を、利用者の ID とともに構造化ログに記録し、トークンは載せない', async () => {
      const { token, id } = await login();
      const logged = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      try {
        const { socket } = await open(firstBase, { token });
        const connected = await waitForCall(logged, (t) => t.includes('websocket_connected'));
        expect(connected).toContain(id);
        expect(connected).not.toContain(token);

        socket.close();
        const disconnected = await waitForCall(logged, (t) => t.includes('websocket_disconnected'));
        expect(disconnected).toContain(id);
        expect(disconnected).not.toContain(token);
      } finally {
        logged.mockRestore();
      }
    });

    it('接続のたびに、EMF の1行（接続数と接続の回数）を標準出力に出す', async () => {
      const { token } = await login();
      const written: string[] = [];
      const original = process.stdout.write.bind(process.stdout);
      const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((
        chunk: unknown,
        ...rest: unknown[]
      ) => {
        written.push(String(chunk));
        return (original as (...args: unknown[]) => boolean)(chunk, ...rest);
      }) as typeof process.stdout.write);
      try {
        await open(firstBase, { token });
        await new Promise((resolve) => setTimeout(resolve, 200));
      } finally {
        spy.mockRestore();
      }
      const emf = written
        .flatMap((chunk) => chunk.split('\n'))
        .filter((line) => line.startsWith('{'))
        .map(
          (line) =>
            JSON.parse(line) as {
              _aws?: unknown;
              WebSocketConnections?: number;
              WebSocketConnects?: number;
            },
        )
        .find((doc) => doc._aws !== undefined && doc.WebSocketConnects === 1);
      expect(emf).toBeDefined();
      expect(emf?.WebSocketConnections).toBeGreaterThanOrEqual(1);
    });
  });

  // 要件定義書 4.2: Valkey が止まっている間は、タスク間の配信共有が止まるが、接続は保ち、同じタスクの中の配信は続く。
  // Valkey を止めるため、この describe は最後に置く。
  describe('Valkey が止まっているとき', () => {
    it('同じタスクに繋いだ利用者には届き続け、接続も切れず、プロセスは落ちない', async () => {
      const alice = await login();
      const aliceSocket = (await open(firstBase, { token: alice.token })).socket;

      await valkey.stop();
      const received = nextEvent(aliceSocket, 'presence:changed');
      first.get(RealtimeEmitter).toUsers([alice.id], 'presence:changed', { during: 'outage' });

      expect(await received).toEqual({ during: 'outage' });
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      expect(aliceSocket.connected).toBe(true);
    });
  });
});
