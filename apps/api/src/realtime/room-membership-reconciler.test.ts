import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { REALTIME_REQUESTS, type paths } from '@workspace-chat/shared';
import type { Socket } from 'socket.io-client';
import type { StartedTestContainer } from 'testcontainers';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app-setup';
import { hashSecret } from '../auth/secret-hash';
import { PrismaService } from '../prisma.service';
import { stubApiEnv } from '../testing/api-env';
import { POSTGRES_STARTUP_TIMEOUT_MS, startMigratedPostgres } from '../testing/postgres';
import { connectRealtime, nextEvent } from '../testing/realtime-client';
import { startValkey } from '../testing/valkey';
import { PresenceRegistry } from './presence-registry';
import { REALTIME_VALKEY_CLIENTS, type RealtimeValkeyClients } from './realtime-valkey';
import { RealtimeGateway, channelRoom } from './realtime.gateway';
import { ROOM_RECONCILE_INTERVAL_MS, RoomMembershipReconciler } from './room-membership-reconciler';

type Workspace = paths['/workspaces']['post']['responses'][201]['content']['application/json'];
type LoggedIn = { authorization: string; token: string; id: string };

let sequence = 0;

// 決定・2026-09-13・依頼側: Valkey が止まっている間のキック・退出では、部屋から外す通知（socketsLeave）が他のタスクに届かず、
// 参加者でなくなった接続が部屋に残る。各タスクは、5分ごとと Valkey への publish が戻ったときに、自分の接続が入っている
// チャンネルの部屋を参加の行と照合し、参加者でない接続を外す（要件定義書 4.8 の3: 参加者でなくなった接続を部屋から外すこと）。
describe('チャンネルの部屋の参加の照合', () => {
  let postgres: StartedPostgreSqlContainer;
  let valkey: StartedTestContainer;
  let app: INestApplication;
  let base: string;
  let prisma: PrismaService;
  const opened: Socket[] = [];

  async function login(): Promise<LoggedIn> {
    sequence += 1;
    const loginId = `Reconcile_${Date.now().toString(36)}_${sequence}`;
    const user = await prisma.user.create({
      data: {
        loginId,
        displayName: `照合の人${sequence}`,
        passwordHash: await hashSecret('reconcile-password'),
      },
    });
    const res = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': `2001:db8::a:${sequence.toString(16)}`,
      },
      body: JSON.stringify({ userId: loginId, password: 'reconcile-password' }),
    });
    expect(res.status).toBe(200);
    const { accessToken } = (await res.json()) as { accessToken: string };
    return { authorization: `Bearer ${accessToken}`, token: accessToken, id: user.id };
  }

  /** オーナーのワークスペースに2人を参加させ、2人が参加するチャンネルを作り、2人の接続を入室させる。 */
  async function roomOfTwo() {
    const owner = await login();
    const alice = await login();
    const bob = await login();
    const created = await fetch(`${base}/api/workspaces`, {
      method: 'POST',
      headers: { authorization: owner.authorization, 'content-type': 'application/json' },
      body: JSON.stringify({ name: '照合の場所' }),
    });
    expect(created.status).toBe(201);
    const workspace = (await created.json()) as Workspace;
    for (const member of [alice, bob]) {
      await prisma.membership.create({
        data: { workspaceId: workspace.id, userId: member.id, role: 'MEMBER' },
      });
    }
    sequence += 1;
    const channel = await prisma.channel.create({
      data: {
        workspaceId: workspace.id,
        name: `reconcile-${sequence}`,
        baseName: `reconcile-${sequence}`,
        visibility: 'PRIVATE',
      },
    });
    for (const member of [alice, bob]) {
      await prisma.channelMember.create({
        data: { channelId: channel.id, workspaceId: workspace.id, userId: member.id },
      });
    }
    const aliceSocket = await open(alice);
    const bobSocket = await open(bob);
    for (const socket of [aliceSocket, bobSocket]) {
      const ack: unknown = await socket
        .timeout(3_000)
        .emitWithAck(REALTIME_REQUESTS.channelEnter, { channelId: channel.id });
      expect(ack).toMatchObject({ ok: true });
    }
    return { alice, bob, workspace, channelId: channel.id, aliceSocket, bobSocket };
  }

  async function open(user: LoggedIn): Promise<Socket> {
    const { socket, error } = await connectRealtime(base, { token: user.token });
    expect(error).toBeUndefined();
    opened.push(socket);
    return socket;
  }

  /** そのチャンネルの部屋へ1回送り、接続ごとに届いたかを返す。 */
  async function reached(sockets: Socket[], channelId: string): Promise<boolean[]> {
    const probe = { probe: randomUUID() };
    const waits = sockets.map((socket) => nextEvent(socket, 'message:new', 1_000));
    app.get(RealtimeGateway).server.to(channelRoom(channelId)).emit('message:new', probe);
    return (await Promise.all(waits)).map(
      (payload) => (payload as { probe?: string } | undefined)?.probe === probe.probe,
    );
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
    app = await createApp({ logger: false });
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    prisma = app.get(PrismaService);
  }, POSTGRES_STARTUP_TIMEOUT_MS);

  afterEach(() => {
    for (const socket of opened.splice(0)) socket.close();
  });

  afterAll(async () => {
    await app?.close();
    await postgres?.stop();
    await valkey?.stop();
    vi.unstubAllEnvs();
  });

  describe('照合', () => {
    // 参加の行を DB から直接消し、部屋から外す処理（socketsLeave）を通らない状態を作る——Valkey が止まっている間に
    // 他のタスクでキックされた接続と同じ状態である。
    it('参加の行が無くなった利用者の接続だけを部屋から外し、参加者の接続は残す', async () => {
      const { alice, channelId, aliceSocket, bobSocket } = await roomOfTwo();
      await prisma.channelMember.deleteMany({ where: { channelId, userId: alice.id } });
      // 両方の接続で受け切る（片方だけで待つと、もう片方に届いた分が次の確認に紛れる）。
      expect(await reached([aliceSocket, bobSocket], channelId)).toEqual([true, true]);

      await app.get(RoomMembershipReconciler).reconcile();

      expect(await reached([aliceSocket, bobSocket], channelId)).toEqual([false, true]);
    });

    it('ワークスペースから外れた利用者（所属の行が無い）の接続を部屋から外す', async () => {
      const { alice, workspace, channelId, aliceSocket, bobSocket } = await roomOfTwo();
      await prisma.membership.deleteMany({
        where: { workspaceId: workspace.id, userId: alice.id },
      });

      await app.get(RoomMembershipReconciler).reconcile();

      expect(await reached([aliceSocket, bobSocket], channelId)).toEqual([false, true]);
    });

    // 機能一覧 9.2「外れる契機（退室・切断・キック・退出）はどれでも同じ」: 照合で外したときも、最後の接続なら在席の変化を配る。
    it('照合で外した接続がその利用者の最後の接続なら、残った参加者に在席の変化（present: false）を配り、在席の一覧から外す', async () => {
      const { alice, bob, channelId, bobSocket } = await roomOfTwo();
      await prisma.channelMember.deleteMany({ where: { channelId, userId: alice.id } });
      const changed = nextEvent(bobSocket, 'presence:changed', 2_000);

      await app.get(RoomMembershipReconciler).reconcile();

      expect(await changed).toMatchObject({ channelId, userId: alice.id, present: false });
      // 参加者のままの利用者は在席に残る。
      expect(app.get(PresenceRegistry).usersIn(channelId)).toEqual([bob.id]);
    });

    it('退会した利用者の接続を部屋から外す', async () => {
      const { alice, channelId, aliceSocket, bobSocket } = await roomOfTwo();
      await prisma.user.update({ where: { id: alice.id }, data: { deletedAt: new Date() } });

      await app.get(RoomMembershipReconciler).reconcile();

      expect(await reached([aliceSocket, bobSocket], channelId)).toEqual([false, true]);
    });
  });

  describe('照合の契機', () => {
    it('Valkey への publish が戻ったと知らされたら照合する', async () => {
      const reconciler = app.get(RoomMembershipReconciler);
      const reconcile = vi.spyOn(reconciler, 'reconcile').mockResolvedValue();
      try {
        const clients = app.get<RealtimeValkeyClients>(REALTIME_VALKEY_CLIENTS);
        clients.notifyPublishRecovered();

        await vi.waitFor(() => expect(reconcile).toHaveBeenCalledTimes(1), { timeout: 1_000 });
      } finally {
        reconcile.mockRestore();
      }
    });

    it('照合の間隔は5分である', () => {
      expect(ROOM_RECONCILE_INTERVAL_MS).toBe(5 * 60 * 1000);
    });
  });
});
