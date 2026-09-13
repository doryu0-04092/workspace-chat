import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import {
  type ChannelEnterAck,
  type ChannelRoomAck,
  REALTIME_REQUESTS,
} from '@workspace-chat/shared';
import type { Socket } from 'socket.io-client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { CapturingLogger } from '../testing/capturing-logger';
import { POSTGRES_STARTUP_TIMEOUT_MS } from '../testing/postgres';
import { nextEvent } from '../testing/realtime-client';
import { type TwoTasks, startTwoTasks } from '../testing/two-tasks';
import { RealtimeGateway, channelRoom } from './realtime.gateway';

const NOT_FOUND = { code: 'not_found', message: '見つかりません' };
const MISSING_ID = '00000000-0000-7000-8000-000000000000';
const TOO_MANY_REQUESTS = {
  code: 'too_many_requests',
  message: '要求が多すぎます。しばらく待ってからやり直してください',
};
/** 入室要求の上限（利用者単位で1分に60回。決定・2026-09-13・依頼側）。 */
const ENTER_LIMIT = 60;

// 機能一覧 9.2「部屋（Socket.IO の room）」・2.2（参加資格を失ったとき）、要件定義書 4.8 の3
// （WebSocket が非参加者にイベントを配信しないこと: 非参加者をチャンネルの部屋に入れないこと、参加者でなくなった接続を部屋から外すこと）。
// タスクを2つに見立て、Redis アダプタを通して確かめる（1つのプロセスでは、他のタスクの接続を外し損ねても落ちない）。
describe('チャンネルの部屋への入室・退室と、参加資格を失ったときに部屋から外す処理（#335 の4つ目・#331）', () => {
  let t: TwoTasks;
  const logger = new CapturingLogger();

  beforeAll(async () => {
    t = await startTwoTasks('e', { logger });
  }, POSTGRES_STARTUP_TIMEOUT_MS);

  afterEach(() => t.closeSockets());

  afterAll(async () => {
    await t?.stop();
  });

  function enter(socket: Socket, channelId: unknown): Promise<ChannelEnterAck> {
    return socket
      .timeout(3_000)
      .emitWithAck(REALTIME_REQUESTS.channelEnter, { channelId }) as Promise<ChannelEnterAck>;
  }

  function exit(socket: Socket, channelId: unknown): Promise<ChannelRoomAck> {
    return socket
      .timeout(3_000)
      .emitWithAck(REALTIME_REQUESTS.channelExit, { channelId }) as Promise<ChannelRoomAck>;
  }

  /** そのチャンネルの部屋へ1回送り、接続ごとに届いたかを返す（最初のタスクから送る。他のタスクの接続にはアダプタを通って届く）。 */
  async function reached(sockets: Socket[], channelId: string): Promise<boolean[]> {
    const probe = { probe: randomUUID() };
    const waits = sockets.map((socket) => nextEvent(socket, 'message:new', 1_000));
    t.first.get(RealtimeGateway).server.to(channelRoom(channelId)).emit('message:new', probe);
    return (await Promise.all(waits)).map(
      (payload) => (payload as { probe?: string } | undefined)?.probe === probe.probe,
    );
  }

  /** 部屋に入っている接続の利用者（両方のタスクの手元の接続を合わせる。Valkey を通る問い合わせの待ちに左右させない）。 */
  async function usersInRoom(channelId: string): Promise<string[]> {
    const users: string[] = [];
    for (const app of [t.first, t.second]) {
      const sockets = await app
        .get(RealtimeGateway)
        .server.in(channelRoom(channelId))
        .local.fetchSockets();
      users.push(...sockets.map((socket) => (socket.data as { user: { id: string } }).user.id));
    }
    return users;
  }

  /** 部屋から外す処理は他のタスクへアダプタを通って届くため、外れ切るまで待つ。 */
  async function untilLeft(channelId: string, userId: string): Promise<void> {
    await vi.waitFor(async () => expect(await usersInRoom(channelId)).not.toContain(userId), {
      timeout: 3_000,
      interval: 50,
    });
  }

  describe('入室', () => {
    it('参加者は入室でき、別のタスクから送ったチャンネルの部屋のイベントが、同じ利用者のすべての接続に届く', async () => {
      const owner = await t.login();
      const alice = await t.login();
      const workspace = await t.workspaceWith(owner, alice);
      const channelId = await t.channelRow(workspace.id, 'PRIVATE', [alice]);
      const onFirst = await t.open(t.firstBase, alice);
      const onSecond = await t.open(t.secondBase, alice);

      expect(await enter(onFirst, channelId)).toMatchObject({ ok: true });
      expect(await enter(onSecond, channelId)).toMatchObject({ ok: true });

      expect(await reached([onFirst, onSecond], channelId)).toEqual([true, true]);
    });

    it('アーカイブ済みのチャンネルにも、参加者は入室できる（参加者は読める。機能一覧 3.2）', async () => {
      const owner = await t.login();
      const alice = await t.login();
      const workspace = await t.workspaceWith(owner, alice);
      const channelId = await t.channelRow(workspace.id, 'PUBLIC', [alice], true);
      const socket = await t.open(t.secondBase, alice);

      expect(await enter(socket, channelId)).toMatchObject({ ok: true });
      expect(await reached([socket], channelId)).toEqual([true]);
    });

    it('所属していなければ、種別によらず 404 で断り、部屋に入れない', async () => {
      const owner = await t.login();
      const outsider = await t.login();
      const workspace = await t.workspaceWith(owner);
      const publicId = await t.channelRow(workspace.id, 'PUBLIC', [owner]);
      const privateId = await t.channelRow(workspace.id, 'PRIVATE', [owner]);
      const socket = await t.open(t.secondBase, outsider);

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
      const owner = await t.login();
      const bob = await t.login();
      const workspace = await t.workspaceWith(owner, bob);
      const publicId = await t.channelRow(workspace.id, 'PUBLIC', [owner]);
      const privateId = await t.channelRow(workspace.id, 'PRIVATE', [owner]);
      const socket = await t.open(t.firstBase, bob);

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
      const owner = await t.login();
      const alice = await t.login();
      const workspace = await t.workspaceWith(owner, alice);
      const publicId = await t.channelRow(workspace.id, 'PUBLIC', [alice]);
      const privateId = await t.channelRow(workspace.id, 'PRIVATE', [alice]);
      const socket = await t.open(t.firstBase, owner);

      expect(await enter(socket, privateId)).toEqual({ ok: false, status: 404, error: NOT_FOUND });
      expect(await enter(socket, publicId)).toMatchObject({ ok: false, status: 403 });
      expect(await reached([socket], privateId)).toEqual([false]);
    });

    it('別のワークスペースのチャンネルは、そちらに参加していても、ワークスペースから外れていれば 404', async () => {
      const owner = await t.login();
      const alice = await t.login();
      const workspace = await t.workspaceWith(owner, alice);
      const channelId = await t.channelRow(workspace.id, 'PUBLIC', [alice]);
      await t.prisma.membership.deleteMany({
        where: { workspaceId: workspace.id, userId: alice.id },
      });
      const socket = await t.open(t.firstBase, alice);

      expect(await enter(socket, channelId)).toEqual({ ok: false, status: 404, error: NOT_FOUND });
    });

    it('チャンネルの ID が UUID の文字列でなければ 400 validation_failed で断る', async () => {
      const alice = await t.login();
      const socket = await t.open(t.firstBase, alice);

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
      const owner = await t.login();
      const alice = await t.login();
      const workspace = await t.workspaceWith(owner, alice);
      const channelId = await t.channelRow(workspace.id, 'PUBLIC', [alice]);
      const lateId = await t.channelRow(workspace.id, 'PUBLIC', [alice]);
      const onFirst = await t.open(t.firstBase, alice);
      const onSecond = await t.open(t.secondBase, alice);

      for (let i = 0; i < ENTER_LIMIT / 2; i += 1) {
        expect(await enter(onFirst, channelId)).toMatchObject({ ok: true });
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
      const owner = await t.login();
      const alice = await t.login();
      const bob = await t.login();
      const workspace = await t.workspaceWith(owner, alice, bob);
      const channelId = await t.channelRow(workspace.id, 'PUBLIC', [bob]);
      const aliceSocket = await t.open(t.firstBase, alice);
      const bobSocket = await t.open(t.firstBase, bob);
      for (let i = 0; i < ENTER_LIMIT; i += 1) await enter(aliceSocket, 'not-a-uuid');
      expect(await enter(aliceSocket, 'not-a-uuid')).toMatchObject({ ok: false, status: 429 });

      expect(await enter(bobSocket, channelId)).toMatchObject({ ok: true });
    });

    it('退室要求は数えない（上限を超える回数の退室の後も、入室を断らない）', async () => {
      const owner = await t.login();
      const alice = await t.login();
      const workspace = await t.workspaceWith(owner, alice);
      const channelId = await t.channelRow(workspace.id, 'PUBLIC', [alice]);
      const socket = await t.open(t.firstBase, alice);

      for (let i = 0; i <= ENTER_LIMIT; i += 1) {
        expect(await exit(socket, channelId)).toEqual({ ok: true });
      }

      expect(await enter(socket, channelId)).toMatchObject({ ok: true });
    });

    it('上限の超過を、制限の種類（user）・利用者の ID・要求の名前とともに記録する', async () => {
      const alice = await t.login();
      const socket = await t.open(t.secondBase, alice);
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
      const owner = await t.login();
      const alice = await t.login();
      const workspace = await t.workspaceWith(owner, alice);
      const channelId = await t.channelRow(workspace.id, 'PUBLIC', [alice]);
      const closing = await t.open(t.firstBase, alice);
      const staying = await t.open(t.secondBase, alice);
      await enter(closing, channelId);
      await enter(staying, channelId);

      expect(await exit(closing, channelId)).toEqual({ ok: true });

      expect(await reached([closing, staying], channelId)).toEqual([false, true]);
    });

    it('チャンネルの ID が UUID の文字列でなければ 400 validation_failed で断る', async () => {
      const alice = await t.login();
      const socket = await t.open(t.firstBase, alice);

      expect(await exit(socket, 'not-a-uuid')).toMatchObject({ ok: false, status: 400 });
    });
  });

  describe('参加資格を失ったとき（機能一覧 2.2）', () => {
    /** オーナーと2人のメンバーのワークスペースに、2人が参加するチャンネルを2つ作り、alice の2つの接続（別のタスク）と bob を両方に入室させる。 */
    async function roomsWithAliceAndBob() {
      const owner = await t.login();
      const alice = await t.login();
      const bob = await t.login();
      const workspace = await t.workspaceWith(owner, alice, bob);
      const leftId = await t.channelRow(workspace.id, 'PRIVATE', [owner, alice, bob]);
      const otherId = await t.channelRow(workspace.id, 'PUBLIC', [alice, bob]);
      const aliceOnFirst = await t.open(t.firstBase, alice);
      const aliceOnSecond = await t.open(t.secondBase, alice);
      const bobSocket = await t.open(t.secondBase, bob);
      for (const socket of [aliceOnFirst, aliceOnSecond, bobSocket]) {
        for (const channelId of [leftId, otherId]) {
          expect(await enter(socket, channelId)).toMatchObject({ ok: true });
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

      const res = await t.send(
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

      const res = await t.send(
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
      const elsewhere = await t.workspaceWith(await t.login(), r.alice);
      const elsewhereId = await t.channelRow(elsewhere.id, 'PUBLIC', [r.alice]);
      expect(await enter(r.aliceOnSecond, elsewhereId)).toMatchObject({ ok: true });

      const res = await t.send(
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

      const res = await t.send('POST', `/workspaces/${r.workspace.id}/leave`, r.alice);
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

      await t.send(
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
