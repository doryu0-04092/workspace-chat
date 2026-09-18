import 'reflect-metadata';
import {
  type ChannelEnterAck,
  type ChannelRoomAck,
  REALTIME_REQUESTS,
  type RealtimeEventName,
  type TypingPayload,
} from '@workspace-chat/shared';
import type { Socket } from 'socket.io-client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { POSTGRES_STARTUP_TIMEOUT_MS } from '../testing/postgres';
import { type LoggedIn, type TwoTasks, startTwoTasks } from '../testing/two-tasks';
import { TYPING_LIMIT } from './channel-rooms.gateway';

const TYPING_START = 'typing:start' satisfies RealtimeEventName;
const TYPING_STOP = 'typing:stop' satisfies RealtimeEventName;
const NOT_FOUND = { code: 'not_found', message: '見つかりません' };

/** 届かないことを確かめるときに待つ時間（届くものは vi.waitFor で待つ）。 */
const QUIET_MS = 700;

// 機能一覧 13.3（F-34 入力中インジケータ）・5.2（チャンネルのイベントを受け付けるたびに、送信元が該当チャンネルの参加者であることを確認する。
// イベントの1件ごとの確認でも、送信元が退会していないことを見る）・要件定義書 4.8 の3（WebSocket が非参加者にイベントを配信しないこと）。
// サーバーを2つ立て、他のタスクの参加者にアダプタを通って届くことを確かめる。
describe('入力中インジケータ（F-34）', () => {
  let t: TwoTasks;

  beforeAll(async () => {
    t = await startTwoTasks('1b');
  }, POSTGRES_STARTUP_TIMEOUT_MS);

  afterEach(() => t.closeSockets());

  afterAll(async () => {
    await t?.stop();
  });

  async function enter(socket: Socket, channelId: string): Promise<void> {
    const ack = (await socket
      .timeout(3_000)
      .emitWithAck(REALTIME_REQUESTS.channelEnter, { channelId })) as ChannelEnterAck;
    expect(ack.ok).toBe(true);
  }

  function typing(
    socket: Socket,
    event: typeof TYPING_START | typeof TYPING_STOP,
    body: unknown,
  ): Promise<ChannelRoomAck> {
    return socket.timeout(3_000).emitWithAck(event, body) as Promise<ChannelRoomAck>;
  }

  /** その接続に届いた入力中の配信を溜める。 */
  function collect(socket: Socket): { event: string; payload: TypingPayload }[] {
    const received: { event: string; payload: TypingPayload }[] = [];
    for (const event of [TYPING_START, TYPING_STOP] as const) {
      socket.on(event, (payload: TypingPayload) => received.push({ event, payload }));
    }
    return received;
  }

  const quiet = () => new Promise((resolve) => setTimeout(resolve, QUIET_MS));

  /** オーナー・alice・bob のワークスペースと、alice と bob が参加するプライベートチャンネル（オーナーは参加しない）。 */
  async function privateChannel() {
    const owner = await t.login();
    const alice = await t.login();
    const bob = await t.login();
    const workspace = await t.workspaceWith(owner, alice, bob);
    const channelId = await t.channelRow(workspace.id, 'PRIVATE', [alice, bob]);
    return { owner, alice, bob, workspace, channelId };
  }

  async function summaryOf(user: LoggedIn) {
    const row = await t.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    return { id: row.id, userId: row.loginId, displayName: row.displayName, avatarUrl: null };
  }

  it('部屋に入っている参加者の typing:start / typing:stop を、送信時刻と利用者の要約つきで、他のタスクの参加者を含むそのチャンネルの部屋へ配る', async () => {
    const { alice, bob, channelId } = await privateChannel();
    const aliceSocket = await t.open(t.firstBase, alice);
    const bobSocket = await t.open(t.secondBase, bob);
    await enter(aliceSocket, channelId);
    await enter(bobSocket, channelId);
    await quiet();
    const received = collect(bobSocket);

    const before = Date.now();
    expect(await typing(aliceSocket, TYPING_START, { channelId })).toEqual({ ok: true });
    expect(await typing(aliceSocket, TYPING_STOP, { channelId })).toEqual({ ok: true });

    await vi.waitFor(() => expect(received).toHaveLength(2), { timeout: 3_000 });
    const user = await summaryOf(alice);
    expect(received.map(({ event }) => event)).toEqual([TYPING_START, TYPING_STOP]);
    for (const { payload } of received) {
      expect(payload).toMatchObject({ channelId, user });
      expect(Date.parse(payload.sentAt)).toBeGreaterThanOrEqual(before - 1_000);
    }
  });

  // CLAUDE.md 2（プライベートチャンネルは WebSocket 配信で非参加者に渡さない。オーナーの例外は WebSocket に及ばない）。
  it('部屋に入っていない接続（参加していないオーナー・入室していない参加者）には届かない', async () => {
    const { owner, alice, bob, channelId } = await privateChannel();
    const aliceSocket = await t.open(t.firstBase, alice);
    await enter(aliceSocket, channelId);
    const ownerReceived = collect(await t.open(t.secondBase, owner));
    const bobReceived = collect(await t.open(t.secondBase, bob));

    expect(await typing(aliceSocket, TYPING_START, { channelId })).toEqual({ ok: true });

    await quiet();
    expect(ownerReceived).toEqual([]);
    expect(bobReceived).toEqual([]);
  });

  it('参加していない利用者（オーナーを含む）の typing:start は、入室と同じ2段階で断り、部屋へ配らない', async () => {
    const { owner, alice, workspace, channelId } = await privateChannel();
    const outsider = await t.login();
    const publicId = await t.channelRow(workspace.id, 'PUBLIC', [alice]);
    const aliceSocket = await t.open(t.firstBase, alice);
    await enter(aliceSocket, channelId);
    await enter(aliceSocket, publicId);
    await quiet();
    const received = collect(aliceSocket);
    const ownerSocket = await t.open(t.secondBase, owner);
    const outsiderSocket = await t.open(t.secondBase, outsider);

    expect(await typing(ownerSocket, TYPING_START, { channelId })).toEqual({
      ok: false,
      status: 404,
      error: NOT_FOUND,
    });
    expect(await typing(ownerSocket, TYPING_START, { channelId: publicId })).toMatchObject({
      ok: false,
      status: 403,
      error: { code: 'not_a_channel_member' },
    });
    for (const target of [channelId, publicId]) {
      expect(await typing(outsiderSocket, TYPING_START, { channelId: target })).toEqual({
        ok: false,
        status: 404,
        error: NOT_FOUND,
      });
    }

    await quiet();
    expect(received).toEqual([]);
  });

  // 機能一覧 5.2「チャンネルのイベントを受け付けるたびに、送信元が該当チャンネルの参加者であることを確認する」。
  // 部屋に残った接続（外し損ね）からでも、参加者でなくなっていれば配らない。
  it('部屋に入ったまま参加者でなくなった接続の typing:start は断り、配らない', async () => {
    const { alice, bob, channelId } = await privateChannel();
    const aliceSocket = await t.open(t.firstBase, alice);
    const bobSocket = await t.open(t.secondBase, bob);
    await enter(aliceSocket, channelId);
    await enter(bobSocket, channelId);
    await quiet();
    const received = collect(bobSocket);
    await t.prisma.channelMember.deleteMany({ where: { channelId, userId: alice.id } });

    expect(await typing(aliceSocket, TYPING_START, { channelId })).toEqual({
      ok: false,
      status: 404,
      error: NOT_FOUND,
    });

    await quiet();
    expect(received).toEqual([]);
  });

  // 要件定義書 4.8 の9（退会済みのトークンが WebSocket でも拒否されること）・機能一覧 5.2（イベントの1件ごとの確認でも、送信元が退会していないことを見る）。
  it('退会した利用者の接続からの typing:start / typing:stop は断り、配らない', async () => {
    const { alice, bob, channelId } = await privateChannel();
    const aliceSocket = await t.open(t.firstBase, alice);
    const bobSocket = await t.open(t.secondBase, bob);
    await enter(aliceSocket, channelId);
    await enter(bobSocket, channelId);
    await quiet();
    const received = collect(bobSocket);
    await t.prisma.user.update({ where: { id: alice.id }, data: { deletedAt: new Date() } });

    for (const event of [TYPING_START, TYPING_STOP] as const) {
      expect(await typing(aliceSocket, event, { channelId })).toEqual({
        ok: false,
        status: 404,
        error: NOT_FOUND,
      });
    }

    await quiet();
    expect(received).toEqual([]);
  });

  it('本体の channelId が UUID でなければ 400 で断る', async () => {
    const { alice } = await privateChannel();
    const socket = await t.open(t.firstBase, alice);

    for (const body of [{ channelId: 'not-a-uuid' }, null, 'x']) {
      expect(await typing(socket, TYPING_START, body)).toMatchObject({ ok: false, status: 400 });
    }
  });

  // 1件ごとに DB で参加を確かめるため、送る回数に歯止めを置く（CWE-770。実装時に決めた値）。
  it('同じ利用者の typing:start / typing:stop は、接続とタスクをまたいで合わせて数え、上限を超えたら 429 で断って配らない', async () => {
    const { alice, bob, channelId } = await privateChannel();
    const onFirst = await t.open(t.firstBase, alice);
    const onSecond = await t.open(t.secondBase, alice);
    const bobSocket = await t.open(t.firstBase, bob);
    await enter(bobSocket, channelId);
    await quiet();

    for (let i = 0; i < TYPING_LIMIT.limit; i += 1) {
      const socket = i % 2 === 0 ? onFirst : onSecond;
      const event = i % 2 === 0 ? TYPING_START : TYPING_STOP;
      expect(await typing(socket, event, { channelId })).toEqual({ ok: true });
    }
    await quiet();
    const received = collect(bobSocket);

    expect(await typing(onSecond, TYPING_START, { channelId })).toMatchObject({
      ok: false,
      status: 429,
      error: { code: 'too_many_requests' },
    });
    expect(await typing(onFirst, TYPING_STOP, { channelId })).toMatchObject({
      ok: false,
      status: 429,
    });

    await quiet();
    expect(received).toEqual([]);
  });
});
