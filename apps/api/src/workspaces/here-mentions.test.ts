import 'reflect-metadata';
import {
  type ChannelEnterAck,
  type components,
  HERE_MENTION_NOTICE,
  type HereMentionPayload,
  type HereMentionReceipt,
  type MessageNewPayload,
  REALTIME_REQUESTS,
  type UnreadUpdatedPayload,
} from '@workspace-chat/shared';
import type { Socket } from 'socket.io-client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PresenceRegistry } from '../realtime/presence-registry';
import { HERE_RECEIPT_TIMEOUT_MS } from '../realtime/here-receipts';
import { POSTGRES_STARTUP_TIMEOUT_MS } from '../testing/postgres';
import { type LoggedIn, type TwoTasks, startTwoTasks } from '../testing/two-tasks';

type Message = components['schemas']['Message'];
type Channel = components['schemas']['Channel'];

/** 届かないことを確かめるときに待つ時間（届くものは vi.waitFor で待つ）。 */
const QUIET_MS = 700;
/** 受け取りの記録を待つ時間（受け取りを待つ期限と、タスクをまたぐ問い合わせの余裕）。 */
const RECORD_WAIT_MS = HERE_RECEIPT_TIMEOUT_MS + 8_000;

// 機能一覧 9.2（F-21 `@here` / `@channel`。受け入れ条件・タスクをまたぐ在席）・10.2（`@here` はチャンネルを開いていなければバッジを出さない）・
// 5.2（利用者の部屋を宛先に加えるなら、加える利用者がその値を受け取る資格を持つことを確認する。在席の一覧に載っていることを資格の根拠にしない）、
// 要件定義書 4.2（在席の通知・取り直しが失敗しても未処理の例外にしない）・4.8 の3（WebSocket が非参加者にイベントを配信しないこと）。
// サーバーを2つ立て、アダプタを通して確かめる（9.2「1つのプロセスでは落ちない」）。
describe('@here / @channel（F-21）', () => {
  let t: TwoTasks;

  beforeAll(async () => {
    t = await startTwoTasks('2c');
  }, POSTGRES_STARTUP_TIMEOUT_MS);

  afterEach(() => t.closeSockets());

  afterAll(async () => {
    await t?.stop();
  });

  const quiet = () => new Promise((resolve) => setTimeout(resolve, QUIET_MS));

  async function enter(socket: Socket, channelId: string): Promise<void> {
    const ack = (await socket
      .timeout(3_000)
      .emitWithAck(REALTIME_REQUESTS.channelEnter, { channelId })) as ChannelEnterAck;
    expect(ack.ok).toBe(true);
  }

  /** 画面と同じく、開いているチャンネル（`open`）の `@here` にだけ受け取りを返す接続。届いた確かめと配信を溜める。 */
  function listen(socket: Socket, open: string | null) {
    const notices: HereMentionPayload[] = [];
    const messages: Message[] = [];
    const unread: UnreadUpdatedPayload[] = [];
    socket.on(
      HERE_MENTION_NOTICE,
      (payload: HereMentionPayload, ack: (receipt: HereMentionReceipt) => void) => {
        notices.push(payload);
        if (payload.channelId === open) ack({ received: true });
      },
    );
    socket.on('message:new', ({ message }: MessageNewPayload) => messages.push(message));
    socket.on('unread:updated', (payload: UnreadUpdatedPayload) => unread.push(payload));
    return { notices, messages, unread };
  }

  async function post(by: LoggedIn, workspaceId: string, channelId: string, body: string) {
    const res = await t.send(
      'POST',
      `/workspaces/${workspaceId}/channels/${channelId}/messages`,
      by,
      {
        body,
      },
    );
    expect(res.status).toBe(201);
    return (await res.json()) as Message;
  }

  async function edit(
    by: LoggedIn,
    workspaceId: string,
    channelId: string,
    id: string,
    body: string,
  ) {
    const res = await fetch(
      `${t.firstBase}/api/workspaces/${workspaceId}/channels/${channelId}/messages/${id}`,
      {
        method: 'PATCH',
        headers: { authorization: by.authorization, 'content-type': 'application/json' },
        body: JSON.stringify({ body }),
      },
    );
    expect(res.status).toBe(200);
  }

  async function mentionsOf(by: LoggedIn, workspaceId: string, channelId: string) {
    const res = await t.send('GET', `/workspaces/${workspaceId}/channels`, by);
    expect(res.status).toBe(200);
    const channel = ((await res.json()) as Channel[]).find((c) => c.id === channelId);
    return channel?.mentions;
  }

  async function recipientsOf(messageId: string) {
    const rows = await t.prisma.hereMentionRecipient.findMany({ where: { messageId } });
    return new Map(rows.map((row) => [row.userId, row.receivedAt !== null]));
  }

  /** 両方のタスクの在席の一覧に、その利用者が載るまで待つ（他のタスクへの通知は非同期に届く）。 */
  async function untilBothSee(channelId: string, userIds: string[]) {
    await vi.waitFor(
      () => {
        for (const app of [t.first, t.second]) {
          expect(app.get(PresenceRegistry).usersIn(channelId)).toEqual(
            expect.arrayContaining(userIds),
          );
        }
      },
      // CI では、他のタスクへの在席の通知が手元より遅れて届く（10 本をまとめた PR の CI で、3 秒では1人ぶん届かなかった）
      { timeout: 15_000, interval: 50 },
    );
  }

  /**
   * alice（書く人）・bob（別のタスクで開いている）・carol（同じタスクで開いている）・dave（参加者で、繋いでいるが開いていない）が参加し、
   * erin（ワークスペースのメンバーで、参加していない）とオーナー（参加していない）が繋いでいるプライベートチャンネル。
   */
  async function scene() {
    const owner = await t.login();
    const [alice, bob, carol, dave, erin] = [
      await t.login(),
      await t.login(),
      await t.login(),
      await t.login(),
      await t.login(),
    ] as [LoggedIn, LoggedIn, LoggedIn, LoggedIn, LoggedIn];
    const workspace = await t.workspaceWith(owner, alice, bob, carol, dave, erin);
    const channelId = await t.channelRow(workspace.id, 'PRIVATE', [alice, bob, carol, dave]);
    const aliceSocket = await t.open(t.firstBase, alice);
    const bobSocket = await t.open(t.secondBase, bob);
    const carolSocket = await t.open(t.firstBase, carol);
    const sockets = {
      alice: listen(aliceSocket, channelId),
      bob: listen(bobSocket, channelId),
      carol: listen(carolSocket, channelId),
      dave: listen(await t.open(t.firstBase, dave), null),
      erin: listen(await t.open(t.secondBase, erin), null),
      owner: listen(await t.open(t.firstBase, owner), null),
    };
    for (const socket of [aliceSocket, bobSocket, carolSocket]) await enter(socket, channelId);
    await untilBothSee(channelId, [alice.id, bob.id, carol.id]);
    await quiet();
    return { owner, alice, bob, carol, dave, erin, workspace, channelId, sockets };
  }

  describe('@channel', () => {
    it('在席を見ず、参加者全員（開いていない参加者を含む）に1回だけ届け、参加していない利用者には届けない。参加者のメンションの件数に数える', async () => {
      const { alice, bob, dave, erin, owner, workspace, channelId, sockets } = await scene();

      const message = await post(alice, workspace.id, channelId, '@channel お知らせです');

      await vi.waitFor(() => {
        for (const name of ['bob', 'carol', 'dave'] as const) {
          expect(sockets[name].messages.map((m) => m.id)).toEqual([message.id]);
        }
      });
      await quiet();
      expect(sockets.erin.messages).toEqual([]);
      expect(sockets.owner.messages).toEqual([]);
      for (const name of ['bob', 'carol', 'dave'] as const)
        expect(sockets[name].messages).toHaveLength(1);
      expect(sockets.dave.notices).toEqual([]);

      expect(await mentionsOf(dave, workspace.id, channelId)).toBe(1);
      expect(await mentionsOf(bob, workspace.id, channelId)).toBe(1);
      expect(await mentionsOf(alice, workspace.id, channelId)).toBe(0);
      expect(await mentionsOf(owner, workspace.id, channelId)).toBeUndefined();
      expect(await mentionsOf(erin, workspace.id, channelId)).toBeUndefined();
    });

    it('スレッドの返信の @channel も、開いていない参加者に届く', async () => {
      const { alice, workspace, channelId, sockets } = await scene();
      const parent = await post(alice, workspace.id, channelId, '親');

      const res = await t.send(
        'POST',
        `/workspaces/${workspace.id}/channels/${channelId}/messages/${parent.id}/replies`,
        alice,
        { body: '@channel 返信です' },
      );
      expect(res.status).toBe(201);
      const reply = (await res.json()) as Message;

      await vi.waitFor(() => expect(sockets.dave.messages.map((m) => m.id)).toContain(reply.id));
    });

    it('編集で本文から @channel を消すと、メンションの件数に数えない', async () => {
      const { alice, dave, workspace, channelId } = await scene();
      const message = await post(alice, workspace.id, channelId, '@channel お知らせです');
      expect(await mentionsOf(dave, workspace.id, channelId)).toBe(1);

      await edit(alice, workspace.id, channelId, message.id, 'お知らせです');

      expect(await mentionsOf(dave, workspace.id, channelId)).toBe(0);
    });
  });

  // 受け取りを待つ期限とタスクをまたぐ問い合わせを待つため、既定の時間切れより長くする。
  describe('@here', { timeout: 30_000 }, () => {
    it('宛先は部屋に入っている参加者（他のタスクを含む。書いた本人を除く）で、受け取りを返した利用者に通知を作る。同じ利用者の開いていないタブが弾いても、開いているタブが返せば受け取ったとする', async () => {
      const { alice, bob, carol, dave, workspace, channelId, sockets } = await scene();
      // carol の別のタブ（チャンネルを開いていない。受け取りを返さずに弾く）
      const carolOtherTab = listen(await t.open(t.firstBase, carol), null);

      const message = await post(alice, workspace.id, channelId, '@here いまいる人へ');

      await vi.waitFor(
        async () => expect([...(await recipientsOf(message.id)).keys()]).toHaveLength(2),
        { timeout: RECORD_WAIT_MS, interval: 100 },
      );
      expect(await recipientsOf(message.id)).toEqual(
        new Map([
          [bob.id, true],
          [carol.id, true],
        ]),
      );
      expect(sockets.bob.notices).toEqual([{ channelId, messageId: message.id }]);
      expect(carolOtherTab.notices).toEqual([{ channelId, messageId: message.id }]);
      expect(sockets.alice.notices).toEqual([]);
      expect(sockets.dave.notices).toEqual([]);
      expect(sockets.dave.messages).toEqual([]);
      expect(sockets.erin.notices).toEqual([]);
      expect(sockets.owner.notices).toEqual([]);
      expect(await mentionsOf(bob, workspace.id, channelId)).toBe(1);
      expect(await mentionsOf(dave, workspace.id, channelId)).toBe(0);
      await vi.waitFor(() =>
        expect(sockets.bob.unread.at(-1)).toMatchObject({ channelId, mentions: 1 }),
      );
    });

    it('受け取りを返さなかった宛先は、送った宛先の一覧にだけ残り、通知（メンションの件数）は作られない', async () => {
      const { alice, bob, carol, workspace, channelId } = await scene();
      // bob の画面はチャンネルを閉じたが、部屋にはまだ入っている（開いていない利用者が弾く）
      t.closeSockets();
      const aliceSocket = await t.open(t.firstBase, alice);
      const bobSocket = await t.open(t.secondBase, bob);
      const carolSocket = await t.open(t.firstBase, carol);
      listen(aliceSocket, channelId);
      const bobView = listen(bobSocket, null);
      listen(carolSocket, channelId);
      for (const socket of [aliceSocket, bobSocket, carolSocket]) await enter(socket, channelId);
      await untilBothSee(channelId, [alice.id, bob.id, carol.id]);
      await quiet();

      const message = await post(alice, workspace.id, channelId, '@here いまいる人へ');

      await vi.waitFor(
        async () => expect([...(await recipientsOf(message.id)).keys()]).toHaveLength(2),
        { timeout: RECORD_WAIT_MS, interval: 100 },
      );
      expect(await recipientsOf(message.id)).toEqual(
        new Map([
          [bob.id, false],
          [carol.id, true],
        ]),
      );
      expect(bobView.notices).toEqual([{ channelId, messageId: message.id }]);
      expect(await mentionsOf(bob, workspace.id, channelId)).toBe(0);
      expect(await mentionsOf(carol, workspace.id, channelId)).toBe(1);
    });

    it('編集で本文から @here を消すと、受け取りの記録は残し、メンションの件数に数えない', async () => {
      const { alice, bob, workspace, channelId } = await scene();
      const message = await post(alice, workspace.id, channelId, '@here いまいる人へ');
      await vi.waitFor(async () => expect(await mentionsOf(bob, workspace.id, channelId)).toBe(1), {
        timeout: RECORD_WAIT_MS,
        interval: 100,
      });

      await edit(alice, workspace.id, channelId, message.id, 'いまいる人へ');

      expect(await mentionsOf(bob, workspace.id, channelId)).toBe(0);
      expect((await recipientsOf(message.id)).get(bob.id)).toBe(true);
    });

    // Valkey を止めるため、この it は最後に置く。
    // 9.2「取り直しに失敗したときは、そのタスクが持っている一覧の全員へ送り、開いていない利用者の側で弾く」・
    // 5.2「在席の一覧に載っていることを資格の根拠にしない」・要件定義書 4.2「失敗を未処理の例外にしない」。
    it('取り直しに失敗したら、そのタスクの一覧の全員（参加者に限る）へ送り、受け取りを返した利用者に通知を作る。例外にしない', async () => {
      const { alice, carol, dave, erin, workspace, channelId, sockets } = await scene();
      const registry = t.first.get(PresenceRegistry);
      // このタスクの一覧が古くなった状態: 部屋を出た dave（開いていないので弾く）と、参加していない erin が載り、carol は載っている
      registry.replace(channelId, [
        { id: 'stale-carol', userId: carol.id },
        { id: 'stale-dave', userId: dave.id },
        { id: 'stale-erin', userId: erin.id },
      ]);
      const rejections: unknown[] = [];
      const onRejection = (reason: unknown) => rejections.push(reason);
      process.on('unhandledRejection', onRejection);
      try {
        await t.valkey.stop();

        const message = await post(alice, workspace.id, channelId, '@here 止まっている間');

        await vi.waitFor(
          async () => expect([...(await recipientsOf(message.id)).keys()]).toHaveLength(2),
          { timeout: RECORD_WAIT_MS, interval: 100 },
        );
        expect(await recipientsOf(message.id)).toEqual(
          new Map([
            [carol.id, true],
            [dave.id, false],
          ]),
        );
        expect(sockets.dave.messages.map((m) => m.id)).toEqual([message.id]);
        expect(sockets.dave.notices).toEqual([{ channelId, messageId: message.id }]);
        await quiet();
        expect(rejections).toEqual([]);
      } finally {
        process.off('unhandledRejection', onRejection);
      }
    });
  });
});
