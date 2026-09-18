import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { REALTIME_REQUESTS } from '@workspace-chat/shared';
import type { Socket } from 'socket.io-client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../prisma.service';
import { POSTGRES_STARTUP_TIMEOUT_MS } from '../testing/postgres';
import { nextEvent } from '../testing/realtime-client';
import { type TwoTasks, startTwoTasks } from '../testing/two-tasks';
import { PresenceRegistry } from './presence-registry';
import { RealtimePresence } from './realtime-presence';
import { REALTIME_VALKEY_CLIENTS, type RealtimeValkeyClients } from './realtime-valkey';
import { RealtimeGateway, channelRoom } from './realtime.gateway';
import { ROOM_RECONCILE_INTERVAL_MS, RoomMembershipReconciler } from './room-membership-reconciler';

// 決定・2026-09-13・依頼側: Valkey が止まっている間のキック・退出では、部屋から外す通知（socketsLeave）が他のタスクに届かず、
// 参加者でなくなった接続が部屋に残る。各タスクは、5分ごとと Valkey への publish が戻ったときに、自分の接続が入っている
// チャンネルの部屋を参加の行と照合し、参加者でない接続を外す（要件定義書 4.8 の3: 参加者でなくなった接続を部屋から外すこと）。
// 照合は自タスクの接続だけを見るため、接続も照合も最初のタスク（t.first）で行う。
describe('チャンネルの部屋の参加の照合', () => {
  let t: TwoTasks;

  /** オーナーのワークスペースに2人を参加させ、2人が参加するチャンネルを作り、2人の接続を入室させる。 */
  async function roomOfTwo() {
    const owner = await t.login();
    const alice = await t.login();
    const bob = await t.login();
    const workspace = await t.workspaceWith(owner, alice, bob);
    const channelId = await t.channelRow(workspace.id, 'PRIVATE', [alice, bob]);
    const aliceSocket = await t.open(t.firstBase, alice);
    const bobSocket = await t.open(t.firstBase, bob);
    for (const socket of [aliceSocket, bobSocket]) {
      const ack: unknown = await socket
        .timeout(3_000)
        .emitWithAck(REALTIME_REQUESTS.channelEnter, { channelId });
      expect(ack).toMatchObject({ ok: true });
    }
    return { alice, bob, workspace, channelId, aliceSocket, bobSocket };
  }

  /** そのチャンネルの部屋へ1回送り、接続ごとに届いたかを返す。 */
  async function reached(sockets: Socket[], channelId: string): Promise<boolean[]> {
    const probe = { probe: randomUUID() };
    const waits = sockets.map((socket) => nextEvent(socket, 'message:new', 1_000));
    t.first.get(RealtimeGateway).server.to(channelRoom(channelId)).emit('message:new', probe);
    return (await Promise.all(waits)).map(
      (payload) => (payload as { probe?: string } | undefined)?.probe === probe.probe,
    );
  }

  beforeAll(async () => {
    t = await startTwoTasks('a');
  }, POSTGRES_STARTUP_TIMEOUT_MS);

  afterEach(() => t.closeSockets());

  afterAll(async () => {
    await t?.stop();
  });

  describe('照合', () => {
    // 参加の行を DB から直接消し、部屋から外す処理（socketsLeave）を通らない状態を作る——Valkey が止まっている間に
    // 他のタスクでキックされた接続と同じ状態である。
    it('参加の行が無くなった利用者の接続だけを部屋から外し、参加者の接続は残す', async () => {
      const { alice, channelId, aliceSocket, bobSocket } = await roomOfTwo();
      await t.prisma.channelMember.deleteMany({ where: { channelId, userId: alice.id } });
      // 両方の接続で受け切る（片方だけで待つと、もう片方に届いた分が次の確認に紛れる）。
      expect(await reached([aliceSocket, bobSocket], channelId)).toEqual([true, true]);

      await t.first.get(RoomMembershipReconciler).reconcile();

      expect(await reached([aliceSocket, bobSocket], channelId)).toEqual([false, true]);
    });

    it('ワークスペースから外れた利用者（所属の行が無い）の接続を部屋から外す', async () => {
      const { alice, workspace, channelId, aliceSocket, bobSocket } = await roomOfTwo();
      await t.prisma.membership.deleteMany({
        where: { workspaceId: workspace.id, userId: alice.id },
      });

      await t.first.get(RoomMembershipReconciler).reconcile();

      expect(await reached([aliceSocket, bobSocket], channelId)).toEqual([false, true]);
    });

    // 機能一覧 9.2「外れる契機はどれでも同じである」: 照合で外したときも、最後の接続なら在席の変化を配る。
    it('照合で外した接続がその利用者の最後の接続なら、残った参加者に在席の変化（present: false）を配り、在席の一覧から外す', async () => {
      const { alice, bob, channelId, bobSocket } = await roomOfTwo();
      await t.prisma.channelMember.deleteMany({ where: { channelId, userId: alice.id } });
      const changed = nextEvent(bobSocket, 'presence:changed', 2_000);

      await t.first.get(RoomMembershipReconciler).reconcile();

      expect(await changed).toMatchObject({ channelId, userId: alice.id, present: false });
      // 参加者のままの利用者は在席に残る。
      expect(t.first.get(PresenceRegistry).usersIn(channelId)).toEqual([bob.id]);
    });

    it('退会した利用者の接続を部屋から外す', async () => {
      const { alice, channelId, aliceSocket, bobSocket } = await roomOfTwo();
      await t.prisma.user.update({ where: { id: alice.id }, data: { deletedAt: new Date() } });

      await t.first.get(RoomMembershipReconciler).reconcile();

      expect(await reached([aliceSocket, bobSocket], channelId)).toEqual([false, true]);
    });
  });

  // 照合は DB に問い合わせ、接続の失敗のメッセージには接続先が入る（#382。reconcile 自体は
  // server.local.fetchSockets() で自タスクの接続だけを見るため Valkey には問い合わせない）。warn には code を残し、
  // code が無ければ種類の名前だけを残す（apps/api/src/logging/error-kind.ts）。**在席の一覧の取り直し
  // （presence-registry.ts）は code が無いとき message を残す**——code が無いときの選び方はこちら（reconcile）と逆である。
  // DB の呼び出しだけを失敗させるため、照合をこのタスクの本物の部品と、失敗を返す Prisma で組み立てる。
  describe('照合の失敗', () => {
    async function warnOfFailedReconcile(failure: Error): Promise<string[]> {
      await roomOfTwo();
      const failingPrisma = {
        channelMember: {
          findMany: () => Promise.reject(failure),
        },
      } as unknown as PrismaService;
      const reconciler = new RoomMembershipReconciler(
        t.first.get(RealtimeGateway),
        failingPrisma,
        t.first.get(RealtimePresence),
        t.first.get<RealtimeValkeyClients>(REALTIME_VALKEY_CLIENTS),
      );
      const warned = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      try {
        await reconciler.reconcile();
        return warned.mock.calls
          .map(([message]) => String(message))
          .filter((message) => message.includes('照合できなかった'));
      } finally {
        warned.mockRestore();
      }
    }

    it('code を持つ失敗は code だけを warn に残し、メッセージに入りうる接続先は残さない', async () => {
      const unreachable = Object.assign(
        new Error("Can't reach database server at db.internal.example:5432"),
        { code: 'P1001' },
      );

      const messages = await warnOfFailedReconcile(unreachable);

      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain('P1001');
      expect(messages[0]).not.toContain('db.internal.example');
    });

    it('code を持たない失敗は種類の名前だけを warn に残し、メッセージは残さない', async () => {
      const refused = new TypeError('fetch failed: db.internal.example:5432');

      const messages = await warnOfFailedReconcile(refused);

      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain('TypeError');
      expect(messages[0]).not.toContain('db.internal.example');
    });
  });

  describe('照合の契機', () => {
    it('Valkey への publish が戻ったと知らされたら照合する', async () => {
      const reconciler = t.first.get(RoomMembershipReconciler);
      const reconcile = vi.spyOn(reconciler, 'reconcile').mockResolvedValue();
      try {
        const clients = t.first.get<RealtimeValkeyClients>(REALTIME_VALKEY_CLIENTS);
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
