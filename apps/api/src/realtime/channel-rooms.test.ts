import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { type ChannelRoomAck, REALTIME_REQUESTS, type paths } from '@workspace-chat/shared';
import type { Socket } from 'socket.io-client';
import type { StartedTestContainer } from 'testcontainers';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app-setup';
import { hashSecret } from '../auth/secret-hash';
import { PrismaService } from '../prisma.service';
import { stubApiEnv } from '../testing/api-env';
import { CapturingLogger } from '../testing/capturing-logger';
import { POSTGRES_STARTUP_TIMEOUT_MS, startMigratedPostgres } from '../testing/postgres';
import { connectRealtime, nextEvent } from '../testing/realtime-client';
import { startValkey } from '../testing/valkey';
import { RealtimeGateway, channelRoom } from './realtime.gateway';

type Workspace = paths['/workspaces']['post']['responses'][201]['content']['application/json'];

const NOT_FOUND = { code: 'not_found', message: '見つかりません' };
const MISSING_ID = '00000000-0000-7000-8000-000000000000';
const TOO_MANY_REQUESTS = {
  code: 'too_many_requests',
  message: '要求が多すぎます。しばらく待ってからやり直してください',
};
/** 入室要求の上限（利用者単位で1分に60回。決定・2026-09-13・依頼側）。 */
const ENTER_LIMIT = 60;

let sequence = 0;
let ipSequence = 0;
function nextIp(): string {
  ipSequence += 1;
  return `2001:db8::e:${ipSequence.toString(16)}`;
}

type LoggedIn = { authorization: string; token: string; id: string };

// 機能一覧 9.2「部屋（Socket.IO の room）」・2.2（参加資格を失ったとき）、要件定義書 4.8 の3
// （WebSocket が非参加者にイベントを配信しないこと: 非参加者をチャンネルの部屋に入れないこと、参加者でなくなった接続を部屋から外すこと）。
// タスクを2つに見立て、Redis アダプタを通して確かめる（1つのプロセスでは、他のタスクの接続を外し損ねても落ちない）。
describe('チャンネルの部屋への入室・退室と、参加資格を失ったときに部屋から外す処理（#335 の4つ目・#331）', () => {
  let postgres: StartedPostgreSqlContainer;
  let valkey: StartedTestContainer;
  let first: INestApplication;
  let second: INestApplication;
  let firstBase: string;
  let secondBase: string;
  let prisma: PrismaService;
  const opened: Socket[] = [];
  const logger = new CapturingLogger();

  async function listen(app: INestApplication): Promise<string> {
    await app.listen(0, '127.0.0.1');
    const { port } = app.getHttpServer().address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  async function login(): Promise<LoggedIn> {
    sequence += 1;
    const loginId = `Room_${Date.now().toString(36)}_${sequence}`;
    const user = await prisma.user.create({
      data: {
        loginId,
        displayName: `部屋の人${sequence}`,
        passwordHash: await hashSecret('room-password'),
      },
    });
    const res = await fetch(`${firstBase}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': nextIp() },
      body: JSON.stringify({ userId: loginId, password: 'room-password' }),
    });
    expect(res.status).toBe(200);
    const { accessToken } = (await res.json()) as { accessToken: string };
    return { authorization: `Bearer ${accessToken}`, token: accessToken, id: user.id };
  }

  function send(
    method: 'POST' | 'DELETE',
    path: string,
    by: LoggedIn,
    body?: unknown,
  ): Promise<Response> {
    return fetch(`${firstBase}/api${path}`, {
      method,
      headers: {
        authorization: by.authorization,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  async function workspaceWith(owner: LoggedIn, ...members: LoggedIn[]): Promise<Workspace> {
    const res = await send('POST', '/workspaces', owner, { name: '部屋の場所' });
    expect(res.status).toBe(201);
    const workspace = (await res.json()) as Workspace;
    for (const member of members) {
      await prisma.membership.create({
        data: { workspaceId: workspace.id, userId: member.id, role: 'MEMBER' },
      });
    }
    return workspace;
  }

  /** API を通さずにチャンネルを作る（参加者の組み合わせ・アーカイブ済みを自由に用意するため）。 */
  async function channelRow(
    workspaceId: string,
    visibility: 'PUBLIC' | 'PRIVATE',
    participants: LoggedIn[],
    archived = false,
  ): Promise<string> {
    sequence += 1;
    const name = `room-${sequence}`;
    const channel = await prisma.channel.create({
      data: archived
        ? {
            workspaceId,
            name: `${name}-1`,
            baseName: name,
            visibility,
            archivedAt: new Date(),
            archiveSequence: 1,
          }
        : { workspaceId, name, baseName: name, visibility },
    });
    for (const participant of participants) {
      await prisma.channelMember.create({
        data: { channelId: channel.id, workspaceId, userId: participant.id },
      });
    }
    return channel.id;
  }

  async function open(base: string, user: LoggedIn): Promise<Socket> {
    const { socket, error } = await connectRealtime(base, { token: user.token });
    expect(error).toBeUndefined();
    opened.push(socket);
    return socket;
  }

  function request(socket: Socket, name: string, body: unknown): Promise<ChannelRoomAck> {
    return socket.timeout(3_000).emitWithAck(name, body) as Promise<ChannelRoomAck>;
  }

  function enter(socket: Socket, channelId: unknown): Promise<ChannelRoomAck> {
    return request(socket, REALTIME_REQUESTS.channelEnter, { channelId });
  }

  function exit(socket: Socket, channelId: unknown): Promise<ChannelRoomAck> {
    return request(socket, REALTIME_REQUESTS.channelExit, { channelId });
  }

  /** そのチャンネルの部屋へ1回送り、接続ごとに届いたかを返す（最初のタスクから送る。他のタスクの接続にはアダプタを通って届く）。 */
  async function reached(sockets: Socket[], channelId: string): Promise<boolean[]> {
    const probe = { probe: randomUUID() };
    const waits = sockets.map((socket) => nextEvent(socket, 'message:new', 1_000));
    first.get(RealtimeGateway).server.to(channelRoom(channelId)).emit('message:new', probe);
    return (await Promise.all(waits)).map(
      (payload) => (payload as { probe?: string } | undefined)?.probe === probe.probe,
    );
  }

  /** 部屋に入っている接続の利用者（全タスク）。 */
  async function usersInRoom(channelId: string): Promise<string[]> {
    const sockets = await first
      .get(RealtimeGateway)
      .server.in(channelRoom(channelId))
      .fetchSockets();
    return sockets.map((socket) => (socket.data as { user: { id: string } }).user.id);
  }

  /** 部屋から外す処理は他のタスクへアダプタを通って届くため、外れ切るまで待つ。 */
  async function untilLeft(channelId: string, userId: string): Promise<void> {
    await vi.waitFor(async () => expect(await usersInRoom(channelId)).not.toContain(userId), {
      timeout: 3_000,
      interval: 50,
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
    first = await createApp({ logger });
    second = await createApp({ logger });
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

  describe('入室', () => {
    it('参加者は入室でき、別のタスクから送ったチャンネルの部屋のイベントが、同じ利用者のすべての接続に届く', async () => {
      const owner = await login();
      const alice = await login();
      const workspace = await workspaceWith(owner, alice);
      const channelId = await channelRow(workspace.id, 'PRIVATE', [alice]);
      const onFirst = await open(firstBase, alice);
      const onSecond = await open(secondBase, alice);

      expect(await enter(onFirst, channelId)).toEqual({ ok: true });
      expect(await enter(onSecond, channelId)).toEqual({ ok: true });

      expect(await reached([onFirst, onSecond], channelId)).toEqual([true, true]);
    });

    it('アーカイブ済みのチャンネルにも、参加者は入室できる（参加者は読める。機能一覧 3.2）', async () => {
      const owner = await login();
      const alice = await login();
      const workspace = await workspaceWith(owner, alice);
      const channelId = await channelRow(workspace.id, 'PUBLIC', [alice], true);
      const socket = await open(secondBase, alice);

      expect(await enter(socket, channelId)).toEqual({ ok: true });
      expect(await reached([socket], channelId)).toEqual([true]);
    });

    it('所属していなければ、種別によらず 404 で断り、部屋に入れない', async () => {
      const owner = await login();
      const outsider = await login();
      const workspace = await workspaceWith(owner);
      const publicId = await channelRow(workspace.id, 'PUBLIC', [owner]);
      const privateId = await channelRow(workspace.id, 'PRIVATE', [owner]);
      const socket = await open(secondBase, outsider);

      for (const channelId of [publicId, privateId, MISSING_ID]) {
        expect(await enter(socket, channelId)).toEqual({
          ok: false,
          status: 404,
          error: NOT_FOUND,
        });
      }
      expect(await reached([socket, socket], publicId)).toEqual([false, false]);
      expect(await reached([socket], privateId)).toEqual([false]);
    });

    it('所属していて参加していなければ、パブリックは 403 not_a_channel_member、プライベートは 404 で断り、部屋に入れない', async () => {
      const owner = await login();
      const bob = await login();
      const workspace = await workspaceWith(owner, bob);
      const publicId = await channelRow(workspace.id, 'PUBLIC', [owner]);
      const privateId = await channelRow(workspace.id, 'PRIVATE', [owner]);
      const socket = await open(firstBase, bob);

      const publicAck = await enter(socket, publicId);
      expect(publicAck).toMatchObject({
        ok: false,
        status: 403,
        error: { code: 'not_a_channel_member' },
      });
      expect(publicAck.ok === false && publicAck.error.message).not.toBe(NOT_FOUND.message);
      expect(await enter(socket, privateId)).toEqual({ ok: false, status: 404, error: NOT_FOUND });

      expect(await reached([socket], publicId)).toEqual([false]);
      expect(await reached([socket], privateId)).toEqual([false]);
    });

    // CLAUDE.md 2: オーナーの例外は一覧・取得 API だけであり、部屋（WebSocket の配信）には及ばない。機能一覧 9.2「参加していないオーナーには届かない」。
    it('オーナーでも、参加していないチャンネルには入室できない（プライベートは 404・パブリックは 403）', async () => {
      const owner = await login();
      const alice = await login();
      const workspace = await workspaceWith(owner, alice);
      const publicId = await channelRow(workspace.id, 'PUBLIC', [alice]);
      const privateId = await channelRow(workspace.id, 'PRIVATE', [alice]);
      const socket = await open(firstBase, owner);

      expect(await enter(socket, privateId)).toEqual({ ok: false, status: 404, error: NOT_FOUND });
      expect(await enter(socket, publicId)).toMatchObject({ ok: false, status: 403 });
      expect(await reached([socket], privateId)).toEqual([false]);
    });

    it('別のワークスペースのチャンネルは、そちらに参加していても、ワークスペースから外れていれば 404', async () => {
      const owner = await login();
      const alice = await login();
      const workspace = await workspaceWith(owner, alice);
      const channelId = await channelRow(workspace.id, 'PUBLIC', [alice]);
      await prisma.membership.deleteMany({
        where: { workspaceId: workspace.id, userId: alice.id },
      });
      const socket = await open(firstBase, alice);

      expect(await enter(socket, channelId)).toEqual({ ok: false, status: 404, error: NOT_FOUND });
    });

    it('チャンネルの ID が UUID の文字列でなければ 400 validation_failed で断る', async () => {
      const alice = await login();
      const socket = await open(firstBase, alice);

      for (const channelId of [undefined, 42, 'not-a-uuid']) {
        expect(await enter(socket, channelId)).toMatchObject({
          ok: false,
          status: 400,
          error: { code: 'validation_failed' },
        });
      }
    });
  });

  // 機能一覧 9.2「入室要求の上限」（決定・2026-09-13・依頼側。サーバーの負荷の歯止め）。
  describe('入室要求の上限', () => {
    it('同じ利用者の入室要求は、接続とタスクをまたいで数え、形の誤った要求も1回として数え、上限を超えたら 429 で断って部屋に入れない', async () => {
      const owner = await login();
      const alice = await login();
      const workspace = await workspaceWith(owner, alice);
      const channelId = await channelRow(workspace.id, 'PUBLIC', [alice]);
      const lateId = await channelRow(workspace.id, 'PUBLIC', [alice]);
      const onFirst = await open(firstBase, alice);
      const onSecond = await open(secondBase, alice);

      for (let i = 0; i < ENTER_LIMIT / 2; i += 1) {
        expect(await enter(onFirst, channelId)).toEqual({ ok: true });
        expect(await enter(onSecond, 'not-a-uuid')).toMatchObject({ ok: false, status: 400 });
      }

      expect(await enter(onFirst, lateId)).toEqual({
        ok: false,
        status: 429,
        error: TOO_MANY_REQUESTS,
      });
      expect(await reached([onFirst], lateId)).toEqual([false]);
    });

    it('上限を超えた利用者がいても、別の利用者の入室は断らない', async () => {
      const owner = await login();
      const alice = await login();
      const bob = await login();
      const workspace = await workspaceWith(owner, alice, bob);
      const channelId = await channelRow(workspace.id, 'PUBLIC', [bob]);
      const aliceSocket = await open(firstBase, alice);
      const bobSocket = await open(firstBase, bob);
      for (let i = 0; i < ENTER_LIMIT; i += 1) await enter(aliceSocket, 'not-a-uuid');
      expect(await enter(aliceSocket, 'not-a-uuid')).toMatchObject({ ok: false, status: 429 });

      expect(await enter(bobSocket, channelId)).toEqual({ ok: true });
    });

    it('退室要求は数えない（上限を超える回数の退室の後も、入室を断らない）', async () => {
      const owner = await login();
      const alice = await login();
      const workspace = await workspaceWith(owner, alice);
      const channelId = await channelRow(workspace.id, 'PUBLIC', [alice]);
      const socket = await open(firstBase, alice);

      for (let i = 0; i <= ENTER_LIMIT; i += 1) {
        expect(await exit(socket, channelId)).toEqual({ ok: true });
      }

      expect(await enter(socket, channelId)).toEqual({ ok: true });
    });

    it('上限の超過を、制限の種類（user）・利用者の ID・要求の名前とともに記録する', async () => {
      const alice = await login();
      const socket = await open(secondBase, alice);
      const before = logger.lines.length;

      for (let i = 0; i <= ENTER_LIMIT; i += 1) await enter(socket, 'not-a-uuid');

      const line = logger.lines.slice(before).find((l) => l.includes('rate_limit_exceeded'));
      expect(line).toBeDefined();
      expect(line).toContain('"limit":"user"');
      expect(line).toContain(alice.id);
      expect(line).toContain(REALTIME_REQUESTS.channelEnter);
    });
  });

  describe('退室', () => {
    it('退室した接続にはチャンネルの部屋のイベントが届かず、同じ利用者の別の接続には届き続ける', async () => {
      const owner = await login();
      const alice = await login();
      const workspace = await workspaceWith(owner, alice);
      const channelId = await channelRow(workspace.id, 'PUBLIC', [alice]);
      const closing = await open(firstBase, alice);
      const staying = await open(secondBase, alice);
      await enter(closing, channelId);
      await enter(staying, channelId);

      expect(await exit(closing, channelId)).toEqual({ ok: true });

      expect(await reached([closing, staying], channelId)).toEqual([false, true]);
    });

    it('チャンネルの ID が UUID の文字列でなければ 400 validation_failed で断る', async () => {
      const alice = await login();
      const socket = await open(firstBase, alice);

      expect(await exit(socket, 'not-a-uuid')).toMatchObject({ ok: false, status: 400 });
    });
  });

  describe('参加資格を失ったとき（機能一覧 2.2）', () => {
    /** オーナーと2人のメンバーのワークスペースに、2人が参加するチャンネルを2つ作り、alice の2つの接続（別のタスク）と bob を両方に入室させる。 */
    async function roomsWithAliceAndBob() {
      const owner = await login();
      const alice = await login();
      const bob = await login();
      const workspace = await workspaceWith(owner, alice, bob);
      const leftId = await channelRow(workspace.id, 'PRIVATE', [owner, alice, bob]);
      const otherId = await channelRow(workspace.id, 'PUBLIC', [alice, bob]);
      const aliceOnFirst = await open(firstBase, alice);
      const aliceOnSecond = await open(secondBase, alice);
      const bobSocket = await open(secondBase, bob);
      for (const socket of [aliceOnFirst, aliceOnSecond, bobSocket]) {
        for (const channelId of [leftId, otherId]) {
          expect(await enter(socket, channelId)).toEqual({ ok: true });
        }
      }
      return {
        owner,
        alice,
        bob,
        workspace,
        leftId,
        otherId,
        aliceOnFirst,
        aliceOnSecond,
        bobSocket,
      };
    }

    it('チャンネルから退出すると、その利用者のすべての接続（別のタスクを含む）がそのチャンネルの部屋から外れる。他のチャンネルの部屋と他の参加者は残る', async () => {
      const r = await roomsWithAliceAndBob();

      const res = await send(
        'POST',
        `/workspaces/${r.workspace.id}/channels/${r.leftId}/leave`,
        r.alice,
      );
      expect(res.status).toBe(204);
      await untilLeft(r.leftId, r.alice.id);

      expect(await reached([r.aliceOnFirst, r.aliceOnSecond, r.bobSocket], r.leftId)).toEqual([
        false,
        false,
        true,
      ]);
      expect(await reached([r.aliceOnFirst, r.aliceOnSecond], r.otherId)).toEqual([true, true]);
    });

    it('チャンネルからキックされると、その利用者のすべての接続がそのチャンネルの部屋から外れる。他のチャンネルの部屋と他の参加者は残る', async () => {
      const r = await roomsWithAliceAndBob();

      const res = await send(
        'DELETE',
        `/workspaces/${r.workspace.id}/channels/${r.leftId}/members/${r.alice.id}`,
        r.owner,
      );
      expect(res.status).toBe(204);
      await untilLeft(r.leftId, r.alice.id);

      expect(await reached([r.aliceOnFirst, r.aliceOnSecond, r.bobSocket], r.leftId)).toEqual([
        false,
        false,
        true,
      ]);
      expect(await reached([r.aliceOnFirst, r.aliceOnSecond], r.otherId)).toEqual([true, true]);
    });

    it('ワークスペースからキックされると、そのワークスペースの全チャンネルの部屋から外れ、別のワークスペースのチャンネルの部屋には残る', async () => {
      const r = await roomsWithAliceAndBob();
      const elsewhere = await workspaceWith(await login(), r.alice);
      const elsewhereId = await channelRow(elsewhere.id, 'PUBLIC', [r.alice]);
      expect(await enter(r.aliceOnSecond, elsewhereId)).toEqual({ ok: true });

      const res = await send(
        'DELETE',
        `/workspaces/${r.workspace.id}/members/${r.alice.id}`,
        r.owner,
      );
      expect(res.status).toBe(204);
      await untilLeft(r.leftId, r.alice.id);
      await untilLeft(r.otherId, r.alice.id);

      for (const channelId of [r.leftId, r.otherId]) {
        expect(await reached([r.aliceOnFirst, r.aliceOnSecond, r.bobSocket], channelId)).toEqual([
          false,
          false,
          true,
        ]);
      }
      expect(await reached([r.aliceOnSecond], elsewhereId)).toEqual([true]);
    });

    it('ワークスペースから退出すると、そのワークスペースの全チャンネルの部屋から外れる', async () => {
      const r = await roomsWithAliceAndBob();

      const res = await send('POST', `/workspaces/${r.workspace.id}/leave`, r.alice);
      expect(res.status).toBe(204);
      await untilLeft(r.leftId, r.alice.id);
      await untilLeft(r.otherId, r.alice.id);

      for (const channelId of [r.leftId, r.otherId]) {
        expect(await reached([r.aliceOnFirst, r.aliceOnSecond, r.bobSocket], channelId)).toEqual([
          false,
          false,
          true,
        ]);
      }
    });

    it('外れた後に入室し直そうとしても、参加者でなければ断られる', async () => {
      const r = await roomsWithAliceAndBob();

      await send(
        'DELETE',
        `/workspaces/${r.workspace.id}/channels/${r.leftId}/members/${r.alice.id}`,
        r.owner,
      );
      await untilLeft(r.leftId, r.alice.id);

      expect(await enter(r.aliceOnFirst, r.leftId)).toEqual({
        ok: false,
        status: 404,
        error: NOT_FOUND,
      });
      expect(await reached([r.aliceOnFirst], r.leftId)).toEqual([false]);
    });
  });
});
