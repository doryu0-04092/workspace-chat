import 'reflect-metadata';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { REALTIME_REQUESTS, type ReactionChangedPayload, type paths } from '@workspace-chat/shared';
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

type Workspace = paths['/workspaces']['post']['responses'][201]['content']['application/json'];
type MessagesPath = paths['/workspaces/{id}/channels/{channelId}/messages'];
type Message = MessagesPath['post']['responses'][201]['content']['application/json'];
type MessagePage = MessagesPath['get']['responses'][200]['content']['application/json'];
type ReactionsPath =
  paths['/workspaces/{id}/channels/{channelId}/messages/{messageId}/reactions/{emoji}'];
type MessageReactions = ReactionsPath['put']['responses'][200]['content']['application/json'];

const NOT_FOUND = { code: 'not_found', message: '見つかりません' };
const NOT_A_CHANNEL_MEMBER = {
  code: 'not_a_channel_member',
  message: 'このチャンネルの参加者ではありません',
};
const CHANNEL_ARCHIVED = { code: 'channel_archived', message: 'アーカイブ済みのチャンネルです' };
const MISSING_ID = '00000000-0000-7000-8000-000000000000';
/** 1つのメッセージに付けられる絵文字の種類の上限（実装時に決めた値）。 */
const REACTION_KINDS_LIMIT = 50;
/** 付け外しの上限（利用者単位で1分に60回。ルートごと）。 */
const REACTION_LIMIT = 60;

let sequence = 0;
let ipSequence = 0;
function nextIp(): string {
  ipSequence += 1;
  return `2001:db8::e:${ipSequence.toString(16)}`;
}

type LoggedIn = { authorization: string; token: string; id: string; loginId: string };

// 機能一覧 7（F-18）: 絵文字リアクション。要件定義書 4.1 のカウンタ列と reaction:changed。#583。
// CLAUDE.md「必ずテストを書く箇所」: WebSocket が非参加者にイベントを配信しないこと／
// オーナーが、参加していないプライベートチャンネルのメッセージを取得できないこと（リアクションもメッセージの一部として付け外しできない）。
describe('絵文字リアクション（F-18）', () => {
  let postgres: StartedPostgreSqlContainer;
  let valkey: StartedTestContainer;
  let app: INestApplication;
  let base: string;
  let prisma: PrismaService;
  const logger = new CapturingLogger();
  const opened: Socket[] = [];

  async function login(): Promise<LoggedIn> {
    sequence += 1;
    const loginId = `Rct_${Date.now().toString(36)}_${sequence}`;
    const user = await prisma.user.create({
      data: {
        loginId,
        displayName: `付ける人${sequence}`,
        passwordHash: await hashSecret('reaction-password'),
      },
    });
    const res = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': nextIp() },
      body: JSON.stringify({ userId: loginId, password: 'reaction-password' }),
    });
    expect(res.status).toBe(200);
    const { accessToken } = (await res.json()) as { accessToken: string };
    return { authorization: `Bearer ${accessToken}`, token: accessToken, id: user.id, loginId };
  }

  async function workspaceWith(owner: LoggedIn, ...members: LoggedIn[]): Promise<Workspace> {
    const res = await fetch(`${base}/api/workspaces`, {
      method: 'POST',
      headers: { authorization: owner.authorization, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'リアクションの場所' }),
    });
    expect(res.status).toBe(201);
    const workspace = (await res.json()) as Workspace;
    for (const member of members) {
      await prisma.membership.create({
        data: { workspaceId: workspace.id, userId: member.id, role: 'MEMBER' },
      });
    }
    return workspace;
  }

  async function channelRow(
    workspaceId: string,
    visibility: 'PUBLIC' | 'PRIVATE',
    participants: LoggedIn[],
  ): Promise<string> {
    sequence += 1;
    const name = `rct-${sequence}`;
    const channel = await prisma.channel.create({
      data: { workspaceId, name, baseName: name, visibility },
    });
    for (const participant of participants) {
      await prisma.channelMember.create({
        data: { channelId: channel.id, workspaceId, userId: participant.id },
      });
    }
    return channel.id;
  }

  async function archive(channelId: string): Promise<void> {
    const { baseName } = await prisma.channel.findUniqueOrThrow({ where: { id: channelId } });
    await prisma.channel.update({
      where: { id: channelId },
      data: { archivedAt: new Date(), archiveSequence: 1, name: `${baseName}-1` },
    });
  }

  function messagesPath(workspaceId: string, channelId: string): string {
    return `${base}/api/workspaces/${workspaceId}/channels/${channelId}/messages`;
  }

  async function posted(
    by: LoggedIn,
    workspaceId: string,
    channelId: string,
    body: string,
    parentId?: string,
  ): Promise<Message> {
    const path = messagesPath(workspaceId, channelId);
    const res = await fetch(parentId === undefined ? path : `${path}/${parentId}/replies`, {
      method: 'POST',
      headers: { authorization: by.authorization, 'content-type': 'application/json' },
      body: JSON.stringify({ body }),
    });
    expect(res.status).toBe(201);
    return (await res.json()) as Message;
  }

  async function page(by: LoggedIn, workspaceId: string, channelId: string): Promise<Message[]> {
    const res = await fetch(messagesPath(workspaceId, channelId), {
      headers: { authorization: by.authorization },
    });
    expect(res.status).toBe(200);
    return ((await res.json()) as MessagePage).messages;
  }

  function react(
    method: 'PUT' | 'DELETE',
    by: LoggedIn,
    workspaceId: string,
    channelId: string,
    messageId: string,
    emoji: string,
  ): Promise<Response> {
    return fetch(
      `${messagesPath(workspaceId, channelId)}/${messageId}/reactions/${encodeURIComponent(emoji)}`,
      { method, headers: { authorization: by.authorization } },
    );
  }

  async function reacted(
    method: 'PUT' | 'DELETE',
    by: LoggedIn,
    workspaceId: string,
    channelId: string,
    messageId: string,
    emoji: string,
  ): Promise<MessageReactions> {
    const res = await react(method, by, workspaceId, channelId, messageId, emoji);
    expect(res.status).toBe(200);
    return (await res.json()) as MessageReactions;
  }

  function summaryOf(user: LoggedIn) {
    return { id: user.id, userId: user.loginId, displayName: expect.any(String), avatarUrl: null };
  }

  /** 行とカウンタ列が食い違っていないか（カウンタ列の件数は、その絵文字の行の数と一致する）。 */
  async function countersMatchRows(messageId: string): Promise<void> {
    const counters = await prisma.messageReactionCount.findMany({ where: { messageId } });
    const rows = await prisma.messageReaction.groupBy({
      by: ['emoji'],
      where: { messageId },
      _count: { _all: true },
    });
    expect(Object.fromEntries(counters.map(({ emoji, count }) => [emoji, count]))).toEqual(
      Object.fromEntries(rows.map(({ emoji, _count }) => [emoji, _count._all])),
    );
  }

  async function open(user: LoggedIn): Promise<Socket> {
    const { socket, error } = await connectRealtime(base, { token: user.token });
    expect(error).toBeUndefined();
    opened.push(socket);
    return socket;
  }

  function enter(socket: Socket, channelId: string): Promise<unknown> {
    return socket.timeout(3_000).emitWithAck(REALTIME_REQUESTS.channelEnter, { channelId });
  }

  /** オーナーのワークスペースに alice と bob が参加するチャンネルを作り、alice が1件投稿する。carol は所属していて参加していない。 */
  async function postedByAlice(visibility: 'PUBLIC' | 'PRIVATE' = 'PUBLIC') {
    const owner = await login();
    const alice = await login();
    const bob = await login();
    const carol = await login();
    const workspace = await workspaceWith(owner, alice, bob, carol);
    const channelId = await channelRow(workspace.id, visibility, [alice, bob]);
    const message = await posted(alice, workspace.id, channelId, 'リアクションの的');
    return { owner, alice, bob, carol, workspace, channelId, message };
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
    app = await createApp({ logger });
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

  describe('付け外し', () => {
    it('参加者は付けられ、200 とそのメッセージの絵文字ごとの件数と付けた人を返し、投稿・一覧のメッセージにも載せる', async () => {
      const { alice, bob, workspace, channelId, message } = await postedByAlice();
      expect(message.reactions).toEqual([]);

      expect(await reacted('PUT', bob, workspace.id, channelId, message.id, '👍')).toEqual({
        channelId,
        messageId: message.id,
        reactions: [{ emoji: '👍', count: 1, users: [summaryOf(bob)] }],
      });
      await reacted('PUT', alice, workspace.id, channelId, message.id, '🎉');
      const after = await reacted('PUT', alice, workspace.id, channelId, message.id, '👍');

      // 絵文字は初めて付けた順、付けた人は付けた順
      const expected = [
        { emoji: '👍', count: 2, users: [summaryOf(bob), summaryOf(alice)] },
        { emoji: '🎉', count: 1, users: [summaryOf(alice)] },
      ];
      expect(after.reactions).toEqual(expected);
      expect((await page(bob, workspace.id, channelId))[0]?.reactions).toEqual(expected);
      await countersMatchRows(message.id);
    });

    it('同じ人が同じ絵文字を二重に付けても1件のまま（付けていれば何も変えない）', async () => {
      const { bob, workspace, channelId, message } = await postedByAlice();

      await reacted('PUT', bob, workspace.id, channelId, message.id, '👍');
      const again = await reacted('PUT', bob, workspace.id, channelId, message.id, '👍');

      expect(again.reactions).toEqual([{ emoji: '👍', count: 1, users: [summaryOf(bob)] }]);
      expect(await prisma.messageReaction.count({ where: { messageId: message.id } })).toBe(1);
      await countersMatchRows(message.id);
    });

    it('外すと件数を減らし、0 になった絵文字は消える。付けていない絵文字を外しても何も変えない', async () => {
      const { alice, bob, workspace, channelId, message } = await postedByAlice();
      await reacted('PUT', alice, workspace.id, channelId, message.id, '👍');
      await reacted('PUT', bob, workspace.id, channelId, message.id, '👍');

      const once = await reacted('DELETE', bob, workspace.id, channelId, message.id, '👍');
      expect(once.reactions).toEqual([{ emoji: '👍', count: 1, users: [summaryOf(alice)] }]);
      const notMine = await reacted('DELETE', bob, workspace.id, channelId, message.id, '👍');
      expect(notMine.reactions).toEqual(once.reactions);
      const none = await reacted('DELETE', alice, workspace.id, channelId, message.id, '👍');
      expect(none.reactions).toEqual([]);

      expect(await prisma.messageReactionCount.count({ where: { messageId: message.id } })).toBe(0);
      expect((await page(alice, workspace.id, channelId))[0]?.reactions).toEqual([]);
    });

    it('同時に付け外ししても、カウンタ列は行の数と一致する', async () => {
      const owner = await login();
      const people = await Promise.all(Array.from({ length: 8 }, () => login()));
      const workspace = await workspaceWith(owner, ...people);
      const channelId = await channelRow(workspace.id, 'PUBLIC', people);
      const message = await posted(people[0]!, workspace.id, channelId, '同時に付ける');

      await Promise.all(
        people.flatMap((person) => [
          react('PUT', person, workspace.id, channelId, message.id, '👍'),
          react('PUT', person, workspace.id, channelId, message.id, '🎉'),
        ]),
      );
      await Promise.all(
        people
          .slice(0, 3)
          .map((person) => react('DELETE', person, workspace.id, channelId, message.id, '👍')),
      );

      const [counted] = await page(people[0]!, workspace.id, channelId);
      expect(counted?.reactions.map(({ emoji, count }) => [emoji, count]).sort()).toEqual(
        [
          ['👍', 5],
          ['🎉', 8],
        ].sort(),
      );
      await countersMatchRows(message.id);
    });

    it.each(['😀', '👍🏽', '👨‍👩‍👧', '🇯🇵', '❤️'])('絵文字1つ（%s）は付けられる', async (emoji) => {
      const { bob, workspace, channelId, message } = await postedByAlice();
      const { reactions } = await reacted('PUT', bob, workspace.id, channelId, message.id, emoji);
      expect(reactions.map((reaction) => reaction.emoji)).toEqual([emoji]);
    });

    it.each([
      ['文字', 'a'],
      ['絵文字2つ', '😀😀'],
      ['絵文字と文字', '😀a'],
      ['長すぎる', '😀'.repeat(40)],
    ])(
      '絵文字1つでないもの（%s）は 400 validation_failed で断り、書き込まない',
      async (_label, emoji) => {
        const { bob, workspace, channelId, message } = await postedByAlice();

        for (const method of ['PUT', 'DELETE'] as const) {
          const res = await react(method, bob, workspace.id, channelId, message.id, emoji);
          expect(res.status).toBe(400);
          expect(await res.json()).toMatchObject({ code: 'validation_failed' });
        }
        expect(await prisma.messageReaction.count({ where: { messageId: message.id } })).toBe(0);
      },
    );

    it('返信にも付けられ、返信の一覧に載せる', async () => {
      const { alice, bob, workspace, channelId, message } = await postedByAlice();
      const reply = await posted(bob, workspace.id, channelId, '返信', message.id);

      await reacted('PUT', alice, workspace.id, channelId, reply.id, '👀');

      const res = await fetch(`${messagesPath(workspace.id, channelId)}/${message.id}/replies`, {
        headers: { authorization: alice.authorization },
      });
      const { messages } = (await res.json()) as MessagePage;
      expect(messages[0]?.reactions).toEqual([
        { emoji: '👀', count: 1, users: [summaryOf(alice)] },
      ]);
      // 親のリアクションとは別に数える
      expect((await page(alice, workspace.id, channelId))[0]?.reactions).toEqual([]);
    });

    it('付けたメッセージを編集しても、編集の応答にリアクションを載せたまま返す', async () => {
      const { alice, bob, workspace, channelId, message } = await postedByAlice();
      await reacted('PUT', bob, workspace.id, channelId, message.id, '👍');

      const res = await fetch(`${messagesPath(workspace.id, channelId)}/${message.id}`, {
        method: 'PATCH',
        headers: { authorization: alice.authorization, 'content-type': 'application/json' },
        body: JSON.stringify({ body: '直した' }),
      });
      expect(res.status).toBe(200);
      expect(((await res.json()) as Message).reactions).toEqual([
        { emoji: '👍', count: 1, users: [summaryOf(bob)] },
      ]);
    });

    it('退会した利用者は付けた人から外し、件数には残す（行は残る。機能一覧 1.5）', async () => {
      const { alice, bob, workspace, channelId, message } = await postedByAlice();
      await reacted('PUT', alice, workspace.id, channelId, message.id, '👍');
      await reacted('PUT', bob, workspace.id, channelId, message.id, '👍');

      await prisma.user.update({ where: { id: bob.id }, data: { deletedAt: new Date() } });

      expect((await page(alice, workspace.id, channelId))[0]?.reactions).toEqual([
        { emoji: '👍', count: 2, users: [summaryOf(alice)] },
      ]);
    });

    it(`1つのメッセージに付けられる絵文字は ${REACTION_KINDS_LIMIT} 種類までで、超える新しい絵文字は 409 reaction_limit_reached で断る。既にある絵文字には付けられる`, async () => {
      const { alice, bob, workspace, channelId, message } = await postedByAlice();
      // U+1F600〜 の顔の絵文字は、それぞれ RGI_Emoji の1つである
      const emojis = Array.from({ length: REACTION_KINDS_LIMIT + 1 }, (_, i) =>
        String.fromCodePoint(0x1f600 + i),
      );
      for (const emoji of emojis.slice(0, REACTION_KINDS_LIMIT)) {
        await reacted('PUT', alice, workspace.id, channelId, message.id, emoji);
      }

      const over = await react('PUT', bob, workspace.id, channelId, message.id, emojis.at(-1)!);
      expect(over.status).toBe(409);
      expect(await over.json()).toEqual({
        code: 'reaction_limit_reached',
        message: 'このメッセージに付けられる絵文字の種類の上限に達しています',
      });
      expect(await prisma.messageReaction.count({ where: { messageId: message.id } })).toBe(
        REACTION_KINDS_LIMIT,
      );
      await reacted('PUT', bob, workspace.id, channelId, message.id, emojis[0]!);
      await countersMatchRows(message.id);
    }, 60_000);
  });

  describe('断る相手', () => {
    it('所属していなければ、種別によらず付け外しを 404 で断り、書き込まない', async () => {
      for (const visibility of ['PUBLIC', 'PRIVATE'] as const) {
        const { workspace, channelId, message } = await postedByAlice(visibility);
        const outsider = await login();
        for (const method of ['PUT', 'DELETE'] as const) {
          const res = await react(method, outsider, workspace.id, channelId, message.id, '👍');
          expect(res.status).toBe(404);
          expect(await res.json()).toEqual(NOT_FOUND);
        }
        expect(await prisma.messageReaction.count({ where: { messageId: message.id } })).toBe(0);
      }
    });

    it('所属していて参加していなければ、パブリックは 403 not_a_channel_member、プライベートは 404 で断る。オーナーでも同じ', async () => {
      for (const [visibility, status, body] of [
        ['PUBLIC', 403, NOT_A_CHANNEL_MEMBER],
        ['PRIVATE', 404, NOT_FOUND],
      ] as const) {
        const { owner, alice, carol, workspace, channelId, message } =
          await postedByAlice(visibility);
        await reacted('PUT', alice, workspace.id, channelId, message.id, '👍');
        for (const outsider of [carol, owner]) {
          for (const method of ['PUT', 'DELETE'] as const) {
            const res = await react(method, outsider, workspace.id, channelId, message.id, '👍');
            expect(res.status).toBe(status);
            expect(await res.json()).toEqual(body);
          }
        }
        expect(await prisma.messageReaction.count({ where: { messageId: message.id } })).toBe(1);
      }
    });

    it('プライベートの非参加者には、メッセージが無くても有っても同じ 404 を返す（有無を漏らさない）', async () => {
      const { carol, workspace, channelId, message } = await postedByAlice('PRIVATE');

      const existing = await react('PUT', carol, workspace.id, channelId, message.id, '👍');
      const missing = await react('PUT', carol, workspace.id, channelId, MISSING_ID, '👍');

      expect([existing.status, missing.status]).toEqual([404, 404]);
      expect(await existing.json()).toEqual(await missing.json());
    });

    it('無いメッセージ・別のチャンネルのメッセージ・削除済みのメッセージは、付け外しを 404 で断る。削除済みのメッセージのリアクションは返さない', async () => {
      const { alice, bob, workspace, channelId, message } = await postedByAlice();
      const otherChannelId = await channelRow(workspace.id, 'PUBLIC', [alice, bob]);
      const elsewhere = await posted(alice, workspace.id, otherChannelId, '別のチャンネル');
      await reacted('PUT', bob, workspace.id, channelId, message.id, '👍');

      const deleted = await fetch(`${messagesPath(workspace.id, channelId)}/${message.id}`, {
        method: 'DELETE',
        headers: { authorization: alice.authorization },
      });
      expect(deleted.status).toBe(204);

      for (const messageId of [MISSING_ID, elsewhere.id, message.id]) {
        for (const method of ['PUT', 'DELETE'] as const) {
          const res = await react(method, bob, workspace.id, channelId, messageId, '👍');
          expect(res.status).toBe(404);
          expect(await res.json()).toEqual(NOT_FOUND);
        }
      }
      expect((await page(bob, workspace.id, channelId))[0]).toMatchObject({
        deleted: true,
        reactions: [],
      });
      // 行は残す（削除は論理削除。外していない）
      expect(await prisma.messageReaction.count({ where: { messageId: message.id } })).toBe(1);
    });

    it('アーカイブ済みのチャンネルでは、参加者でも付け外しを 409 channel_archived で断り、変えない（機能一覧 3.2）', async () => {
      const { alice, bob, workspace, channelId, message } = await postedByAlice();
      await reacted('PUT', bob, workspace.id, channelId, message.id, '👍');
      await archive(channelId);

      for (const [method, emoji] of [
        ['PUT', '🎉'],
        ['DELETE', '👍'],
      ] as const) {
        const res = await react(method, bob, workspace.id, channelId, message.id, emoji);
        expect(res.status).toBe(409);
        expect(await res.json()).toEqual(CHANNEL_ARCHIVED);
      }
      expect((await page(alice, workspace.id, channelId))[0]?.reactions).toEqual([
        { emoji: '👍', count: 1, users: [summaryOf(bob)] },
      ]);
    });

    it(`付け外しは、同じ利用者で1分に ${REACTION_LIMIT} 回を超えたら 429 で断る。別の利用者は断らない`, async () => {
      const { alice, bob, workspace, channelId, message } = await postedByAlice();

      for (let i = 0; i < REACTION_LIMIT; i += 1) {
        expect((await react('PUT', bob, workspace.id, channelId, message.id, '👍')).status).toBe(
          200,
        );
      }
      const limited = await react('PUT', bob, workspace.id, channelId, message.id, '🎉');
      expect(limited.status).toBe(429);
      expect(
        await prisma.messageReaction.count({ where: { messageId: message.id, emoji: '🎉' } }),
      ).toBe(0);
      expect((await react('PUT', alice, workspace.id, channelId, message.id, '🎉')).status).toBe(
        200,
      );
    }, 60_000);
  });

  describe('配信（reaction:changed）', () => {
    it('付け外しすると、チャンネルの部屋に入っている接続にそのメッセージのリアクションと送信時刻が届き、部屋に入っていない接続（非参加者・入室していない参加者）には届かない', async () => {
      const { alice, bob, carol, workspace, channelId, message } = await postedByAlice();
      const aliceSocket = await open(alice);
      const bobSocket = await open(bob);
      const carolSocket = await open(carol);
      expect(await enter(aliceSocket, channelId)).toMatchObject({ ok: true });
      // 非参加者は入室を断られ、部屋に入らない。
      expect(await enter(carolSocket, channelId)).toMatchObject({ ok: false, status: 403 });

      const added = nextEvent(aliceSocket, 'reaction:changed', 2_000);
      const toBob = nextEvent(bobSocket, 'reaction:changed', 1_000);
      const toCarol = nextEvent(carolSocket, 'reaction:changed', 1_000);
      const response = await reacted('PUT', bob, workspace.id, channelId, message.id, '👍');

      const payload = (await added) as ReactionChangedPayload | undefined;
      expect(payload).toEqual({ ...response, sentAt: expect.any(String) });
      expect(Number.isNaN(Date.parse(payload?.sentAt ?? ''))).toBe(false);
      expect(await toBob).toBeUndefined();
      expect(await toCarol).toBeUndefined();

      const removed = nextEvent(aliceSocket, 'reaction:changed', 2_000);
      await reacted('DELETE', bob, workspace.id, channelId, message.id, '👍');
      expect(await removed).toEqual({
        channelId,
        messageId: message.id,
        reactions: [],
        sentAt: expect.any(String),
      });
    });

    it('プライベートチャンネルの付け外しは、部屋に入れない非参加者（オーナーを含む）に届かない', async () => {
      const { owner, alice, carol, workspace, channelId, message } = await postedByAlice('PRIVATE');
      const aliceSocket = await open(alice);
      const ownerSocket = await open(owner);
      const carolSocket = await open(carol);
      expect(await enter(aliceSocket, channelId)).toMatchObject({ ok: true });
      expect(await enter(ownerSocket, channelId)).toMatchObject({ ok: false, status: 404 });
      expect(await enter(carolSocket, channelId)).toMatchObject({ ok: false, status: 404 });

      const toAlice = nextEvent(aliceSocket, 'reaction:changed', 2_000);
      const toOwner = nextEvent(ownerSocket, 'reaction:changed', 1_000);
      const toCarol = nextEvent(carolSocket, 'reaction:changed', 1_000);
      await reacted('PUT', alice, workspace.id, channelId, message.id, '👍');

      expect(await toAlice).toBeDefined();
      expect(await toOwner).toBeUndefined();
      expect(await toCarol).toBeUndefined();
    });

    it('断った付け外し（非参加者・アーカイブ済み・削除済み）と、何も変えなかった付け外しは配らない', async () => {
      const { alice, bob, carol, workspace, channelId, message } = await postedByAlice();
      const other = await posted(alice, workspace.id, channelId, '消すメッセージ');
      await reacted('PUT', bob, workspace.id, channelId, message.id, '👍');
      const aliceSocket = await open(alice);
      expect(await enter(aliceSocket, channelId)).toMatchObject({ ok: true });

      const received = nextEvent(aliceSocket, 'reaction:changed', 1_000);
      expect((await react('PUT', carol, workspace.id, channelId, message.id, '🎉')).status).toBe(
        403,
      );
      // 付けているものを付ける・付けていないものを外すは、何も変えない
      await reacted('PUT', bob, workspace.id, channelId, message.id, '👍');
      await reacted('DELETE', alice, workspace.id, channelId, message.id, '🎉');
      await fetch(`${messagesPath(workspace.id, channelId)}/${other.id}`, {
        method: 'DELETE',
        headers: { authorization: alice.authorization },
      });
      expect((await react('PUT', bob, workspace.id, channelId, other.id, '🎉')).status).toBe(404);
      expect(await received).toBeUndefined();

      await archive(channelId);
      const afterArchive = nextEvent(aliceSocket, 'reaction:changed', 1_000);
      expect((await react('PUT', alice, workspace.id, channelId, message.id, '🎉')).status).toBe(
        409,
      );
      expect(await afterArchive).toBeUndefined();
    });
  });
});
