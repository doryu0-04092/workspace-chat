import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Socket } from 'socket.io-client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AccessTokenResolver } from '../auth/access-token.guard';
import { captureOutput } from '../testing/captured-output';
import { POSTGRES_STARTUP_TIMEOUT_MS } from '../testing/postgres';
import {
  type ConnectOptions,
  type Transport,
  connectRealtime,
  nextEvent,
} from '../testing/realtime-client';
import { type TwoTasks, startTwoTasks } from '../testing/two-tasks';
import { RealtimeEmitter } from './realtime.emitter';

// 機能一覧 5.2・9.2、要件定義書 4.2・4.3・4.8 の4（許可外の Origin からのハンドシェイクを拒否する）。
// タスクを2つに見立てる。Valkey のアダプタを通さないと、別のタスクに繋いだ利用者へ届かない。
describe('Socket.IO の接続の入口（F-16）', () => {
  let t: TwoTasks;
  const opened: Socket[] = [];

  /** ハンドシェイクの Origin・パス・経路・トークンを指定して繋ぐ（断られた場合も返す）。 */
  async function open(base: string, options: ConnectOptions) {
    const result = await connectRealtime(base, options);
    opened.push(result.socket);
    return result;
  }

  beforeAll(async () => {
    t = await startTwoTasks('9');
  }, POSTGRES_STARTUP_TIMEOUT_MS);

  afterEach(() => {
    for (const socket of opened.splice(0)) socket.close();
  });

  afterAll(async () => {
    await t?.stop();
  });

  describe('Origin（CSWSH の対処。allowRequest）', () => {
    it.each<Transport>(['websocket', 'polling'])(
      '許可した Origin からは接続できる（%s）',
      async (transport) => {
        const { token } = await t.login();
        const { error, socket } = await open(t.firstBase, { token, transport });
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
        const { token } = await t.login();
        const { error, socket } = await open(t.firstBase, { token, origin, transport });
        expect(error).toBeDefined();
        expect(socket.connected).toBe(false);
      },
    );
  });

  it('ハンドシェイクのパスは /api/socket.io/ で、既定の /socket.io/ では繋がらない', async () => {
    const { token } = await t.login();
    const { error } = await open(t.firstBase, { token, path: '/socket.io/' });
    expect(error).toBeDefined();
  });

  describe('トークン（ハンドシェイクの auth）', () => {
    it('auth にトークンが無ければ authentication_required で断る（Cookie では渡せない）', async () => {
      const { token } = await t.login();
      for (const options of [{}, { cookie: `access_token=${token}` }, { token: 42 }]) {
        const { error } = await open(t.firstBase, options);
        expect(error?.data).toEqual({ code: 'authentication_required' });
      }
    });

    it('使えないトークン・退会済みの利用者のトークンは、どれも invalid_token で断る', async () => {
      const { token, id } = await t.login();
      const other = await t.login();
      const forged = new JwtService({ secret: 'x'.repeat(48) }).sign({ sub: other.id });
      const expired = new JwtService({ secret: process.env.JWT_SECRET }).sign({
        sub: other.id,
        exp: Math.floor(Date.now() / 1000) - 10,
      });
      await t.prisma.user.update({ where: { id }, data: { deletedAt: new Date() } });

      for (const bad of ['not-a-jwt', forged, expired, token]) {
        const { error, socket } = await open(t.firstBase, { token: bad });
        expect(error?.data).toEqual({ code: 'invalid_token' });
        expect(socket.connected).toBe(false);
      }
    });
  });

  describe('利用者の部屋（機能一覧 9.2）', () => {
    it('利用者の部屋へ送ったイベントは、別のタスクに繋いだその利用者の接続すべてに1回ずつ届き、他の利用者には届かない', async () => {
      const alice = await t.login();
      const bob = await t.login();
      const aliceOnSecond = await open(t.secondBase, { token: alice.token });
      const aliceOnFirst = await open(t.firstBase, { token: alice.token });
      const bobOnSecond = await open(t.secondBase, { token: bob.token });

      const received = [
        nextEvent(aliceOnSecond.socket, 'presence:changed'),
        nextEvent(aliceOnFirst.socket, 'presence:changed'),
        nextEvent(bobOnSecond.socket, 'presence:changed', 1_000),
      ];
      t.first.get(RealtimeEmitter).toUsers([alice.id], 'presence:changed', { probe: 1 });

      expect(await Promise.all(received)).toEqual([{ probe: 1 }, { probe: 1 }, undefined]);
    });

    it('複数の利用者の部屋へ1回で送ると、両方の部屋に入っている接続にも1回だけ届く', async () => {
      const alice = await t.login();
      const bob = await t.login();
      const aliceSocket = (await open(t.firstBase, { token: alice.token })).socket;
      const bobSocket = (await open(t.secondBase, { token: bob.token })).socket;
      const count = { alice: 0, bob: 0 };
      aliceSocket.on('message:new', () => (count.alice += 1));
      bobSocket.on('message:new', () => (count.bob += 1));

      t.first.get(RealtimeEmitter).toUsers([alice.id, bob.id, alice.id], 'message:new', {});
      await new Promise((resolve) => setTimeout(resolve, 1_000));

      expect(count).toEqual({ alice: 1, bob: 1 });
    });

    // Socket.IO は宛先の部屋が空だと、部屋で絞らずに名前空間の全接続へ送る。宛先を確かめた結果が 0 人になる呼び出しはありうる。
    it('宛先が空なら、どの接続にも届かない', async () => {
      const alice = await t.login();
      const aliceSocket = (await open(t.firstBase, { token: alice.token })).socket;
      const received = nextEvent(aliceSocket, 'message:new', 1_000);

      t.first.get(RealtimeEmitter).toUsers([], 'message:new', { leaked: true });

      expect(await received).toBeUndefined();
    });
  });

  // 機能一覧 1.4 / error-response.ts と同じ決め: 想定外の失敗は、例外のメッセージを応答に載せず、ログに error で残す。
  it('ハンドシェイクの想定外の失敗は、例外のメッセージを渡さず internal_error で断り、ログに残す', async () => {
    const { token } = await t.login();
    const resolver = t.first.get(AccessTokenResolver);
    const failing = vi
      .spyOn(resolver, 'resolve')
      .mockRejectedValueOnce(new Error('secret-looking detail from prisma'));
    const logged = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      const { error, socket } = await open(t.firstBase, { token });
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
      const { token, id } = await t.login();
      const logged = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      try {
        const { socket } = await open(t.firstBase, { token });
        const connected = await waitForCall(logged, (text) => text.includes('websocket_connected'));
        expect(connected).toContain(id);
        expect(connected).not.toContain(token);

        socket.close();
        const disconnected = await waitForCall(logged, (text) =>
          text.includes('websocket_disconnected'),
        );
        expect(disconnected).toContain(id);
        expect(disconnected).not.toContain(token);
      } finally {
        logged.mockRestore();
      }
    });

    it('接続のたびに、EMF の1行（接続数と接続の回数）を標準出力に出す', async () => {
      const { token } = await t.login();
      const captured = captureOutput();
      try {
        await open(t.firstBase, { token });
        await new Promise((resolve) => setTimeout(resolve, 200));
      } finally {
        captured.restore();
      }
      const emf = captured
        .jsonLines<{ _aws?: unknown; WebSocketConnections?: number; WebSocketConnects?: number }>()
        .find((doc) => doc._aws !== undefined && doc.WebSocketConnects === 1);
      expect(emf).toBeDefined();
      expect(emf?.WebSocketConnections).toBeGreaterThanOrEqual(1);
    });
  });

  // 要件定義書 4.2: Valkey が止まっている間は、タスク間の配信共有が止まるが、接続は保ち、同じタスクの中の配信は続く。
  // Valkey を止めるため、この describe は最後に置く。
  describe('Valkey が止まっているとき', () => {
    it('同じタスクに繋いだ利用者には届き続け、接続も切れず、プロセスは落ちない', async () => {
      const alice = await t.login();
      const aliceSocket = (await open(t.firstBase, { token: alice.token })).socket;

      await t.valkey.stop();
      const received = nextEvent(aliceSocket, 'presence:changed');
      t.first.get(RealtimeEmitter).toUsers([alice.id], 'presence:changed', { during: 'outage' });

      expect(await received).toEqual({ during: 'outage' });
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      expect(aliceSocket.connected).toBe(true);
    });
  });
});
