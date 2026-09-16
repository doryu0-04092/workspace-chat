import 'reflect-metadata';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { REALTIME_REQUESTS, type UnreadUpdatedPayload, type paths } from '@workspace-chat/shared';
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
import { advanceReadPosition } from './unread';

type Workspace = paths['/workspaces']['post']['responses'][201]['content']['application/json'];
type Channel =
  paths['/workspaces/{id}/channels']['get']['responses'][200]['content']['application/json'][number];
type Message =
  paths['/workspaces/{id}/channels/{channelId}/messages']['post']['responses'][201]['content']['application/json'];

const NOT_FOUND = { code: 'not_found', message: '見つかりません' };
const NOT_A_CHANNEL_MEMBER = 'not_a_channel_member';
const MISSING_ID = '00000000-0000-7000-8000-000000000000';

let sequence = 0;
let ipSequence = 0;
function nextIp(): string {
  ipSequence += 1;
  return `2001:db8::e:${ipSequence.toString(16)}`;
}

type LoggedIn = { authorization: string; token: string; id: string; loginId: string };

// 機能一覧 10.1（F-23）: 未読管理。既読位置からの差分で未読を求め、unread:updated を持ち主の部屋へだけ配る。#504。
// CLAUDE.md「必ずテストを書く箇所」: オーナーが、参加していないプライベートチャンネルの未読数を取得できないこと／
// WebSocket が非参加者にイベントを配信しないこと。
describe('未読管理（F-23）', () => {
  let postgres: StartedPostgreSqlContainer;
  let valkey: StartedTestContainer;
  let app: INestApplication;
  let base: string;
  let prisma: PrismaService;
  const opened: Socket[] = [];

  async function login(): Promise<LoggedIn> {
    sequence += 1;
    const loginId = `Un_${Date.now().toString(36)}_${sequence}`;
    const user = await prisma.user.create({
      data: {
        loginId,
        displayName: `未読の人${sequence}`,
        passwordHash: await hashSecret('unread-password'),
      },
    });
    const res = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': nextIp() },
      body: JSON.stringify({ userId: loginId, password: 'unread-password' }),
    });
    expect(res.status).toBe(200);
    const { accessToken } = (await res.json()) as { accessToken: string };
    return { authorization: `Bearer ${accessToken}`, token: accessToken, id: user.id, loginId };
  }

  function request(
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    authorization: string,
    body?: unknown,
  ): Promise<Response> {
    return fetch(`${base}/api${path}`, {
      method,
      headers: {
        authorization,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  async function workspaceWith(owner: LoggedIn, ...members: LoggedIn[]): Promise<Workspace> {
    const res = await request('POST', '/workspaces', owner.authorization, { name: '未読の場所' });
    expect(res.status).toBe(201);
    const workspace = (await res.json()) as Workspace;
    for (const member of members) {
      await prisma.membership.create({
        data: { workspaceId: workspace.id, userId: member.id, role: 'MEMBER' },
      });
    }
    return workspace;
  }

  /** API を通さずにチャンネルを作る（参加者の組み合わせを自由に用意するため）。 */
  async function channelRow(
    workspaceId: string,
    visibility: 'PUBLIC' | 'PRIVATE',
    participants: LoggedIn[],
  ): Promise<string> {
    sequence += 1;
    const name = `unread-${sequence}`;
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

  async function posted(
    by: LoggedIn,
    workspaceId: string,
    channelId: string,
    body: string,
  ): Promise<Message> {
    const res = await request(
      'POST',
      `/workspaces/${workspaceId}/channels/${channelId}/messages`,
      by.authorization,
      { body },
    );
    expect(res.status).toBe(201);
    return (await res.json()) as Message;
  }

  async function replied(
    by: LoggedIn,
    workspaceId: string,
    channelId: string,
    parentId: string,
    body: string,
  ): Promise<Message> {
    const res = await request(
      'POST',
      `/workspaces/${workspaceId}/channels/${channelId}/messages/${parentId}/replies`,
      by.authorization,
      { body },
    );
    expect(res.status).toBe(201);
    return (await res.json()) as Message;
  }

  /** 一覧を引いて、そのチャンネルの行を返す。 */
  async function channelOf(
    by: LoggedIn,
    workspaceId: string,
    channelId: string,
  ): Promise<Channel | undefined> {
    const res = await request('GET', `/workspaces/${workspaceId}/channels`, by.authorization);
    expect(res.status).toBe(200);
    const channels = (await res.json()) as Channel[];
    return channels.find((channel) => channel.id === channelId);
  }

  async function unreadOf(by: LoggedIn, workspaceId: string, channelId: string): Promise<number> {
    const channel = await channelOf(by, workspaceId, channelId);
    expect(channel).toBeDefined();
    return channel?.unread ?? -1;
  }

  function read(
    by: LoggedIn,
    workspaceId: string,
    channelId: string,
    lastReadMessageId: string,
  ): Promise<Response> {
    return request(
      'PUT',
      `/workspaces/${workspaceId}/channels/${channelId}/read`,
      by.authorization,
      { lastReadMessageId },
    );
  }

  /** スレッド（親のメッセージ）の中で読んだ位置を進める。 */
  function readReply(
    by: LoggedIn,
    workspaceId: string,
    channelId: string,
    parentId: string,
    lastReadMessageId: string,
  ): Promise<Response> {
    return request(
      'PUT',
      `/workspaces/${workspaceId}/channels/${channelId}/messages/${parentId}/read`,
      by.authorization,
      { lastReadMessageId },
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
    const { port } = app.getHttpServer().address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
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

  describe('一覧の未読数', () => {
    it('既読位置が無ければ、参加した後の他人の投稿だけを数える（参加する前の投稿は数えない）', async () => {
      const alice = await login();
      const bob = await login();
      const workspace = await workspaceWith(alice, bob);
      const channelId = await channelRow(workspace.id, 'PUBLIC', [alice]);

      await posted(alice, workspace.id, channelId, '参加する前の1');
      await posted(alice, workspace.id, channelId, '参加する前の2');
      await prisma.channelMember.create({
        data: { channelId, workspaceId: workspace.id, userId: bob.id },
      });
      await posted(alice, workspace.id, channelId, '参加した後の1');

      expect(await unreadOf(bob, workspace.id, channelId)).toBe(1);
    });

    it('自分の投稿は数えない', async () => {
      const alice = await login();
      const workspace = await workspaceWith(alice);
      const channelId = await channelRow(workspace.id, 'PUBLIC', [alice]);

      await posted(alice, workspace.id, channelId, '自分の投稿');

      expect(await unreadOf(alice, workspace.id, channelId)).toBe(0);
    });

    it('削除済みのメッセージは数えない', async () => {
      const alice = await login();
      const bob = await login();
      const workspace = await workspaceWith(alice, bob);
      const channelId = await channelRow(workspace.id, 'PUBLIC', [alice, bob]);

      const kept = await posted(alice, workspace.id, channelId, '残る');
      const removed = await posted(alice, workspace.id, channelId, '消す');
      expect(await unreadOf(bob, workspace.id, channelId)).toBe(2);

      const res = await fetch(
        `${base}/api/workspaces/${workspace.id}/channels/${channelId}/messages/${removed.id}`,
        { method: 'DELETE', headers: { authorization: alice.authorization } },
      );
      expect(res.status).toBe(204);

      expect(await unreadOf(bob, workspace.id, channelId)).toBe(1);
      expect(kept.id).not.toBe(removed.id);
    });

    it('既読位置まで読むと、その位置以前は未読でなくなる', async () => {
      const alice = await login();
      const bob = await login();
      const workspace = await workspaceWith(alice, bob);
      const channelId = await channelRow(workspace.id, 'PUBLIC', [alice, bob]);

      const first = await posted(alice, workspace.id, channelId, '1');
      await posted(alice, workspace.id, channelId, '2');
      expect(await unreadOf(bob, workspace.id, channelId)).toBe(2);

      expect((await read(bob, workspace.id, channelId, first.id)).status).toBe(204);

      expect(await unreadOf(bob, workspace.id, channelId)).toBe(1);
    });

    // 「ここから未読」の線は、この位置の次のメッセージの上に出す（10.1）。**未読数から位置を数えると必ずずれる**——
    // 自分の投稿と削除済みは未読に数えないが、一覧には並ぶためである。
    it('既読位置を、線を引くための id として返す（持たないうちは null、進めるとその id）', async () => {
      const alice = await login();
      const bob = await login();
      const workspace = await workspaceWith(alice, bob);
      const channelId = await channelRow(workspace.id, 'PUBLIC', [alice, bob]);
      const first = await posted(alice, workspace.id, channelId, '1');
      await posted(alice, workspace.id, channelId, '2');

      expect((await channelOf(bob, workspace.id, channelId))?.lastReadMessageId).toBeNull();

      expect((await read(bob, workspace.id, channelId, first.id)).status).toBe(204);

      expect((await channelOf(bob, workspace.id, channelId))?.lastReadMessageId).toBe(first.id);
    });

    // 既読位置は `ChannelMember` と同じ寿命にする（`schema.prisma` の `ChannelRead` の docblock）。
    // **ワークスペース単位のキック・退出では DB が連鎖して消すが、チャンネル単位では消えない**ため、
    // 抜けるときにアプリが消す。残すと、再参加した人に**参加前の位置**が返り、「ここから未読」の線が未読数と食い違う（#505 第2巡の 🔴1）。
    it('チャンネルを抜けて入り直すと、既読位置は持たない状態に戻る', async () => {
      const alice = await login();
      const bob = await login();
      const workspace = await workspaceWith(alice, bob);
      const channelId = await channelRow(workspace.id, 'PUBLIC', [alice, bob]);
      const first = await posted(alice, workspace.id, channelId, '1');
      expect((await read(bob, workspace.id, channelId, first.id)).status).toBe(204);
      expect((await channelOf(bob, workspace.id, channelId))?.lastReadMessageId).toBe(first.id);

      // 抜けて、入り直す
      expect(
        (
          await request(
            'POST',
            `/workspaces/${workspace.id}/channels/${channelId}/leave`,
            bob.authorization,
          )
        ).status,
      ).toBe(204);
      expect(
        (
          await request(
            'POST',
            `/workspaces/${workspace.id}/channels/${channelId}/join`,
            bob.authorization,
          )
        ).status,
      ).toBe(204);

      expect((await channelOf(bob, workspace.id, channelId))?.lastReadMessageId).toBeNull();
    });

    it('参加していないパブリックチャンネルの未読は常に 0', async () => {
      const alice = await login();
      const bob = await login();
      const workspace = await workspaceWith(alice, bob);
      const channelId = await channelRow(workspace.id, 'PUBLIC', [alice]);

      await posted(alice, workspace.id, channelId, '参加していない人には数えない');

      const channel = await channelOf(bob, workspace.id, channelId);
      expect(channel?.joined).toBe(false);
      expect(channel?.unread).toBe(0);
    });

    it('参加していないプライベートチャンネルは、オーナーの一般の一覧にも出ない（未読数も渡らない）', async () => {
      const alice = await login();
      const bob = await login();
      const workspace = await workspaceWith(alice, bob);
      const channelId = await channelRow(workspace.id, 'PRIVATE', [bob]);

      await posted(bob, workspace.id, channelId, 'オーナーには見えない');

      expect(await channelOf(alice, workspace.id, channelId)).toBeUndefined();
    });
  });

  describe('既読の更新', () => {
    it('参加者は既読位置を進められ、進めた分だけ未読が減る', async () => {
      const alice = await login();
      const bob = await login();
      const workspace = await workspaceWith(alice, bob);
      const channelId = await channelRow(workspace.id, 'PUBLIC', [alice, bob]);

      await posted(alice, workspace.id, channelId, '1');
      const last = await posted(alice, workspace.id, channelId, '2');

      expect((await read(bob, workspace.id, channelId, last.id)).status).toBe(204);

      expect(await unreadOf(bob, workspace.id, channelId)).toBe(0);
    });

    // REVIEW.md 6章「同時実行の競合は、同時に実行して確かめる」。**行がまだ無い状態**で古い位置と新しい位置が
    // 同時に来ると、先に作った側が古い位置を持ちうる。**一意違反を握って終えると、新しい位置が捨てられる**
    // （位置は戻らないが、進むはずの位置が進まない。#505 第4巡の 🔴1）。
    it('既読位置を持たない状態で、古い位置と新しい位置を同時に書いても、新しい方が残る', async () => {
      const alice = await login();
      const bob = await login();
      const workspace = await workspaceWith(alice, bob);
      const channelId = await channelRow(workspace.id, 'PUBLIC', [alice, bob]);
      const older = await posted(alice, workspace.id, channelId, '1');
      const newer = await posted(alice, workspace.id, channelId, '2');

      // **行が作られる競合を確実に起こす**。HTTP で2本同時に送るだけでは、片方が先に完了して競合にならない
      // ——**新しい方が `create` に入る前に、古い方に行を作らせる**。`advanceReadPosition` を直に呼び、
      // 新しい方の `create` だけを、古い方が書き終えるまで待たせる（Prisma のクライアントは差し替えない）。
      let releaseNewer!: () => void;
      const olderWrote = new Promise<void>((resolve) => {
        releaseNewer = resolve;
      });
      const position = (lastReadMessageId: string, waitBeforeCreate: boolean) =>
        advanceReadPosition(
          {
            updateMany: (args) => prisma.channelRead.updateMany(args),
            create: async (args) => {
              if (waitBeforeCreate) await olderWrote;
              return prisma.channelRead.create(args);
            },
          },
          {
            where: { channelId, userId: bob.id },
            create: { channelId, workspaceId: workspace.id, userId: bob.id, lastReadMessageId },
            lastReadMessageId,
          },
        );

      await Promise.all([
        position(newer.id, true),
        position(older.id, false).then(() => releaseNewer()),
      ]);

      expect((await channelOf(bob, workspace.id, channelId))?.lastReadMessageId).toBe(newer.id);
      expect(await unreadOf(bob, workspace.id, channelId)).toBe(0);
    });

    it('既読位置は戻らない——古い id を渡しても未読は増えない', async () => {
      const alice = await login();
      const bob = await login();
      const workspace = await workspaceWith(alice, bob);
      const channelId = await channelRow(workspace.id, 'PUBLIC', [alice, bob]);

      const first = await posted(alice, workspace.id, channelId, '1');
      const last = await posted(alice, workspace.id, channelId, '2');
      expect((await read(bob, workspace.id, channelId, last.id)).status).toBe(204);

      expect((await read(bob, workspace.id, channelId, first.id)).status).toBe(204);

      expect(await unreadOf(bob, workspace.id, channelId)).toBe(0);
    });

    it('別のチャンネルのメッセージ・存在しないメッセージ・削除済みのメッセージの id は 404', async () => {
      const alice = await login();
      const bob = await login();
      const workspace = await workspaceWith(alice, bob);
      const channelId = await channelRow(workspace.id, 'PUBLIC', [alice, bob]);
      const other = await channelRow(workspace.id, 'PUBLIC', [alice, bob]);

      const elsewhere = await posted(alice, workspace.id, other, 'よそのメッセージ');
      const removed = await posted(alice, workspace.id, channelId, '消す');
      const deleted = await fetch(
        `${base}/api/workspaces/${workspace.id}/channels/${channelId}/messages/${removed.id}`,
        { method: 'DELETE', headers: { authorization: alice.authorization } },
      );
      expect(deleted.status).toBe(204);

      for (const id of [elsewhere.id, MISSING_ID, removed.id]) {
        const res = await read(bob, workspace.id, channelId, id);
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual(NOT_FOUND);
      }
    });

    it('所属していなければ種別によらず 404、所属していて参加者でなければパブリックは 403・プライベートは 404', async () => {
      const alice = await login();
      const bob = await login();
      const outsider = await login();
      const workspace = await workspaceWith(alice, bob);
      const open = await channelRow(workspace.id, 'PUBLIC', [alice]);
      const secret = await channelRow(workspace.id, 'PRIVATE', [alice]);
      const message = await posted(alice, workspace.id, open, '本文');
      const inSecret = await posted(alice, workspace.id, secret, '本文');

      for (const channelId of [open, secret]) {
        const res = await read(outsider, workspace.id, channelId, message.id);
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual(NOT_FOUND);
      }

      const toOpen = await read(bob, workspace.id, open, message.id);
      expect(toOpen.status).toBe(403);
      expect(((await toOpen.json()) as { code: string }).code).toBe(NOT_A_CHANNEL_MEMBER);

      const toSecret = await read(bob, workspace.id, secret, inSecret.id);
      expect(toSecret.status).toBe(404);
      expect(await toSecret.json()).toEqual(NOT_FOUND);
    });

    it('オーナーの例外は及ばない——参加していないプライベートチャンネルへの既読の更新は 404', async () => {
      const alice = await login();
      const bob = await login();
      const workspace = await workspaceWith(alice, bob);
      const channelId = await channelRow(workspace.id, 'PRIVATE', [bob]);
      const message = await posted(bob, workspace.id, channelId, '本文');

      const res = await read(alice, workspace.id, channelId, message.id);

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual(NOT_FOUND);
    });
  });

  describe('配信（unread:updated）', () => {
    it('投稿されると、参加者それぞれの利用者の部屋にその人の未読数が届き、投稿した本人と非参加者には届かない', async () => {
      const alice = await login();
      const bob = await login();
      const carol = await login();
      const workspace = await workspaceWith(alice, bob, carol);
      const channelId = await channelRow(workspace.id, 'PUBLIC', [alice, bob]);
      const aliceSocket = await open(alice);
      const bobSocket = await open(bob);
      const carolSocket = await open(carol);
      await enter(aliceSocket, channelId);
      await enter(bobSocket, channelId);

      const toBob = nextEvent(bobSocket, 'unread:updated', 3_000);
      const toAlice = nextEvent(aliceSocket, 'unread:updated', 1_000);
      const toCarol = nextEvent(carolSocket, 'unread:updated', 1_000);
      await posted(alice, workspace.id, channelId, '届く');

      const payload = (await toBob) as UnreadUpdatedPayload;
      expect(payload.channelId).toBe(channelId);
      expect(payload.unread).toBe(1);
      expect(typeof payload.sentAt).toBe('string');
      expect(await toAlice).toBeUndefined();
      expect(await toCarol).toBeUndefined();
    });

    // 既読を進めて変わるのは**その人の未読だけ**である。参加者全員を数え直して配ると、
    // 1要求が人数分の集計と配信に増幅する（#505 第0巡の 🔴3）。
    it('スレッドの既読を進めると、進めた本人にだけ届き、他の参加者には届かない', async () => {
      const alice = await login();
      const bob = await login();
      const carol = await login();
      const workspace = await workspaceWith(alice, bob, carol);
      const channelId = await channelRow(workspace.id, 'PUBLIC', [alice, bob, carol]);
      const parent = await posted(alice, workspace.id, channelId, '親');
      const reply = await replied(alice, workspace.id, channelId, parent.id, '返信');
      const bobSocket = await open(bob);
      const carolSocket = await open(carol);

      const toBob = nextEvent(bobSocket, 'unread:updated', 3_000);
      const toCarol = nextEvent(carolSocket, 'unread:updated', 1_500);
      expect((await readReply(bob, workspace.id, channelId, parent.id, reply.id)).status).toBe(204);

      expect(((await toBob) as UnreadUpdatedPayload).channelId).toBe(channelId);
      expect(await toCarol).toBeUndefined();
    });

    it('既読を更新すると、その人の部屋に減った後の未読数が届く', async () => {
      const alice = await login();
      const bob = await login();
      const workspace = await workspaceWith(alice, bob);
      const channelId = await channelRow(workspace.id, 'PUBLIC', [alice, bob]);
      const message = await posted(alice, workspace.id, channelId, '1');
      const bobSocket = await open(bob);
      await enter(bobSocket, channelId);

      const toBob = nextEvent(bobSocket, 'unread:updated', 3_000);
      expect((await read(bob, workspace.id, channelId, message.id)).status).toBe(204);

      const payload = (await toBob) as UnreadUpdatedPayload;
      expect(payload.channelId).toBe(channelId);
      expect(payload.unread).toBe(0);
    });

    // 退会は論理削除で User の行が残り（機能一覧 1.5）、Membership を消すのは退会の処理の側である。
    // **消し損ねた・消す前の状態では ChannelMember が残る**ため、宛先から退会した利用者を外す条件が要る。
    it('退会した参加者には配らない', async () => {
      const alice = await login();
      const bob = await login();
      const workspace = await workspaceWith(alice, bob);
      const channelId = await channelRow(workspace.id, 'PUBLIC', [alice, bob]);
      const bobSocket = await open(bob);
      await prisma.user.update({ where: { id: bob.id }, data: { deletedAt: new Date() } });

      const toBob = nextEvent(bobSocket, 'unread:updated', 1_500);
      await posted(alice, workspace.id, channelId, '退会した人には届かない');

      expect(await toBob).toBeUndefined();
    });

    // **読み終えている参加者も配信の宛先に残る**（#505 第3巡の 🔴1）。
    // 返信の絞り込みを結合の後に置くと、その人が `unreadOfMembers` の結果から消え、未読 0 が届かない
    // ——サイドバーの太字が減らないまま残る。
    it('スレッドまで読み終えた参加者にも、削除で減った未読が届く', async () => {
      const alice = await login();
      const bob = await login();
      const workspace = await workspaceWith(alice, bob);
      const channelId = await channelRow(workspace.id, 'PUBLIC', [alice, bob]);
      const parent = await posted(alice, workspace.id, channelId, '親');
      const reply = await replied(alice, workspace.id, channelId, parent.id, '返信');
      // bob は本体もスレッドも読み終えている
      expect((await read(bob, workspace.id, channelId, parent.id)).status).toBe(204);
      expect((await readReply(bob, workspace.id, channelId, parent.id, reply.id)).status).toBe(204);
      expect(await unreadOf(bob, workspace.id, channelId)).toBe(0);
      // そこへ新しい返信が来る（bob の未読は 1）
      const added = await replied(alice, workspace.id, channelId, parent.id, '後から来た返信');
      expect(await unreadOf(bob, workspace.id, channelId)).toBe(1);
      const bobSocket = await open(bob);

      const toBob = nextEvent(bobSocket, 'unread:updated', 3_000);
      const removed = await fetch(
        `${base}/api/workspaces/${workspace.id}/channels/${channelId}/messages/${added.id}`,
        { method: 'DELETE', headers: { authorization: alice.authorization } },
      );
      expect(removed.status).toBe(204);

      expect(((await toBob) as UnreadUpdatedPayload).unread).toBe(0);
    });

    it('チャンネルの部屋には配らない——入室していない参加者にも、その人の未読数が届く', async () => {
      const alice = await login();
      const bob = await login();
      const workspace = await workspaceWith(alice, bob);
      const channelId = await channelRow(workspace.id, 'PUBLIC', [alice, bob]);
      const bobSocket = await open(bob);

      const toBob = nextEvent(bobSocket, 'unread:updated', 3_000);
      await posted(alice, workspace.id, channelId, '入室していなくても届く');

      const payload = (await toBob) as UnreadUpdatedPayload;
      expect(payload.unread).toBe(1);
    });
  });

  describe('スレッドの未読', () => {
    it('既定（含める）では、返信も未読に数える', async () => {
      const alice = await login();
      const bob = await login();
      const workspace = await workspaceWith(alice, bob);
      const channelId = await channelRow(workspace.id, 'PUBLIC', [alice, bob]);

      const parent = await posted(alice, workspace.id, channelId, '親');
      await replied(alice, workspace.id, channelId, parent.id, '返信');

      expect(await unreadOf(bob, workspace.id, channelId)).toBe(2);
    });

    // スレッドの既読位置は、チャンネルの既読位置とは別系統である（10.1）。
    // **チャンネルの既読位置より新しい返信**を、スレッドの側で読んだときに未読から外せることを見る
    // （この1件だけが `ThreadRead` の条件を守っている。外すと未読が減らない）。
    it('スレッドの中で読むと、チャンネルの既読位置より新しい返信が未読から外れる', async () => {
      const alice = await login();
      const bob = await login();
      const workspace = await workspaceWith(alice, bob);
      const channelId = await channelRow(workspace.id, 'PUBLIC', [alice, bob]);
      const parent = await posted(alice, workspace.id, channelId, '親');
      // チャンネルの既読位置は親まで。返信は、それより新しい
      expect((await read(bob, workspace.id, channelId, parent.id)).status).toBe(204);
      const reply = await replied(alice, workspace.id, channelId, parent.id, '返信');
      expect(await unreadOf(bob, workspace.id, channelId)).toBe(1);

      expect((await readReply(bob, workspace.id, channelId, parent.id, reply.id)).status).toBe(204);

      expect(await unreadOf(bob, workspace.id, channelId)).toBe(0);
    });

    // 既読位置は「利用者 × スレッド」で持つ（機能一覧 10.1）。チャンネル単位で持つと、
    // **1つのスレッドを読んだだけで、別のスレッドの返信まで既読になる**。
    it('あるスレッドを読んでも、別のスレッドの返信は未読のまま残る', async () => {
      const alice = await login();
      const bob = await login();
      const workspace = await workspaceWith(alice, bob);
      const channelId = await channelRow(workspace.id, 'PUBLIC', [alice, bob]);
      const first = await posted(alice, workspace.id, channelId, '親1');
      const second = await posted(alice, workspace.id, channelId, '親2');
      const toFirst = await replied(alice, workspace.id, channelId, first.id, '返信1');
      const toSecond = await replied(alice, workspace.id, channelId, second.id, '返信2');
      // 本体（親2つ）まではチャンネルの既読位置で読み終えている
      expect((await read(bob, workspace.id, channelId, second.id)).status).toBe(204);
      expect(await unreadOf(bob, workspace.id, channelId)).toBe(2);

      // **古い返信のスレッドを先に読む**（ここで「利用者 × スレッド」の行が1つできる）
      expect((await readReply(bob, workspace.id, channelId, first.id, toFirst.id)).status).toBe(
        204,
      );

      // もう片方の返信は未読のまま
      expect(await unreadOf(bob, workspace.id, channelId)).toBe(1);

      // **次に新しい返信のスレッドを読むと、そちらにも行ができて両方が既読になる。**
      // 既読位置をチャンネル単位で持つと、ここで**さきほどのスレッドの行を書き換えてしまい**、
      // 新しい返信の分が未読に残る（機能一覧 10.1 の「利用者 × スレッド」）
      expect((await readReply(bob, workspace.id, channelId, second.id, toSecond.id)).status).toBe(
        204,
      );
      expect(await unreadOf(bob, workspace.id, channelId)).toBe(0);
    });

    it('スレッドの既読位置も戻らず、別のスレッド・存在しない返信の id は 404', async () => {
      const alice = await login();
      const bob = await login();
      const workspace = await workspaceWith(alice, bob);
      const channelId = await channelRow(workspace.id, 'PUBLIC', [alice, bob]);
      const parent = await posted(alice, workspace.id, channelId, '親');
      const other = await posted(alice, workspace.id, channelId, 'もう1つの親');
      const first = await replied(alice, workspace.id, channelId, parent.id, '返信1');
      const second = await replied(alice, workspace.id, channelId, parent.id, '返信2');
      // チャンネルの既読位置は、**本体の最後**（`other`）まで進める。`parent` までにすると `other` が未読に残り、
      // スレッドの既読位置の効きを見られない
      expect((await read(bob, workspace.id, channelId, other.id)).status).toBe(204);
      expect((await readReply(bob, workspace.id, channelId, parent.id, second.id)).status).toBe(
        204,
      );
      expect(await unreadOf(bob, workspace.id, channelId)).toBe(0);

      // 古い返信を渡しても戻らない
      expect((await readReply(bob, workspace.id, channelId, parent.id, first.id)).status).toBe(204);
      expect(await unreadOf(bob, workspace.id, channelId)).toBe(0);

      // **すべて読み終えても、その人の行は残る**（既読位置を返し続ける）。
      // 返信の絞り込みを結合の後に置くと、候補行が「既読済みの返信」だけになった参加者は群ごと消え、
      // 既読位置が null に化ける（#505 第3巡の 🔴1）。
      expect((await channelOf(bob, workspace.id, channelId))?.lastReadMessageId).toBe(other.id);

      // 別のスレッドの返信・存在しない id は 404
      expect((await readReply(bob, workspace.id, channelId, other.id, first.id)).status).toBe(404);
      expect((await readReply(bob, workspace.id, channelId, parent.id, MISSING_ID)).status).toBe(
        404,
      );
    });

    // **返信より新しい本体が後から来る並び**（#505 第1巡の 🔴1）。チャンネルの一覧は本体だけを返すので、
    // 「最新のページを読み込んだ時点で既読にする」と、既読位置は**返信より新しい本体**まで進む。
    // ここで返信にもチャンネルの既読位置を当てると、**スレッドを一度も開いていない返信が未読から消える**。
    it('返信より後に本体が来ても、チャンネルを読んだだけでは返信は未読のまま残る', async () => {
      const alice = await login();
      const bob = await login();
      const workspace = await workspaceWith(alice, bob);
      const channelId = await channelRow(workspace.id, 'PUBLIC', [alice, bob]);
      const parent = await posted(alice, workspace.id, channelId, '親');
      await replied(alice, workspace.id, channelId, parent.id, '返信');
      // 返信の**後**に本体が来る
      const latest = await posted(alice, workspace.id, channelId, '後から来た本体');

      // 一覧の最新（本体）まで読む
      expect((await read(bob, workspace.id, channelId, latest.id)).status).toBe(204);

      // 本体2つは既読、返信だけが残る
      expect(await unreadOf(bob, workspace.id, channelId)).toBe(1);

      // 「含めない」→「含める」で、その返信が現れることも変わらない（10.1 の受け入れ条件）
      await prisma.user.update({ where: { id: bob.id }, data: { threadUnreadIncluded: false } });
      expect(await unreadOf(bob, workspace.id, channelId)).toBe(0);
      await prisma.user.update({ where: { id: bob.id }, data: { threadUnreadIncluded: true } });
      expect(await unreadOf(bob, workspace.id, channelId)).toBe(1);
    });

    it('チャンネルの既読位置に返信の id は渡せない（404）', async () => {
      const alice = await login();
      const bob = await login();
      const workspace = await workspaceWith(alice, bob);
      const channelId = await channelRow(workspace.id, 'PUBLIC', [alice, bob]);
      const parent = await posted(alice, workspace.id, channelId, '親');
      const reply = await replied(alice, workspace.id, channelId, parent.id, '返信');

      const res = await read(bob, workspace.id, channelId, reply.id);

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual(NOT_FOUND);
    });

    it('「含めない」に切り替えると返信を数えず、「含める」に戻すと過去の未読の返信が未読として現れる', async () => {
      const alice = await login();
      const bob = await login();
      const workspace = await workspaceWith(alice, bob);
      const channelId = await channelRow(workspace.id, 'PUBLIC', [alice, bob]);
      const parent = await posted(alice, workspace.id, channelId, '親');
      await replied(alice, workspace.id, channelId, parent.id, '返信');

      await prisma.user.update({
        where: { id: bob.id },
        data: { threadUnreadIncluded: false },
      });
      expect(await unreadOf(bob, workspace.id, channelId)).toBe(1);

      await prisma.user.update({
        where: { id: bob.id },
        data: { threadUnreadIncluded: true },
      });
      expect(await unreadOf(bob, workspace.id, channelId)).toBe(2);
    });
  });

  // 機能一覧 10.2（F-24）: 自分宛のメンション件数。**未読のうち、自分をメンションしているもの**として数える
  // （同じ `UNREAD_JOINS` を通す。数え方を未読と分けると、片方だけが仕様とずれる）。#516。
  describe('メンションの件数（F-24）', () => {
    async function mentionsOf(
      by: LoggedIn,
      workspaceId: string,
      channelId: string,
    ): Promise<number> {
      const channel = await channelOf(by, workspaceId, channelId);
      expect(channel).toBeDefined();
      return channel?.mentions ?? -1;
    }

    it('未読のうち、自分をメンションしているものだけを数える', async () => {
      const alice = await login();
      const bob = await login();
      const carol = await login();
      const workspace = await workspaceWith(alice, bob, carol);
      const channelId = await channelRow(workspace.id, 'PUBLIC', [alice, bob, carol]);

      await posted(alice, workspace.id, channelId, `@${bob.loginId} 見てください`);
      await posted(alice, workspace.id, channelId, 'メンションなし');
      await posted(alice, workspace.id, channelId, `@${carol.loginId} こちらはキャロルへ`);

      expect(await unreadOf(bob, workspace.id, channelId)).toBe(3);
      expect(await mentionsOf(bob, workspace.id, channelId)).toBe(1);
      expect(await mentionsOf(carol, workspace.id, channelId)).toBe(1);
      expect(await mentionsOf(alice, workspace.id, channelId)).toBe(0);
    });

    it('自分で自分をメンションした投稿は数えない', async () => {
      const alice = await login();
      const workspace = await workspaceWith(alice);
      const channelId = await channelRow(workspace.id, 'PUBLIC', [alice]);

      await posted(alice, workspace.id, channelId, `@${alice.loginId} 自分宛のメモ`);

      expect(await mentionsOf(alice, workspace.id, channelId)).toBe(0);
    });

    it('削除されたメッセージのメンションは数えない', async () => {
      const alice = await login();
      const bob = await login();
      const workspace = await workspaceWith(alice, bob);
      const channelId = await channelRow(workspace.id, 'PUBLIC', [alice, bob]);
      const message = await posted(alice, workspace.id, channelId, `@${bob.loginId} 消します`);
      expect(await mentionsOf(bob, workspace.id, channelId)).toBe(1);

      const res = await fetch(
        `${base}/api/workspaces/${workspace.id}/channels/${channelId}/messages/${message.id}`,
        { method: 'DELETE', headers: { authorization: alice.authorization } },
      );
      expect(res.status).toBe(204);

      expect(await mentionsOf(bob, workspace.id, channelId)).toBe(0);
    });

    it('既読を進めると、その位置までのメンションは数えなくなる', async () => {
      const alice = await login();
      const bob = await login();
      const workspace = await workspaceWith(alice, bob);
      const channelId = await channelRow(workspace.id, 'PUBLIC', [alice, bob]);
      const first = await posted(alice, workspace.id, channelId, `@${bob.loginId} 1つ目`);
      await posted(alice, workspace.id, channelId, `@${bob.loginId} 2つ目`);
      expect(await mentionsOf(bob, workspace.id, channelId)).toBe(2);

      expect((await read(bob, workspace.id, channelId, first.id)).status).toBe(204);

      expect(await mentionsOf(bob, workspace.id, channelId)).toBe(1);
    });

    // **メンションの件数は未読の部分集合である**——返信を未読に含めない設定の利用者には、返信の中のメンションも数えない。
    // 代償として機能一覧 10.2 に記録した。
    it('スレッドの返信のメンションは、返信を未読に含める設定のときだけ数える', async () => {
      const alice = await login();
      const bob = await login();
      const workspace = await workspaceWith(alice, bob);
      const channelId = await channelRow(workspace.id, 'PUBLIC', [alice, bob]);
      const parent = await posted(alice, workspace.id, channelId, '親');
      await replied(alice, workspace.id, channelId, parent.id, `@${bob.loginId} 返信の中で`);
      expect((await read(bob, workspace.id, channelId, parent.id)).status).toBe(204);
      expect(await mentionsOf(bob, workspace.id, channelId)).toBe(1);

      await prisma.user.update({ where: { id: bob.id }, data: { threadUnreadIncluded: false } });

      expect(await mentionsOf(bob, workspace.id, channelId)).toBe(0);
    });

    // **メンションの行を実在させてから抜ける。** 参加していない利用者へのメンションは行を作らない（9.1）ため、
    // 参加させずに投稿すると、どんな数え方でも 0 になり、このテストは落ちようがない（#531 第2巡の 🔴1）。
    // `MessageMention` は退出しても残る（schema.prisma）ので、参加で絞らずに数える形に変えるとここで落ちる。
    it('参加していないチャンネルのメンションの件数は常に 0——抜ける前にメンションされていても', async () => {
      const alice = await login();
      const bob = await login();
      const workspace = await workspaceWith(alice, bob);
      const channelId = await channelRow(workspace.id, 'PUBLIC', [alice, bob]);
      await posted(alice, workspace.id, channelId, `@${bob.loginId} 抜ける前に`);
      expect(await mentionsOf(bob, workspace.id, channelId)).toBe(1);

      expect(
        (
          await request(
            'POST',
            `/workspaces/${workspace.id}/channels/${channelId}/leave`,
            bob.authorization,
          )
        ).status,
      ).toBe(204);

      expect(await prisma.messageMention.count({ where: { userId: bob.id } })).toBe(1);
      const channel = await channelOf(bob, workspace.id, channelId);
      expect(channel?.joined).toBe(false);
      expect(channel?.mentions).toBe(0);
    });

    it('作った直後のチャンネルのメンションの件数は 0', async () => {
      const alice = await login();
      const workspace = await workspaceWith(alice);

      const res = await request(
        'POST',
        `/workspaces/${workspace.id}/channels`,
        alice.authorization,
        {
          name: `mention-new-${Date.now().toString(36)}`,
          visibility: 'PUBLIC',
        },
      );

      expect(res.status).toBe(201);
      expect(((await res.json()) as Channel).mentions).toBe(0);
    });

    it('投稿されると、メンションされた参加者にはその件数が、されていない参加者には 0 が届く', async () => {
      const alice = await login();
      const bob = await login();
      const carol = await login();
      const workspace = await workspaceWith(alice, bob, carol);
      const channelId = await channelRow(workspace.id, 'PUBLIC', [alice, bob, carol]);
      const bobSocket = await open(bob);
      const carolSocket = await open(carol);

      const toBob = nextEvent(bobSocket, 'unread:updated', 3_000);
      const toCarol = nextEvent(carolSocket, 'unread:updated', 3_000);
      await posted(alice, workspace.id, channelId, `@${bob.loginId} ボブへ`);

      const bobPayload = (await toBob) as UnreadUpdatedPayload;
      expect(bobPayload).toMatchObject({ channelId, unread: 1, mentions: 1 });
      const carolPayload = (await toCarol) as UnreadUpdatedPayload;
      expect(carolPayload).toMatchObject({ channelId, unread: 1, mentions: 0 });
    });

    // **途中まで読む**——全部読むと届くのが 0 になり、配る値を 0 に固定しても通ってしまう。
    it('既読を更新すると、減った後のメンションの件数が届く', async () => {
      const alice = await login();
      const bob = await login();
      const workspace = await workspaceWith(alice, bob);
      const channelId = await channelRow(workspace.id, 'PUBLIC', [alice, bob]);
      const first = await posted(alice, workspace.id, channelId, `@${bob.loginId} 1つ目`);
      await posted(alice, workspace.id, channelId, `@${bob.loginId} 2つ目`);
      const bobSocket = await open(bob);

      const toBob = nextEvent(bobSocket, 'unread:updated', 3_000);
      expect((await read(bob, workspace.id, channelId, first.id)).status).toBe(204);

      expect((await toBob) as UnreadUpdatedPayload).toMatchObject({ unread: 1, mentions: 1 });
    });
  });
});
