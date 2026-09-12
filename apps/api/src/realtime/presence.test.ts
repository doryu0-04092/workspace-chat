import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import {
  type ChannelEnterAck,
  type PresenceChangedPayload,
  REALTIME_REQUESTS,
} from '@workspace-chat/shared';
import type { Socket } from 'socket.io-client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { POSTGRES_STARTUP_TIMEOUT_MS } from '../testing/postgres';
import { type LoggedIn, type TwoTasks, startTwoTasks } from '../testing/two-tasks';
import { PresenceRegistry } from './presence-registry';
import { RoomMembershipReconciler } from './room-membership-reconciler';

/** 届かないことを確かめるときに待つ時間（届くものは vi.waitFor で待つ）。 */
const QUIET_MS = 700;

// 機能一覧 9.2（在席状態は、その利用者の接続が1本でもそのチャンネルの部屋に入っているかで判定する。受け入れ条件・タスクをまたぐ在席）・
// 2.2（参加資格を失ったとき、入っていた部屋にだけ在席の変化を配る）・5.2（サーバーが自発的に配るイベントの payload に送信時刻を載せる）、
// 要件定義書 4.2（在席の通知・取り直しが失敗しても未処理の例外にしない）。
// サーバーを2つ立て、アダプタを通して確かめる（9.2「1つのプロセスでは落ちない」）。
describe('在席（F-22）', () => {
  let t: TwoTasks;

  beforeAll(async () => {
    t = await startTwoTasks('f');
  }, POSTGRES_STARTUP_TIMEOUT_MS);

  afterEach(() => t.closeSockets());

  afterAll(async () => {
    await t?.stop();
  });

  function enter(socket: Socket, channelId: string): Promise<ChannelEnterAck> {
    return socket
      .timeout(3_000)
      .emitWithAck(REALTIME_REQUESTS.channelEnter, { channelId }) as Promise<ChannelEnterAck>;
  }

  function exit(socket: Socket, channelId: string): Promise<unknown> {
    return socket.timeout(3_000).emitWithAck(REALTIME_REQUESTS.channelExit, { channelId });
  }

  /** その接続に届いた presence:changed を溜める。 */
  function collect(socket: Socket): PresenceChangedPayload[] {
    const received: PresenceChangedPayload[] = [];
    socket.on('presence:changed', (payload: PresenceChangedPayload) => received.push(payload));
    return received;
  }

  const quiet = () => new Promise((resolve) => setTimeout(resolve, QUIET_MS));

  /** 両方のタスクの一覧が、その利用者の在席を反映するまで待つ（他のタスクへの通知は非同期に届く）。 */
  async function untilBothSee(channelId: string, userId: string, present: boolean) {
    await vi.waitFor(
      () => {
        for (const app of [t.first, t.second]) {
          expect(app.get(PresenceRegistry).usersIn(channelId).includes(userId)).toBe(present);
        }
      },
      { timeout: 3_000, interval: 50 },
    );
  }

  /**
   * 入室で配られた presence:changed が届き切るのを待ってから、その接続に届く分を溜め始める。
   * 一覧への反映（untilBothSee が見る。サーバー間の通知）と部屋への配信は別の経路で届き、順序が決まらない——
   * 待たずに溜め始めると、入室の present: true が後から紛れ込む（同じ利用者の2本目の入室で2回配られる場合も含む。9.2 の代償）。
   */
  async function collectAfterEntries(socket: Socket): Promise<PresenceChangedPayload[]> {
    await quiet();
    return collect(socket);
  }

  /** オーナーと alice・bob が参加するチャンネル。 */
  async function channelOfThree() {
    const owner = await t.login();
    const alice = await t.login();
    const bob = await t.login();
    const workspace = await t.workspaceWith(owner, alice, bob);
    const channelId = await t.channelRow(workspace.id, 'PRIVATE', [owner, alice, bob]);
    return { owner, alice, bob, workspace, channelId };
  }

  function sorted(ids: readonly string[]): string[] {
    return [...ids].sort();
  }

  describe('入室の acknowledgement', () => {
    it('その時点で部屋に入っている参加者（他のタスクに繋いだ人と自分を含む）が返る', async () => {
      const { alice, bob, channelId } = await channelOfThree();
      const aliceSocket = await t.open(t.firstBase, alice);
      const bobSocket = await t.open(t.secondBase, bob);

      expect(await enter(aliceSocket, channelId)).toEqual({ ok: true, present: [alice.id] });
      await untilBothSee(channelId, alice.id, true);

      const ack = await enter(bobSocket, channelId);
      expect(ack.ok).toBe(true);
      expect(ack.ok && sorted(ack.present)).toEqual(sorted([alice.id, bob.id]));
    });

    // 機能一覧 9.2「開いているチャンネルの在席が、5分ごとに取り直されて置き換わる（表示のずれは最大5分）」。
    // 画面の側の取り直しは入室要求の送り直しで行う（9.2「クライアントの要求で行う場合…入室要求として扱う」）。
    it('同じ接続が入室し直すと、一覧を取り直してから返す（ずれた一覧をそのまま返さない）', async () => {
      const { alice, bob, channelId } = await channelOfThree();
      await enter(await t.open(t.secondBase, alice), channelId);
      const bobSocket = await t.open(t.firstBase, bob);
      await enter(bobSocket, channelId);
      await untilBothSee(channelId, alice.id, true);
      const received = collect(await t.open(t.secondBase, alice));
      t.first
        .get(PresenceRegistry)
        .replace(channelId, [{ id: 'stale-socket', userId: 'stale-user' }]);

      const ack = await enter(bobSocket, channelId);

      expect(ack.ok && sorted(ack.present)).toEqual(sorted([alice.id, bob.id]));
      await quiet();
      expect(received).toEqual([]);
    });
  });

  describe('presence:changed', () => {
    // 決定・2026-09-13・依頼側: Valkey が止まっている間のキック・退出で外し損ねた接続は、各タスクの参加の照合で外す。
    // 照合で外れた利用者は参加者でなくなっており、他のタスクにその利用者の接続が残っていても（そちらの照合がまだ走っていなくても）在席ではない。
    it('参加の照合で外された利用者は、別のタスクに接続が残っていても、照合したタスクが在席から外し、present: false が1回届く', async () => {
      const { alice, bob, channelId } = await channelOfThree();
      const bobSocket = await t.open(t.secondBase, bob);
      await enter(bobSocket, channelId);
      await enter(await t.open(t.firstBase, alice), channelId);
      await enter(await t.open(t.secondBase, alice), channelId);
      await untilBothSee(channelId, alice.id, true);
      const received = await collectAfterEntries(bobSocket);
      await t.prisma.channelMember.deleteMany({ where: { channelId, userId: alice.id } });

      await t.first.get(RoomMembershipReconciler).reconcile();

      await vi.waitFor(() => expect(received).toHaveLength(1), { timeout: 3_000 });
      expect(received[0]).toMatchObject({ channelId, userId: alice.id, present: false });
      await untilBothSee(channelId, alice.id, false);
      await quiet();
      expect(received).toHaveLength(1);
    });

    it('最初の接続が入ったときに、送信時刻つきで部屋へ1回届く。同じ利用者の2本目（別のタスク）では届かない', async () => {
      const { alice, bob, channelId } = await channelOfThree();
      const bobSocket = await t.open(t.firstBase, bob);
      await enter(bobSocket, channelId);
      const received = collect(bobSocket);

      const before = Date.now();
      await enter(await t.open(t.firstBase, alice), channelId);
      await vi.waitFor(() => expect(received).toHaveLength(1), { timeout: 3_000 });
      expect(received[0]).toMatchObject({ channelId, userId: alice.id, present: true });
      expect(Date.parse(received[0]?.sentAt ?? '')).toBeGreaterThanOrEqual(before - 1_000);
      await untilBothSee(channelId, alice.id, true);

      await enter(await t.open(t.secondBase, alice), channelId);
      await quiet();
      expect(received).toHaveLength(1);
    });

    it('最後の接続が退室したときにだけ present: false が届く。もう1本が部屋に残っている間は届かない', async () => {
      const { alice, bob, channelId } = await channelOfThree();
      const bobSocket = await t.open(t.secondBase, bob);
      await enter(bobSocket, channelId);
      const aliceFirst = await t.open(t.firstBase, alice);
      const aliceSecond = await t.open(t.secondBase, alice);
      await enter(aliceFirst, channelId);
      await enter(aliceSecond, channelId);
      await untilBothSee(channelId, alice.id, true);
      // 2本目の入室の通知が最初のタスクに届くまで待つ（届く前に外れると、在席が消えたと配られる。9.2 の代償）。
      await quiet();
      const received = collect(bobSocket);

      await exit(aliceFirst, channelId);
      await quiet();
      expect(received).toEqual([]);
      expect(t.second.get(PresenceRegistry).usersIn(channelId)).toContain(alice.id);

      await exit(aliceSecond, channelId);
      await vi.waitFor(() => expect(received).toHaveLength(1), { timeout: 3_000 });
      expect(received[0]).toMatchObject({ channelId, userId: alice.id, present: false });
      await untilBothSee(channelId, alice.id, false);
    });

    it('切断で最後の接続が部屋から外れると present: false が届き、他のタスクの一覧からも消える', async () => {
      const { alice, bob, channelId } = await channelOfThree();
      const bobSocket = await t.open(t.firstBase, bob);
      await enter(bobSocket, channelId);
      const aliceSocket = await t.open(t.secondBase, alice);
      await enter(aliceSocket, channelId);
      await untilBothSee(channelId, alice.id, true);
      const received = await collectAfterEntries(bobSocket);

      aliceSocket.close();

      await vi.waitFor(() => expect(received).toHaveLength(1), { timeout: 3_000 });
      expect(received[0]).toMatchObject({ channelId, userId: alice.id, present: false });
      await untilBothSee(channelId, alice.id, false);
    });

    it('部屋に入っていない接続（参加していないオーナーを含む）には届かない', async () => {
      const owner = await t.login();
      const alice = await t.login();
      const workspace = await t.workspaceWith(owner, alice);
      const channelId = await t.channelRow(workspace.id, 'PRIVATE', [alice]);
      const ownerReceived = collect(await t.open(t.firstBase, owner));

      await enter(await t.open(t.secondBase, alice), channelId);
      await untilBothSee(channelId, alice.id, true);
      await quiet();

      expect(ownerReceived).toEqual([]);
    });
  });

  describe('参加資格を失ったとき（機能一覧 2.2）', () => {
    it('チャンネルからキックされると、在席していた利用者の present: false が1回届き、以後の入室の acknowledgement に残らない', async () => {
      const { owner, alice, bob, workspace, channelId } = await channelOfThree();
      const bobSocket = await t.open(t.firstBase, bob);
      await enter(bobSocket, channelId);
      await enter(await t.open(t.firstBase, alice), channelId);
      await enter(await t.open(t.secondBase, alice), channelId);
      await untilBothSee(channelId, alice.id, true);
      const received = await collectAfterEntries(bobSocket);

      const res = await t.send(
        'DELETE',
        `/workspaces/${workspace.id}/channels/${channelId}/members/${alice.id}`,
        owner,
      );
      expect(res.status).toBe(204);

      await vi.waitFor(() => expect(received).toHaveLength(1), { timeout: 3_000 });
      expect(received[0]).toMatchObject({ channelId, userId: alice.id, present: false });
      await untilBothSee(channelId, alice.id, false);
      await quiet();
      expect(received).toHaveLength(1);

      const ack = await enter(await t.open(t.secondBase, owner), channelId);
      expect(ack.ok && ack.present).not.toContain(alice.id);
    });

    it('ワークスペースから退出すると、入っていた部屋にだけ present: false が届く（参加していても入っていなかった部屋には配らない）', async () => {
      const { alice, bob, workspace, channelId } = await channelOfThree();
      const notEntered = await t.channelRow(workspace.id, 'PUBLIC', [alice, bob]);
      const bobSocket = await t.open(t.secondBase, bob);
      await enter(bobSocket, channelId);
      await enter(bobSocket, notEntered);
      await enter(await t.open(t.firstBase, alice), channelId);
      await untilBothSee(channelId, alice.id, true);
      const received = await collectAfterEntries(bobSocket);

      const res = await t.send('POST', `/workspaces/${workspace.id}/leave`, alice);
      expect(res.status).toBe(204);

      await vi.waitFor(() => expect(received).toHaveLength(1), { timeout: 3_000 });
      expect(received[0]).toMatchObject({ channelId, userId: alice.id, present: false });
      await quiet();
      expect(received.map((payload) => payload.channelId)).toEqual([channelId]);
    });
  });

  it('参加者一覧の API は在席を含まない（参加者が求めた場合も、オーナーが求めた場合も）', async () => {
    const { owner, alice, bob, workspace, channelId } = await channelOfThree();
    await enter(await t.open(t.firstBase, alice), channelId);
    await untilBothSee(channelId, alice.id, true);

    for (const by of [bob, owner] satisfies LoggedIn[]) {
      const res = await t.send(
        'GET',
        `/workspaces/${workspace.id}/channels/${channelId}/members`,
        by,
      );
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).not.toMatch(/presen|online|在席/i);
    }
  });

  describe('一覧の取り直し', () => {
    it('取りこぼしてずれた一覧を、部屋に入っている接続（全タスク）で置き換える', async () => {
      const { alice, bob, channelId } = await channelOfThree();
      await enter(await t.open(t.secondBase, alice), channelId);
      await enter(await t.open(t.firstBase, bob), channelId);
      await untilBothSee(channelId, alice.id, true);
      const registry = t.first.get(PresenceRegistry);
      registry.replace(channelId, [{ id: 'stale-socket', userId: 'stale-user' }]);
      expect(registry.usersIn(channelId)).toEqual(['stale-user']);

      await registry.refresh();

      expect(sorted(registry.usersIn(channelId))).toEqual(sorted([alice.id, bob.id]));
    });

    // Valkey を止めるため、この it は最後に置く。
    it('Valkey が止まっていて取り直しに失敗しても、例外にせず今の一覧を残し、warn を残す', async () => {
      const { alice, channelId } = await channelOfThree();
      await enter(await t.open(t.secondBase, alice), channelId);
      await untilBothSee(channelId, alice.id, true);
      const registry = t.first.get(PresenceRegistry);
      const warned = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      try {
        await t.valkey.stop();
        await expect(registry.refresh()).resolves.toBeUndefined();
        expect(registry.usersIn(channelId)).toContain(alice.id);
        expect(warned).toHaveBeenCalled();
      } finally {
        warned.mockRestore();
      }
    });
  });
});
