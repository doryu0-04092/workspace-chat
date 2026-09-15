import 'reflect-metadata';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { type MessageNewPayload, REALTIME_REQUESTS, type paths } from '@workspace-chat/shared';
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

const NOT_FOUND = { code: 'not_found', message: '見つかりません' };
const TOO_MANY_REQUESTS = {
  code: 'too_many_requests',
  message: '要求が多すぎます。しばらく待ってからやり直してください',
};
const MISSING_ID = '00000000-0000-7000-8000-000000000000';
const LAST_ID = 'ffffffff-ffff-7fff-bfff-ffffffffffff';
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** 投稿・返信・編集・削除の上限（利用者単位で1分に60回。4つのルートで1つの枠。機能一覧 4.1・4.2・6）。 */
const POST_LIMIT = 60;

let sequence = 0;
let ipSequence = 0;
function nextIp(): string {
  ipSequence += 1;
  return `2001:db8::d:${ipSequence.toString(16)}`;
}

type LoggedIn = { authorization: string; token: string; id: string; loginId: string };

// 機能一覧 4.1・4.2（F-11・F-12・F-13）: メッセージの投稿・一覧・編集・削除、5.2 の message:new / message:updated / message:deleted。#371。
// CLAUDE.md「必ずテストを書く箇所」: WebSocket が非参加者にイベントを配信しないこと／
// オーナーが、参加していないプライベートチャンネルのメッセージを取得できないこと／自分以外のメッセージを編集・削除できないこと。
describe('メッセージの投稿・一覧・編集・削除（F-11・F-12・F-13）', () => {
  let postgres: StartedPostgreSqlContainer;
  let valkey: StartedTestContainer;
  let app: INestApplication;
  let base: string;
  let prisma: PrismaService;
  const logger = new CapturingLogger();
  const opened: Socket[] = [];

  async function login(): Promise<LoggedIn> {
    sequence += 1;
    const loginId = `Msg_${Date.now().toString(36)}_${sequence}`;
    const user = await prisma.user.create({
      data: {
        loginId,
        displayName: `投稿する人${sequence}`,
        passwordHash: await hashSecret('message-password'),
      },
    });
    const res = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': nextIp() },
      body: JSON.stringify({ userId: loginId, password: 'message-password' }),
    });
    expect(res.status).toBe(200);
    const { accessToken } = (await res.json()) as { accessToken: string };
    return { authorization: `Bearer ${accessToken}`, token: accessToken, id: user.id, loginId };
  }

  async function workspaceWith(owner: LoggedIn, ...members: LoggedIn[]): Promise<Workspace> {
    const res = await fetch(`${base}/api/workspaces`, {
      method: 'POST',
      headers: { authorization: owner.authorization, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'メッセージの場所' }),
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

  /** API を通さずにチャンネルを作る（参加者の組み合わせ・アーカイブ済みを自由に用意するため）。 */
  async function channelRow(
    workspaceId: string,
    visibility: 'PUBLIC' | 'PRIVATE',
    participants: LoggedIn[],
    archived = false,
  ): Promise<string> {
    sequence += 1;
    const name = `msg-${sequence}`;
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

  function post(
    by: LoggedIn,
    workspaceId: string,
    channelId: string,
    body: unknown,
  ): Promise<Response> {
    return fetch(`${base}/api/workspaces/${workspaceId}/channels/${channelId}/messages`, {
      method: 'POST',
      headers: { authorization: by.authorization, 'content-type': 'application/json' },
      body: JSON.stringify({ body }),
    });
  }

  function list(
    by: LoggedIn,
    workspaceId: string,
    channelId: string,
    query = '',
  ): Promise<Response> {
    return fetch(`${base}/api/workspaces/${workspaceId}/channels/${channelId}/messages${query}`, {
      headers: { authorization: by.authorization },
    });
  }

  async function posted(
    by: LoggedIn,
    workspaceId: string,
    channelId: string,
    body: string,
  ): Promise<Message> {
    const res = await post(by, workspaceId, channelId, body);
    expect(res.status).toBe(201);
    return (await res.json()) as Message;
  }

  async function page(
    by: LoggedIn,
    workspaceId: string,
    channelId: string,
    query = '',
  ): Promise<MessagePage> {
    const res = await list(by, workspaceId, channelId, query);
    expect(res.status).toBe(200);
    return (await res.json()) as MessagePage;
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

  /** トランザクションの中で行を掴んだまま確定しない（channel-archive.test.ts と同じ形）。 */
  async function holdWith(lock: (tx: Pick<PrismaService, 'channel'>) => Promise<unknown>) {
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let markLocked!: () => void;
    const locked = new Promise<void>((resolve) => {
      markLocked = resolve;
    });
    const done = prisma.$transaction(
      async (tx) => {
        await lock(tx);
        markLocked();
        await released;
      },
      { timeout: 10_000 },
    );
    await Promise.race([locked, done]);
    return { release, done };
  }

  async function waitingOnLock(): Promise<number> {
    const [found] = await prisma.$queryRaw<{ waiting: number }[]>`
      SELECT count(*)::int AS "waiting" FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'
    `;
    return found?.waiting ?? 0;
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

  describe('投稿', () => {
    it('参加者は投稿でき、201 と作ったメッセージ（UUIDv7 の id・チャンネル・投稿者・本文・時刻）を返す', async () => {
      const owner = await login();
      const alice = await login();
      const workspace = await workspaceWith(owner, alice);
      const channelId = await channelRow(workspace.id, 'PUBLIC', [alice]);

      const res = await post(alice, workspace.id, channelId, 'こんにちは');

      expect(res.status).toBe(201);
      const message = (await res.json()) as Message;
      expect(message).toEqual({
        id: expect.stringMatching(UUID_V7),
        channelId,
        author: { id: alice.id, userId: alice.loginId, displayName: expect.any(String) },
        body: 'こんにちは',
        createdAt: expect.any(String),
        editedAt: null,
        deleted: false,
        parentId: null,
        replyCount: 0,
        replyParticipants: [],
      });
      expect(Number.isNaN(Date.parse(message.createdAt))).toBe(false);
      expect(await prisma.message.count({ where: { channelId } })).toBe(1);
    });

    it('本文は 1〜4000 文字で、空・空白だけ・4001 文字は 400 validation_failed で断り、書き込まない', async () => {
      const owner = await login();
      const alice = await login();
      const workspace = await workspaceWith(owner, alice);
      const channelId = await channelRow(workspace.id, 'PUBLIC', [alice]);

      for (const body of ['', ' \n\t　', 'あ'.repeat(4001), 42, undefined]) {
        const res = await post(alice, workspace.id, channelId, body);
        expect(res.status).toBe(400);
        expect(await res.json()).toMatchObject({ code: 'validation_failed' });
      }
      expect(await prisma.message.count({ where: { channelId } })).toBe(0);

      expect((await post(alice, workspace.id, channelId, 'あ'.repeat(4000))).status).toBe(201);
    });

    it('所属していなければ、種別によらず 404 で断り、書き込まない', async () => {
      const owner = await login();
      const outsider = await login();
      const workspace = await workspaceWith(owner);
      const publicId = await channelRow(workspace.id, 'PUBLIC', [owner]);
      const privateId = await channelRow(workspace.id, 'PRIVATE', [owner]);

      for (const channelId of [publicId, privateId, MISSING_ID]) {
        const res = await post(outsider, workspace.id, channelId, '外から');
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual(NOT_FOUND);
      }
      expect(await prisma.message.count({ where: { authorId: outsider.id } })).toBe(0);
    });

    it('所属していて参加していなければ、パブリックは 403 not_a_channel_member、プライベートは 404 で断る。オーナーでも同じ', async () => {
      const owner = await login();
      const alice = await login();
      const bob = await login();
      const workspace = await workspaceWith(owner, alice, bob);
      const publicId = await channelRow(workspace.id, 'PUBLIC', [alice]);
      const privateId = await channelRow(workspace.id, 'PRIVATE', [alice]);

      for (const by of [bob, owner]) {
        const publicRes = await post(by, workspace.id, publicId, '入っていない');
        expect(publicRes.status).toBe(403);
        const forbidden = (await publicRes.json()) as { code: string; message: string };
        expect(forbidden.code).toBe('not_a_channel_member');
        expect(forbidden.message).not.toBe(NOT_FOUND.message);

        const privateRes = await post(by, workspace.id, privateId, '入っていない');
        expect(privateRes.status).toBe(404);
        expect(await privateRes.json()).toEqual(NOT_FOUND);
      }
      expect(
        await prisma.message.count({ where: { channelId: { in: [publicId, privateId] } } }),
      ).toBe(0);
    });

    it('別のワークスペースのチャンネルは、そちらに参加していても、パスのワークスペースのものでなければ 404', async () => {
      const owner = await login();
      const alice = await login();
      const here = await workspaceWith(owner, alice);
      const there = await workspaceWith(owner, alice);
      const thereChannel = await channelRow(there.id, 'PUBLIC', [alice]);

      const res = await post(alice, here.id, thereChannel, '別の場所');

      expect(res.status).toBe(404);
      expect(await prisma.message.count({ where: { channelId: thereChannel } })).toBe(0);
    });

    it('アーカイブ済みのチャンネルには、参加者でも 409 channel_archived で投稿できない（機能一覧 3.2）', async () => {
      const owner = await login();
      const alice = await login();
      const workspace = await workspaceWith(owner, alice);
      const channelId = await channelRow(workspace.id, 'PUBLIC', [alice], true);

      const res = await post(alice, workspace.id, channelId, '遅れて');

      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: 'channel_archived' });
      expect(await prisma.message.count({ where: { channelId } })).toBe(0);
    });

    // 機能一覧 3.2: アーカイブ済みかを読んで投稿するかを決める経路は、チャンネルの行を掴んでから読む。
    it('アーカイブの確定の前に届いた投稿は、確定を待ってから読み、409 で断る', async () => {
      const owner = await login();
      const alice = await login();
      const workspace = await workspaceWith(owner, alice);
      const channelId = await channelRow(workspace.id, 'PUBLIC', [alice]);
      const { baseName } = await prisma.channel.findUniqueOrThrow({ where: { id: channelId } });
      const held = await holdWith((tx) =>
        tx.channel.update({
          where: { id: channelId },
          data: { archivedAt: new Date(), archiveSequence: 1, name: `${baseName}-1` },
        }),
      );
      try {
        const pending = post(alice, workspace.id, channelId, '同時に');
        // 投稿が行のロックを待たずに先へ進むと、ここで時間切れになる。
        await vi.waitFor(async () => expect(await waitingOnLock()).toBeGreaterThan(0), {
          timeout: 3_000,
          interval: 50,
        });
        held.release();
        await held.done;

        const res = await pending;
        expect(res.status).toBe(409);
        expect(await prisma.message.count({ where: { channelId } })).toBe(0);
      } finally {
        held.release();
        await held.done.catch(() => undefined);
      }
    });
  });

  describe('一覧', () => {
    it('id の新しい順に返し、limit で件数を絞り、nextBefore で続きを取り、続きが無ければ null を返す', async () => {
      const owner = await login();
      const alice = await login();
      const workspace = await workspaceWith(owner, alice);
      const channelId = await channelRow(workspace.id, 'PUBLIC', [alice]);
      const ids: string[] = [];
      for (let i = 1; i <= 5; i += 1) {
        ids.push((await posted(alice, workspace.id, channelId, `その${i}`)).id);
      }
      const newestFirst = [...ids].sort().reverse();

      const first = await page(alice, workspace.id, channelId, '?limit=2');
      expect(first.messages.map(({ id }) => id)).toEqual(newestFirst.slice(0, 2));
      expect(first.nextBefore).toBe(newestFirst[1]);

      const second = await page(
        alice,
        workspace.id,
        channelId,
        `?limit=2&before=${first.nextBefore}`,
      );
      expect(second.messages.map(({ id }) => id)).toEqual(newestFirst.slice(2, 4));
      expect(second.nextBefore).toBe(newestFirst[3]);

      const last = await page(
        alice,
        workspace.id,
        channelId,
        `?limit=2&before=${second.nextBefore}`,
      );
      expect(last.messages.map(({ id }) => id)).toEqual(newestFirst.slice(4));
      expect(last.nextBefore).toBeNull();

      // 残りがちょうど limit 件なら、続きは無い。
      const exact = await page(alice, workspace.id, channelId, '?limit=5');
      expect(exact.messages).toHaveLength(5);
      expect(exact.nextBefore).toBeNull();
    });

    it('limit を省くと 50 件を返し、続きがあれば nextBefore を返す', async () => {
      const owner = await login();
      const alice = await login();
      const workspace = await workspaceWith(owner, alice);
      const channelId = await channelRow(workspace.id, 'PUBLIC', [alice]);
      await prisma.message.createMany({
        data: Array.from({ length: 51 }, (_, i) => ({
          channelId,
          workspaceId: workspace.id,
          authorId: alice.id,
          body: `まとめて${i}`,
        })),
      });

      const result = await page(alice, workspace.id, channelId);

      expect(result.messages).toHaveLength(50);
      expect(result.nextBefore).toBe(result.messages[49]?.id);
    });

    it('limit が 1〜100 の整数でなければ、before が uuid でなければ 400 validation_failed', async () => {
      const owner = await login();
      const alice = await login();
      const workspace = await workspaceWith(owner, alice);
      const channelId = await channelRow(workspace.id, 'PUBLIC', [alice]);

      for (const query of [
        '?limit=0',
        '?limit=101',
        '?limit=abc',
        '?limit=1.5',
        '?before=not-a-uuid',
      ]) {
        const res = await list(alice, workspace.id, channelId, query);
        expect(res.status).toBe(400);
        expect(await res.json()).toMatchObject({ code: 'validation_failed' });
      }
    });

    it('before は存在を確かめない境目であり、最も小さい id より前は空、最も大きい id より前はすべてを返す', async () => {
      const owner = await login();
      const alice = await login();
      const workspace = await workspaceWith(owner, alice);
      const channelId = await channelRow(workspace.id, 'PUBLIC', [alice]);
      await posted(alice, workspace.id, channelId, 'ひとつめ');
      await posted(alice, workspace.id, channelId, 'ふたつめ');

      expect(await page(alice, workspace.id, channelId, `?before=${MISSING_ID}`)).toEqual({
        messages: [],
        nextBefore: null,
      });
      expect(
        (await page(alice, workspace.id, channelId, `?before=${LAST_ID}`)).messages,
      ).toHaveLength(2);
    });

    it('そのチャンネルのメッセージだけを返す', async () => {
      const owner = await login();
      const alice = await login();
      const workspace = await workspaceWith(owner, alice);
      const here = await channelRow(workspace.id, 'PUBLIC', [alice]);
      const there = await channelRow(workspace.id, 'PUBLIC', [alice]);
      const mine = await posted(alice, workspace.id, here, 'ここ');
      await posted(alice, workspace.id, there, 'よそ');

      expect((await page(alice, workspace.id, here)).messages).toEqual([mine]);
    });

    it('所属していなければ種別によらず 404、所属していて参加していなければパブリックは 403・プライベートは 404', async () => {
      const owner = await login();
      const alice = await login();
      const bob = await login();
      const outsider = await login();
      const workspace = await workspaceWith(owner, alice, bob);
      const publicId = await channelRow(workspace.id, 'PUBLIC', [alice]);
      const privateId = await channelRow(workspace.id, 'PRIVATE', [alice]);
      await posted(alice, workspace.id, publicId, '公開');
      await posted(alice, workspace.id, privateId, '内緒');

      for (const channelId of [publicId, privateId, MISSING_ID]) {
        const res = await list(outsider, workspace.id, channelId);
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual(NOT_FOUND);
      }
      const publicRes = await list(bob, workspace.id, publicId);
      expect(publicRes.status).toBe(403);
      expect(await publicRes.json()).toMatchObject({ code: 'not_a_channel_member' });
      const privateRes = await list(bob, workspace.id, privateId);
      expect(privateRes.status).toBe(404);
      expect(await privateRes.json()).toEqual(NOT_FOUND);
    });

    // CLAUDE.md「必ずテストを書く箇所」: オーナーが、参加していないプライベートチャンネルのメッセージを取得できないこと。
    it('オーナーでも、参加していないプライベートチャンネルのメッセージは 404 で取得できない（パブリックは 403）', async () => {
      const owner = await login();
      const alice = await login();
      const workspace = await workspaceWith(owner, alice);
      const privateId = await channelRow(workspace.id, 'PRIVATE', [alice]);
      const publicId = await channelRow(workspace.id, 'PUBLIC', [alice]);
      await posted(alice, workspace.id, privateId, '内緒');

      const privateRes = await list(owner, workspace.id, privateId);
      expect(privateRes.status).toBe(404);
      expect(await privateRes.json()).toEqual(NOT_FOUND);
      expect((await list(owner, workspace.id, publicId)).status).toBe(403);
    });

    it('アーカイブ済みのチャンネルでも、参加者は読める（機能一覧 3.2）', async () => {
      const owner = await login();
      const alice = await login();
      const workspace = await workspaceWith(owner, alice);
      const channelId = await channelRow(workspace.id, 'PUBLIC', [alice]);
      const before = await posted(alice, workspace.id, channelId, 'アーカイブの前');
      const { baseName } = await prisma.channel.findUniqueOrThrow({ where: { id: channelId } });
      await prisma.channel.update({
        where: { id: channelId },
        data: { archivedAt: new Date(), archiveSequence: 1, name: `${baseName}-1` },
      });

      expect((await page(alice, workspace.id, channelId)).messages).toEqual([before]);
    });

    it('退会した投稿者のメッセージは残り、author を null にして返す（機能一覧 1.5）', async () => {
      const owner = await login();
      const alice = await login();
      const bob = await login();
      const workspace = await workspaceWith(owner, alice, bob);
      const channelId = await channelRow(workspace.id, 'PUBLIC', [alice, bob]);
      const byBob = await posted(bob, workspace.id, channelId, '退会する前');
      await prisma.user.update({ where: { id: bob.id }, data: { deletedAt: new Date() } });

      expect((await page(alice, workspace.id, channelId)).messages).toEqual([
        { ...byBob, author: null },
      ]);
    });
  });

  // 機能一覧 5.2・9.2: チャンネル本体のイベントはチャンネルの部屋へ送る。受け取れるのは部屋に入っている接続だけである。
  describe('配信（message:new）', () => {
    it('投稿すると、チャンネルの部屋に入っている接続にメッセージと送信時刻が届き、部屋に入っていない接続（非参加者・入室していない参加者）には届かない', async () => {
      const owner = await login();
      const alice = await login();
      const bob = await login();
      const carol = await login();
      const workspace = await workspaceWith(owner, alice, bob, carol);
      const channelId = await channelRow(workspace.id, 'PUBLIC', [alice, bob]);
      const aliceSocket = await open(alice);
      const bobSocket = await open(bob);
      const carolSocket = await open(carol);
      expect(await enter(aliceSocket, channelId)).toMatchObject({ ok: true });
      // 非参加者は入室を断られ、部屋に入らない。
      expect(await enter(carolSocket, channelId)).toMatchObject({ ok: false, status: 403 });

      const toAlice = nextEvent(aliceSocket, 'message:new', 2_000);
      const toBob = nextEvent(bobSocket, 'message:new', 1_000);
      const toCarol = nextEvent(carolSocket, 'message:new', 1_000);
      const message = await posted(alice, workspace.id, channelId, '届くか');

      const payload = (await toAlice) as MessageNewPayload | undefined;
      expect(payload).toEqual({ message, sentAt: expect.any(String) });
      expect(Number.isNaN(Date.parse(payload?.sentAt ?? ''))).toBe(false);
      expect(await toBob).toBeUndefined();
      expect(await toCarol).toBeUndefined();
    });

    it('断った投稿（アーカイブ済み・非参加者）は配らない', async () => {
      const owner = await login();
      const alice = await login();
      const bob = await login();
      const workspace = await workspaceWith(owner, alice, bob);
      const archivedId = await channelRow(workspace.id, 'PUBLIC', [alice], true);
      const aliceSocket = await open(alice);
      expect(await enter(aliceSocket, archivedId)).toMatchObject({ ok: true });

      const received = nextEvent(aliceSocket, 'message:new', 1_000);
      expect((await post(alice, workspace.id, archivedId, 'アーカイブ済み')).status).toBe(409);
      expect((await post(bob, workspace.id, archivedId, '非参加者')).status).toBe(403);

      expect(await received).toBeUndefined();
    });
  });

  // 機能一覧 4.2（F-13）: 編集と削除。CLAUDE.md「必ずテストを書く箇所」: 自分以外のメッセージを編集・削除できないこと。
  describe('編集と削除', () => {
    function messagePath(workspaceId: string, channelId: string, messageId: string): string {
      return `${base}/api/workspaces/${workspaceId}/channels/${channelId}/messages/${messageId}`;
    }

    function edit(
      by: LoggedIn,
      workspaceId: string,
      channelId: string,
      messageId: string,
      body: unknown,
    ): Promise<Response> {
      return fetch(messagePath(workspaceId, channelId, messageId), {
        method: 'PATCH',
        headers: { authorization: by.authorization, 'content-type': 'application/json' },
        body: JSON.stringify({ body }),
      });
    }

    function remove(
      by: LoggedIn,
      workspaceId: string,
      channelId: string,
      messageId: string,
    ): Promise<Response> {
      return fetch(messagePath(workspaceId, channelId, messageId), {
        method: 'DELETE',
        headers: { authorization: by.authorization },
      });
    }

    /** オーナーのワークスペースに alice と bob が参加するパブリックチャンネルを作り、alice が1件投稿する。 */
    async function postedByAlice(visibility: 'PUBLIC' | 'PRIVATE' = 'PUBLIC') {
      const owner = await login();
      const alice = await login();
      const bob = await login();
      const carol = await login();
      const workspace = await workspaceWith(owner, alice, bob, carol);
      const channelId = await channelRow(workspace.id, visibility, [alice, bob]);
      const message = await posted(alice, workspace.id, channelId, 'もとの本文');
      return { owner, alice, bob, carol, workspace, channelId, message };
    }

    async function archive(channelId: string): Promise<void> {
      const { baseName } = await prisma.channel.findUniqueOrThrow({ where: { id: channelId } });
      await prisma.channel.update({
        where: { id: channelId },
        data: { archivedAt: new Date(), archiveSequence: 1, name: `${baseName}-1` },
      });
    }

    it('作者は編集でき、200 と編集後のメッセージ（本文と editedAt）を返し、一覧にも反映する', async () => {
      const { alice, workspace, channelId, message } = await postedByAlice();

      const res = await edit(alice, workspace.id, channelId, message.id, '直した本文');

      expect(res.status).toBe(200);
      const edited = (await res.json()) as Message;
      expect(edited).toEqual({
        ...message,
        body: '直した本文',
        editedAt: expect.any(String),
      });
      expect(Number.isNaN(Date.parse(edited.editedAt ?? ''))).toBe(false);
      expect((await page(alice, workspace.id, channelId)).messages).toEqual([edited]);
    });

    it('編集の本文の形は投稿と同じで、空白だけ・4001 文字は 400 validation_failed で断り、本文を変えない', async () => {
      const { alice, workspace, channelId, message } = await postedByAlice();

      for (const body of [' \n', 'あ'.repeat(4001)]) {
        const res = await edit(alice, workspace.id, channelId, message.id, body);
        expect(res.status).toBe(400);
        expect(await res.json()).toMatchObject({ code: 'validation_failed' });
      }
      expect((await page(alice, workspace.id, channelId)).messages).toEqual([message]);
    });

    it('作者でなければ、同じチャンネルの参加者でもオーナーでも、編集・削除を 403 not_message_author で断り、変えない', async () => {
      const { owner, alice, bob, workspace, channelId, message } = await postedByAlice();
      await prisma.channelMember.create({
        data: { channelId, workspaceId: workspace.id, userId: owner.id },
      });

      for (const by of [bob, owner]) {
        const edited = await edit(by, workspace.id, channelId, message.id, '乗っ取り');
        expect(edited.status).toBe(403);
        expect(await edited.json()).toMatchObject({ code: 'not_message_author' });
        const removed = await remove(by, workspace.id, channelId, message.id);
        expect(removed.status).toBe(403);
        expect(await removed.json()).toMatchObject({ code: 'not_message_author' });
      }
      expect((await page(alice, workspace.id, channelId)).messages).toEqual([message]);
    });

    // CLAUDE.md「必ずテストを書く箇所」: オーナーが、参加していないプライベートチャンネルのメッセージを取得できないこと
    // （編集の応答は本文を返す）。オーナーの例外はメッセージに及ばない（機能一覧 3.1・4.1）。
    it('参加していないオーナーも、編集・削除はパブリックは 403 not_a_channel_member・プライベートは 404 で断る', async () => {
      const publicCase = await postedByAlice('PUBLIC');
      const privateCase = await postedByAlice('PRIVATE');

      for (const res of [
        await edit(
          publicCase.owner,
          publicCase.workspace.id,
          publicCase.channelId,
          publicCase.message.id,
          'オーナー',
        ),
        await remove(
          publicCase.owner,
          publicCase.workspace.id,
          publicCase.channelId,
          publicCase.message.id,
        ),
      ]) {
        expect(res.status).toBe(403);
        expect(await res.json()).toMatchObject({ code: 'not_a_channel_member' });
      }
      for (const res of [
        await edit(
          privateCase.owner,
          privateCase.workspace.id,
          privateCase.channelId,
          privateCase.message.id,
          'オーナー',
        ),
        await remove(
          privateCase.owner,
          privateCase.workspace.id,
          privateCase.channelId,
          privateCase.message.id,
        ),
      ]) {
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual(NOT_FOUND);
      }
      expect(
        (await page(privateCase.alice, privateCase.workspace.id, privateCase.channelId)).messages,
      ).toEqual([privateCase.message]);
    });

    it('参加の判定は作者の判定より先で、所属していなければ 404、パブリックの非参加者は 403 not_a_channel_member、プライベートの非参加者は 404', async () => {
      const outsider = await login();
      const publicCase = await postedByAlice('PUBLIC');
      const privateCase = await postedByAlice('PRIVATE');

      for (const { workspace, channelId, message } of [publicCase, privateCase]) {
        for (const res of [
          await edit(outsider, workspace.id, channelId, message.id, '外から'),
          await remove(outsider, workspace.id, channelId, message.id),
        ]) {
          expect(res.status).toBe(404);
          expect(await res.json()).toEqual(NOT_FOUND);
        }
      }
      const { carol: publicCarol } = publicCase;
      for (const res of [
        await edit(
          publicCarol,
          publicCase.workspace.id,
          publicCase.channelId,
          publicCase.message.id,
          'x',
        ),
        await remove(
          publicCarol,
          publicCase.workspace.id,
          publicCase.channelId,
          publicCase.message.id,
        ),
      ]) {
        expect(res.status).toBe(403);
        expect(await res.json()).toMatchObject({ code: 'not_a_channel_member' });
      }
      const { carol: privateCarol } = privateCase;
      for (const res of [
        await edit(
          privateCarol,
          privateCase.workspace.id,
          privateCase.channelId,
          privateCase.message.id,
          'x',
        ),
        await remove(
          privateCarol,
          privateCase.workspace.id,
          privateCase.channelId,
          privateCase.message.id,
        ),
      ]) {
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual(NOT_FOUND);
      }
    });

    it('無いメッセージ・別のチャンネルのメッセージは、作者でも 404', async () => {
      const { alice, workspace, channelId, message } = await postedByAlice();
      const otherChannel = await channelRow(workspace.id, 'PUBLIC', [alice]);

      for (const [target, id] of [
        [channelId, MISSING_ID],
        [otherChannel, message.id],
      ] as const) {
        const edited = await edit(alice, workspace.id, target, id, 'どこにも無い');
        expect(edited.status).toBe(404);
        expect(await edited.json()).toEqual(NOT_FOUND);
        expect((await remove(alice, workspace.id, target, id)).status).toBe(404);
      }
    });

    it('作者は削除でき 204 を返す。一覧には削除済みとして残り（body: null・deleted: true）、本文は DB に残る', async () => {
      const { alice, workspace, channelId, message } = await postedByAlice();

      const res = await remove(alice, workspace.id, channelId, message.id);

      expect(res.status).toBe(204);
      expect((await page(alice, workspace.id, channelId)).messages).toEqual([
        { ...message, body: null, deleted: true },
      ]);
      const row = await prisma.message.findUniqueOrThrow({ where: { id: message.id } });
      expect(row.body).toBe('もとの本文');
      expect(row.deletedAt).not.toBeNull();
    });

    it('削除済みのメッセージは、編集も2回目の削除も 404', async () => {
      const { alice, workspace, channelId, message } = await postedByAlice();
      expect((await remove(alice, workspace.id, channelId, message.id)).status).toBe(204);

      expect((await edit(alice, workspace.id, channelId, message.id, '削除の後')).status).toBe(404);
      expect((await remove(alice, workspace.id, channelId, message.id)).status).toBe(404);
      const row = await prisma.message.findUniqueOrThrow({ where: { id: message.id } });
      expect(row.body).toBe('もとの本文');
    });

    it('アーカイブ済みのチャンネルでは、作者でも編集・削除を 409 channel_archived で断る（機能一覧 3.2）', async () => {
      const { alice, workspace, channelId, message } = await postedByAlice();
      await archive(channelId);

      const edited = await edit(alice, workspace.id, channelId, message.id, 'アーカイブの後');
      expect(edited.status).toBe(409);
      expect(await edited.json()).toMatchObject({ code: 'channel_archived' });
      const removed = await remove(alice, workspace.id, channelId, message.id);
      expect(removed.status).toBe(409);
      expect((await page(alice, workspace.id, channelId)).messages).toEqual([message]);
    });

    // 機能一覧 3.2: アーカイブ済みかを読んで書くかを決める経路は、チャンネルの行を掴んでから読む。
    it('アーカイブの確定の前に届いた編集は、確定を待ってから読み、409 で断る', async () => {
      const { alice, workspace, channelId, message } = await postedByAlice();
      const { baseName } = await prisma.channel.findUniqueOrThrow({ where: { id: channelId } });
      const held = await holdWith((tx) =>
        tx.channel.update({
          where: { id: channelId },
          data: { archivedAt: new Date(), archiveSequence: 1, name: `${baseName}-1` },
        }),
      );
      try {
        const pending = edit(alice, workspace.id, channelId, message.id, '同時に');
        await vi.waitFor(async () => expect(await waitingOnLock()).toBeGreaterThan(0), {
          timeout: 3_000,
          interval: 50,
        });
        held.release();
        await held.done;

        expect((await pending).status).toBe(409);
      } finally {
        held.release();
        await held.done.catch(() => undefined);
      }
    });

    it('編集は message:updated（編集後のメッセージ）、削除は message:deleted（本文を載せない）として、チャンネルの部屋に入っている接続にだけ届く', async () => {
      const { alice, bob, carol, workspace, channelId, message } = await postedByAlice();
      const bobSocket = await open(bob);
      const carolSocket = await open(carol);
      expect(await enter(bobSocket, channelId)).toMatchObject({ ok: true });
      expect(await enter(carolSocket, channelId)).toMatchObject({ ok: false, status: 403 });

      const updatedToBob = nextEvent(bobSocket, 'message:updated', 2_000);
      const updatedToCarol = nextEvent(carolSocket, 'message:updated', 1_000);
      const editRes = await edit(alice, workspace.id, channelId, message.id, '配る本文');
      const edited = (await editRes.json()) as Message;
      expect(await updatedToBob).toEqual({ message: edited, sentAt: expect.any(String) });
      expect(await updatedToCarol).toBeUndefined();

      const deletedToBob = nextEvent(bobSocket, 'message:deleted', 2_000);
      const deletedToCarol = nextEvent(carolSocket, 'message:deleted', 1_000);
      expect((await remove(alice, workspace.id, channelId, message.id)).status).toBe(204);
      expect(await deletedToBob).toEqual({
        channelId,
        messageId: message.id,
        sentAt: expect.any(String),
      });
      expect(await deletedToCarol).toBeUndefined();
    });

    it('断った編集・削除（作者でない・アーカイブ済み）は配らない', async () => {
      const { alice, bob, workspace, channelId, message } = await postedByAlice();
      const bobSocket = await open(bob);
      expect(await enter(bobSocket, channelId)).toMatchObject({ ok: true });

      const updated = nextEvent(bobSocket, 'message:updated', 3_000);
      const deleted = nextEvent(bobSocket, 'message:deleted', 3_000);
      expect((await edit(bob, workspace.id, channelId, message.id, '他人の')).status).toBe(403);
      expect((await remove(bob, workspace.id, channelId, message.id)).status).toBe(403);

      // アーカイブ済みでは、作者でも 409 で断る。部屋に入っている接続はアーカイブの後も残る。
      await archive(channelId);
      expect((await edit(alice, workspace.id, channelId, message.id, '作者の')).status).toBe(409);
      expect((await remove(alice, workspace.id, channelId, message.id)).status).toBe(409);

      expect(await updated).toBeUndefined();
      expect(await deleted).toBeUndefined();
    });

    // #384: 投稿・編集・削除は1つの枠を分け合う（提案・承認済・2026-09-13・依頼側）。返信も同じ枠に入れ、4つのルートで1つの枠にする（機能一覧 6 の実装時に決めた値）。
    // 返信のルートが同じ枠に入ることは、スレッドの節の「返信も、投稿・編集・削除と同じ枠で数え…」が確かめる。
    it('投稿・編集・削除は、同じ利用者で合わせて1分に60回を超えたら、どれも 429 で断る。別の利用者は断らない', async () => {
      // 最初の投稿（postedByAlice）も同じ枠を1回使う。
      const { alice, bob, workspace, channelId, message } = await postedByAlice();
      let used = 1;
      for (; used < 20; used += 1) {
        expect((await post(alice, workspace.id, channelId, `投稿${used}`)).status).toBe(201);
      }
      for (; used < 40; used += 1) {
        expect((await edit(alice, workspace.id, channelId, message.id, `直し${used}`)).status).toBe(
          200,
        );
      }
      for (; used < POST_LIMIT; used += 1) {
        // 無いメッセージの削除も 404 として数える（ガードはサービスより前に数える）。
        expect((await remove(alice, workspace.id, channelId, MISSING_ID)).status).toBe(404);
      }

      expect((await post(alice, workspace.id, channelId, '多すぎる')).status).toBe(429);
      expect((await edit(alice, workspace.id, channelId, message.id, '多すぎる')).status).toBe(429);
      expect((await remove(alice, workspace.id, channelId, message.id)).status).toBe(429);

      // 利用者で数えるため、別の利用者は断らない。
      expect((await post(bob, workspace.id, channelId, '別の人')).status).toBe(201);
    });
  });

  // 機能一覧 6（F-17）: スレッド。CLAUDE.md「必ずテストを書く箇所」（返信も同じ）: WebSocket が非参加者にイベントを配信しないこと／
  // オーナーが、参加していないプライベートチャンネルのメッセージを取得できないこと／自分以外のメッセージを編集・削除できないこと。
  describe('スレッド（F-17）', () => {
    function messagePath(workspaceId: string, channelId: string, messageId: string): string {
      return `${base}/api/workspaces/${workspaceId}/channels/${channelId}/messages/${messageId}`;
    }

    function reply(
      by: LoggedIn,
      workspaceId: string,
      channelId: string,
      messageId: string,
      body: unknown,
    ): Promise<Response> {
      return fetch(`${messagePath(workspaceId, channelId, messageId)}/replies`, {
        method: 'POST',
        headers: { authorization: by.authorization, 'content-type': 'application/json' },
        body: JSON.stringify({ body }),
      });
    }

    function replies(
      by: LoggedIn,
      workspaceId: string,
      channelId: string,
      messageId: string,
      query = '',
    ): Promise<Response> {
      return fetch(`${messagePath(workspaceId, channelId, messageId)}/replies${query}`, {
        headers: { authorization: by.authorization },
      });
    }

    async function replied(
      by: LoggedIn,
      workspaceId: string,
      channelId: string,
      messageId: string,
      body: string,
    ): Promise<Message> {
      const res = await reply(by, workspaceId, channelId, messageId, body);
      expect(res.status).toBe(201);
      return (await res.json()) as Message;
    }

    async function replyPage(
      by: LoggedIn,
      workspaceId: string,
      channelId: string,
      messageId: string,
      query = '',
    ): Promise<MessagePage> {
      const res = await replies(by, workspaceId, channelId, messageId, query);
      expect(res.status).toBe(200);
      return (await res.json()) as MessagePage;
    }

    function editMessage(
      by: LoggedIn,
      workspaceId: string,
      channelId: string,
      messageId: string,
      body: unknown,
    ): Promise<Response> {
      return fetch(messagePath(workspaceId, channelId, messageId), {
        method: 'PATCH',
        headers: { authorization: by.authorization, 'content-type': 'application/json' },
        body: JSON.stringify({ body }),
      });
    }

    function removeMessage(
      by: LoggedIn,
      workspaceId: string,
      channelId: string,
      messageId: string,
    ): Promise<Response> {
      return fetch(messagePath(workspaceId, channelId, messageId), {
        method: 'DELETE',
        headers: { authorization: by.authorization },
      });
    }

    async function replyCountOf(messageId: string): Promise<number> {
      return (await prisma.message.findUniqueOrThrow({ where: { id: messageId } })).replyCount;
    }

    /** オーナーのワークスペースに alice と bob が参加するチャンネルを作り、alice が親を1件投稿する（carol は所属だけ）。 */
    async function thread(visibility: 'PUBLIC' | 'PRIVATE' = 'PUBLIC') {
      const owner = await login();
      const alice = await login();
      const bob = await login();
      const carol = await login();
      const workspace = await workspaceWith(owner, alice, bob, carol);
      const channelId = await channelRow(workspace.id, visibility, [alice, bob]);
      const parent = await posted(alice, workspace.id, channelId, '親のメッセージ');
      return { owner, alice, bob, carol, workspace, channelId, parent };
    }

    /** 応答の `UserSummary` の形（表示名は login が連番で作る）。 */
    function summaryOf(user: LoggedIn) {
      return { id: user.id, userId: user.loginId, displayName: expect.any(String) };
    }

    it('親の replyParticipants は、削除されていない返信を書いた退会していない利用者を、最後に返信した順に最大3人返す。返信は空', async () => {
      const { owner, alice, bob, carol, workspace, channelId, parent } = await thread();
      const dave = await login();
      await prisma.membership.create({
        data: { workspaceId: workspace.id, userId: dave.id, role: 'MEMBER' },
      });
      for (const member of [carol, owner, dave]) {
        await prisma.channelMember.create({
          data: { channelId, workspaceId: workspace.id, userId: member.id },
        });
      }
      await replied(alice, workspace.id, channelId, parent.id, 'alice の最初の返信');
      await replied(bob, workspace.id, channelId, parent.id, 'bob の最初の返信');
      await replied(carol, workspace.id, channelId, parent.id, 'carol の返信');
      const removed = await replied(alice, workspace.id, channelId, parent.id, '消す返信');
      await replied(owner, workspace.id, channelId, parent.id, 'owner の返信');
      await replied(bob, workspace.id, channelId, parent.id, 'bob の2つ目の返信');
      await replied(dave, workspace.id, channelId, parent.id, '退会する人の返信');
      expect((await removeMessage(alice, workspace.id, channelId, removed.id)).status).toBe(204);
      await prisma.user.update({ where: { id: dave.id }, data: { deletedAt: new Date() } });

      const { messages } = await page(bob, workspace.id, channelId);

      // 削除されていない最後の返信の新しい順は dave（退会）・bob・owner・carol・alice（削除した返信を除くと、最初の返信が最後）。
      // 退会した dave を除くと alice は4人目になり、上限で外れる。
      expect(messages).toHaveLength(1);
      expect(messages[0]?.replyParticipants).toEqual([
        summaryOf(bob),
        summaryOf(owner),
        summaryOf(carol),
      ]);
      const { messages: threadReplies } = await replyPage(bob, workspace.id, channelId, parent.id);
      expect(threadReplies.map(({ replyParticipants }) => replyParticipants)).toEqual(
        threadReplies.map(() => []),
      );
    });

    it('参加者は返信でき、201 と返信（parentId を持ち replyCount は 0）を返し、親の replyCount を1つ増やす。チャンネルの一覧には返信を混ぜない', async () => {
      const { alice, bob, workspace, channelId, parent } = await thread();
      expect(parent).toMatchObject({ parentId: null, replyCount: 0 });

      const res = await reply(bob, workspace.id, channelId, parent.id, '返信');

      expect(res.status).toBe(201);
      expect(await res.json()).toEqual({
        id: expect.stringMatching(UUID_V7),
        channelId,
        author: { id: bob.id, userId: bob.loginId, displayName: expect.any(String) },
        body: '返信',
        createdAt: expect.any(String),
        editedAt: null,
        deleted: false,
        parentId: parent.id,
        replyCount: 0,
        replyParticipants: [],
      });
      const { messages } = await page(alice, workspace.id, channelId);
      expect(messages).toEqual([{ ...parent, replyCount: 1, replyParticipants: [summaryOf(bob)] }]);
    });

    it('返信の一覧は、そのスレッドの返信だけを新しい順に返し、limit で件数を絞り、nextBefore で続きを取る', async () => {
      const { alice, bob, workspace, channelId, parent } = await thread();
      const other = await posted(alice, workspace.id, channelId, '別の親');
      await replied(alice, workspace.id, channelId, other.id, '別のスレッドの返信');
      const first = await replied(bob, workspace.id, channelId, parent.id, '1');
      const second = await replied(alice, workspace.id, channelId, parent.id, '2');
      const third = await replied(bob, workspace.id, channelId, parent.id, '3');

      const head = await replyPage(alice, workspace.id, channelId, parent.id, '?limit=2');
      expect(head).toEqual({ messages: [third, second], nextBefore: second.id });
      const rest = await replyPage(
        alice,
        workspace.id,
        channelId,
        parent.id,
        `?limit=2&before=${second.id}`,
      );
      expect(rest).toEqual({ messages: [first], nextBefore: null });
    });

    it('返信に返信はできず 404 で断り、書き込まない。返信のスレッドの一覧も 404', async () => {
      const { alice, bob, workspace, channelId, parent } = await thread();
      const child = await replied(bob, workspace.id, channelId, parent.id, '返信');

      const res = await reply(alice, workspace.id, channelId, child.id, '返信への返信');

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual(NOT_FOUND);
      expect((await replies(alice, workspace.id, channelId, child.id)).status).toBe(404);
      expect(await prisma.message.count({ where: { parentId: child.id } })).toBe(0);
      expect(await replyCountOf(parent.id)).toBe(1);
      expect(await replyCountOf(child.id)).toBe(0);
    });

    it('無いメッセージ・別のチャンネルのメッセージ・削除済みのメッセージへの返信は 404。削除済みの親の返信は残り、一覧で読める', async () => {
      const { alice, bob, workspace, channelId, parent } = await thread();
      const otherChannelId = await channelRow(workspace.id, 'PUBLIC', [alice, bob]);
      const elsewhere = await posted(alice, workspace.id, otherChannelId, '別のチャンネル');
      const kept = await replied(bob, workspace.id, channelId, parent.id, '残る返信');
      expect((await removeMessage(alice, workspace.id, channelId, parent.id)).status).toBe(204);

      for (const messageId of [MISSING_ID, elsewhere.id, parent.id]) {
        const res = await reply(bob, workspace.id, channelId, messageId, '届かない返信');
        expect(res.status, messageId).toBe(404);
        expect(await res.json()).toEqual(NOT_FOUND);
      }
      for (const messageId of [MISSING_ID, elsewhere.id]) {
        expect((await replies(bob, workspace.id, channelId, messageId)).status, messageId).toBe(
          404,
        );
      }
      expect(await prisma.message.count({ where: { channelId, parentId: { not: null } } })).toBe(1);

      // 親を削除しても、返信は残り読める（機能一覧 4.2）。親は削除済みとして一覧に残り、返信件数も残る。
      expect(await replyPage(bob, workspace.id, channelId, parent.id)).toEqual({
        messages: [kept],
        nextBefore: null,
      });
      const { messages } = await page(bob, workspace.id, channelId);
      expect(messages).toEqual([
        {
          ...parent,
          body: null,
          deleted: true,
          replyCount: 1,
          replyParticipants: [summaryOf(bob)],
        },
      ]);
    });

    it('所属していなければ種別によらず 404、所属していて参加していなければパブリックは 403・プライベートは 404 で、返信も返信の一覧も断る。オーナーでも同じ', async () => {
      const outsider = await login();
      for (const visibility of ['PUBLIC', 'PRIVATE'] as const) {
        const { owner, carol, workspace, channelId, parent } = await thread(visibility);
        for (const who of [outsider, carol, owner]) {
          const label = `${visibility} ${who === outsider ? 'outsider' : who === owner ? 'owner' : 'member'}`;
          const expected = who === outsider || visibility === 'PRIVATE' ? 404 : 403;

          const posting = await reply(who, workspace.id, channelId, parent.id, '参加していない');
          expect(posting.status, label).toBe(expected);
          const listing = await replies(who, workspace.id, channelId, parent.id);
          expect(listing.status, label).toBe(expected);
          if (expected === 404) expect(await listing.json(), label).toEqual(NOT_FOUND);
          else expect(await listing.json(), label).toMatchObject({ code: 'not_a_channel_member' });
        }
        expect(await replyCountOf(parent.id)).toBe(0);
      }
    });

    it('アーカイブ済みのチャンネルでは、返信を 409 channel_archived で断り、返信の一覧は参加者が読める（機能一覧 3.2）', async () => {
      const { alice, bob, workspace, channelId, parent } = await thread();
      const kept = await replied(bob, workspace.id, channelId, parent.id, 'アーカイブの前');
      const { baseName } = await prisma.channel.findUniqueOrThrow({ where: { id: channelId } });
      await prisma.channel.update({
        where: { id: channelId },
        data: { archivedAt: new Date(), archiveSequence: 1, name: `${baseName}-1` },
      });

      const res = await reply(alice, workspace.id, channelId, parent.id, 'アーカイブの後');

      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: 'channel_archived' });
      expect(await replyPage(alice, workspace.id, channelId, parent.id)).toEqual({
        messages: [kept],
        nextBefore: null,
      });
      expect(await replyCountOf(parent.id)).toBe(1);
    });

    it('本文の形は投稿と同じで、空白だけ・4001 文字は 400 validation_failed で断り、件数を変えない', async () => {
      const { bob, workspace, channelId, parent } = await thread();

      for (const body of ['   ', 'あ'.repeat(4001)]) {
        const res = await reply(bob, workspace.id, channelId, parent.id, body);
        expect(res.status).toBe(400);
        expect(await res.json()).toMatchObject({ code: 'validation_failed' });
      }
      expect(await replyCountOf(parent.id)).toBe(0);
    });

    it('返信を削除すると親の replyCount を1つ減らし、同じ返信の2回目の削除は 404 で減らさない。返信の編集は件数を変えない', async () => {
      const { alice, bob, workspace, channelId, parent } = await thread();
      const one = await replied(bob, workspace.id, channelId, parent.id, '1');
      const two = await replied(alice, workspace.id, channelId, parent.id, '2');
      expect(await replyCountOf(parent.id)).toBe(2);

      expect((await editMessage(bob, workspace.id, channelId, one.id, '直した')).status).toBe(200);
      expect(await replyCountOf(parent.id)).toBe(2);
      expect((await removeMessage(bob, workspace.id, channelId, one.id)).status).toBe(204);
      expect(await replyCountOf(parent.id)).toBe(1);
      expect((await removeMessage(bob, workspace.id, channelId, one.id)).status).toBe(404);
      expect(await replyCountOf(parent.id)).toBe(1);

      // 削除した返信は、返信の一覧に削除済みとして残る（チャンネルの一覧と同じ。機能一覧 4.2）。
      const { messages } = await replyPage(alice, workspace.id, channelId, parent.id);
      expect(messages.map(({ id, deleted }) => [id, deleted])).toEqual([
        [two.id, false],
        [one.id, true],
      ]);
    });

    it('作者でなければ、親の作者でもオーナーでも、返信の編集・削除を 403 not_message_author で断り、件数を変えない', async () => {
      const { owner, alice, bob, workspace, channelId, parent } = await thread();
      await prisma.channelMember.create({
        data: { channelId, workspaceId: workspace.id, userId: owner.id },
      });
      const child = await replied(bob, workspace.id, channelId, parent.id, '返信');

      for (const who of [alice, owner]) {
        const edited = await editMessage(who, workspace.id, channelId, child.id, '他人が直す');
        expect(edited.status).toBe(403);
        expect(await edited.json()).toMatchObject({ code: 'not_message_author' });
        const removed = await removeMessage(who, workspace.id, channelId, child.id);
        expect(removed.status).toBe(403);
        expect(await removed.json()).toMatchObject({ code: 'not_message_author' });
      }
      expect(await prisma.message.findUniqueOrThrow({ where: { id: child.id } })).toMatchObject({
        body: '返信',
        editedAt: null,
        deletedAt: null,
      });
      expect(await replyCountOf(parent.id)).toBe(1);
    });

    it('同時に届いた返信を取りこぼさずに数える（replyCount は削除されていない返信の件数と一致する）', async () => {
      const { alice, bob, workspace, channelId, parent } = await thread();

      const results = await Promise.all(
        Array.from({ length: 10 }, (_, index) =>
          reply(index % 2 === 0 ? alice : bob, workspace.id, channelId, parent.id, `同時${index}`),
        ),
      );

      expect(results.map(({ status }) => status)).toEqual(Array.from({ length: 10 }, () => 201));
      expect(await replyCountOf(parent.id)).toBe(10);
      expect(await prisma.message.count({ where: { parentId: parent.id, deletedAt: null } })).toBe(
        10,
      );
    });

    it('返信は message:new（parentId を持つ）、件数が変わった親は message:updated として、チャンネルの部屋に入っている接続にだけ届く。削除は message:deleted と親の message:updated', async () => {
      const { alice, bob, carol, workspace, channelId, parent } = await thread();
      const aliceSocket = await open(alice);
      const carolSocket = await open(carol);
      expect(await enter(aliceSocket, channelId)).toMatchObject({ ok: true });
      // 非参加者は入室を断られ、部屋に入らない。
      expect(await enter(carolSocket, channelId)).toMatchObject({ ok: false, status: 403 });

      const newToAlice = nextEvent(aliceSocket, 'message:new', 2_000);
      const updatedToAlice = nextEvent(aliceSocket, 'message:updated', 2_000);
      const newToCarol = nextEvent(carolSocket, 'message:new', 1_000);
      const updatedToCarol = nextEvent(carolSocket, 'message:updated', 1_000);
      const child = await replied(bob, workspace.id, channelId, parent.id, '配る返信');

      expect(await newToAlice).toEqual({ message: child, sentAt: expect.any(String) });
      expect(await updatedToAlice).toEqual({
        message: { ...parent, replyCount: 1, replyParticipants: [summaryOf(bob)] },
        sentAt: expect.any(String),
      });
      expect(await newToCarol).toBeUndefined();
      expect(await updatedToCarol).toBeUndefined();

      const deletedToAlice = nextEvent(aliceSocket, 'message:deleted', 2_000);
      const decrementedToAlice = nextEvent(aliceSocket, 'message:updated', 2_000);
      const deletedToCarol = nextEvent(carolSocket, 'message:deleted', 1_000);
      expect((await removeMessage(bob, workspace.id, channelId, child.id)).status).toBe(204);

      expect(await deletedToAlice).toEqual({
        channelId,
        messageId: child.id,
        sentAt: expect.any(String),
      });
      expect(await decrementedToAlice).toEqual({
        message: { ...parent, replyCount: 0 },
        sentAt: expect.any(String),
      });
      expect(await deletedToCarol).toBeUndefined();
    });

    it('断った返信（返信への返信・アーカイブ済み・非参加者）は配らない', async () => {
      const { alice, bob, carol, workspace, channelId, parent } = await thread();
      const child = await replied(bob, workspace.id, channelId, parent.id, '返信');
      const aliceSocket = await open(alice);
      expect(await enter(aliceSocket, channelId)).toMatchObject({ ok: true });

      const received = nextEvent(aliceSocket, 'message:new', 1_000);
      const updated = nextEvent(aliceSocket, 'message:updated', 1_000);
      expect((await reply(alice, workspace.id, channelId, child.id, '返信への返信')).status).toBe(
        404,
      );
      expect((await reply(carol, workspace.id, channelId, parent.id, '非参加者')).status).toBe(403);

      expect(await received).toBeUndefined();
      expect(await updated).toBeUndefined();
    });

    it('返信も、投稿・編集・削除と同じ枠で数え、同じ利用者で合わせて1分に60回を超えたら 429 で断り、件数を変えない', async () => {
      const { alice, workspace, channelId, parent } = await thread();

      // 親の投稿で1回使っている。残りの 59 回を返信と投稿で交互に使う。
      for (let index = 0; index < POST_LIMIT - 1; index += 1) {
        const res =
          index % 2 === 0
            ? await reply(alice, workspace.id, channelId, parent.id, `返信${index}`)
            : await post(alice, workspace.id, channelId, `本体${index}`);
        expect(res.status, String(index)).toBe(201);
      }
      const limited = await reply(alice, workspace.id, channelId, parent.id, '上限を超えた返信');

      expect(limited.status).toBe(429);
      expect(await limited.json()).toEqual(TOO_MANY_REQUESTS);
      expect(await replyCountOf(parent.id)).toBe(30);
    });
  });

  describe('投稿のレート制限', () => {
    it('同じ利用者の投稿は1分に60回までで、超えたら 429 too_many_requests と Retry-After を返して書き込まない。別の利用者は断らない', async () => {
      const owner = await login();
      const alice = await login();
      const bob = await login();
      const workspace = await workspaceWith(owner, alice, bob);
      const channelId = await channelRow(workspace.id, 'PUBLIC', [alice, bob]);

      for (let i = 0; i < POST_LIMIT; i += 1) {
        expect((await post(alice, workspace.id, channelId, `連投${i}`)).status).toBe(201);
      }
      const limited = await post(alice, workspace.id, channelId, '多すぎる');
      expect(limited.status).toBe(429);
      expect(await limited.json()).toEqual(TOO_MANY_REQUESTS);
      expect(limited.headers.get('retry-after')).not.toBeNull();
      expect(await prisma.message.count({ where: { channelId, authorId: alice.id } })).toBe(
        POST_LIMIT,
      );

      // 発信元（テストでは全員が同じ）ではなく利用者で数えるため、別の利用者は断らない。
      expect((await post(bob, workspace.id, channelId, '別の人')).status).toBe(201);
    });

    // 機能一覧 4.1: 仕様の検証で 400 になる投稿は、ガードより前に断るため枠を消費しない（9.2 の入室要求とは違う）。
    it('本文が仕様に合わない投稿は、上限を超えて送っても 400 のままで、枠を消費しない', async () => {
      const owner = await login();
      const alice = await login();
      const workspace = await workspaceWith(owner, alice);
      const channelId = await channelRow(workspace.id, 'PUBLIC', [alice]);

      for (let i = 0; i <= POST_LIMIT; i += 1) {
        expect((await post(alice, workspace.id, channelId, '')).status).toBe(400);
      }
      // 枠を消費していなければ、続く正当な投稿は上限に達していない。
      expect((await post(alice, workspace.id, channelId, '正しい本文')).status).toBe(201);
    });

    it('上限の超過を、制限の種類（user）・利用者の ID・パスとともに記録する', async () => {
      const owner = await login();
      const alice = await login();
      const workspace = await workspaceWith(owner, alice);
      const channelId = await channelRow(workspace.id, 'PUBLIC', [alice]);
      for (let i = 0; i < POST_LIMIT; i += 1)
        await post(alice, workspace.id, channelId, `連投${i}`);
      const before = logger.lines.length;

      expect((await post(alice, workspace.id, channelId, '多すぎる')).status).toBe(429);

      const line = logger.lines.slice(before).find((l) => l.includes('rate_limit_exceeded'));
      expect(line).toBeDefined();
      expect(line).toContain('"limit":"user"');
      expect(line).toContain(alice.id);
      expect(line).toContain(`/api/workspaces/${workspace.id}/channels/${channelId}/messages`);
    });
  });
});
