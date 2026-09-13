import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { REALTIME_REQUESTS } from '@workspace-chat/shared';
import type { Socket } from 'socket.io-client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { POSTGRES_STARTUP_TIMEOUT_MS } from '../testing/postgres';
import { nextEvent } from '../testing/realtime-client';
import { type TwoTasks, startTwoTasks } from '../testing/two-tasks';
import { PresenceRegistry } from './presence-registry';
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

    // 機能一覧 9.2「外れる契機（退室・切断・キック・退出）はどれでも同じ」: 照合で外したときも、最後の接続なら在席の変化を配る。
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
