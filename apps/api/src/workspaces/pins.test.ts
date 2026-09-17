import 'reflect-metadata';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { paths } from '@workspace-chat/shared';
import type { StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app-setup';
import { hashSecret } from '../auth/secret-hash';
import { PrismaService } from '../prisma.service';
import { stubApiEnv } from '../testing/api-env';
import { CapturingLogger } from '../testing/capturing-logger';
import { POSTGRES_STARTUP_TIMEOUT_MS, startMigratedPostgres } from '../testing/postgres';
import { startValkey } from '../testing/valkey';

type Workspace = paths['/workspaces']['post']['responses'][201]['content']['application/json'];
type MessagesPath = paths['/workspaces/{id}/channels/{channelId}/messages'];
type Message = MessagesPath['post']['responses'][201]['content']['application/json'];
type PinPath = paths['/workspaces/{id}/channels/{channelId}/messages/{messageId}/pin'];
type PinnedMessage = PinPath['put']['responses'][200]['content']['application/json'];
type PinList =
  paths['/workspaces/{id}/channels/{channelId}/pins']['get']['responses'][200]['content']['application/json'];

const NOT_FOUND = { code: 'not_found', message: '見つかりません' };
const NOT_A_CHANNEL_MEMBER = {
  code: 'not_a_channel_member',
  message: 'このチャンネルの参加者ではありません',
};
const CHANNEL_ARCHIVED = { code: 'channel_archived', message: 'アーカイブ済みのチャンネルです' };
const MISSING_ID = '00000000-0000-7000-8000-000000000000';
/** 1つのチャンネルにピン留めできるメッセージの上限（実装時に決めた値）。 */
const PIN_LIMIT = 100;
/** ピン留めの付け外しの上限（利用者単位で1分に60回。ルートごと）。 */
const PIN_WRITE_LIMIT = 60;

let sequence = 0;
let ipSequence = 0;
function nextIp(): string {
  ipSequence += 1;
  return `2001:db8::f:${ipSequence.toString(16)}`;
}

type LoggedIn = { authorization: string; token: string; id: string; loginId: string };

// 機能一覧 13.2（F-33）: ピン留め。#584。
// CLAUDE.md「必ずテストを書く箇所」: オーナーが、参加していないプライベートチャンネルのメッセージを取得できないこと
// （ピン留めの一覧もメッセージを返すため、非参加者には返さない）。
describe('ピン留め（F-33）', () => {
  let postgres: StartedPostgreSqlContainer;
  let valkey: StartedTestContainer;
  let app: INestApplication;
  let base: string;
  let prisma: PrismaService;
  const logger = new CapturingLogger();

  async function login(): Promise<LoggedIn> {
    sequence += 1;
    const loginId = `Pin_${Date.now().toString(36)}_${sequence}`;
    const user = await prisma.user.create({
      data: {
        loginId,
        displayName: `留める人${sequence}`,
        passwordHash: await hashSecret('pin-password'),
      },
    });
    const res = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': nextIp() },
      body: JSON.stringify({ userId: loginId, password: 'pin-password' }),
    });
    expect(res.status).toBe(200);
    const { accessToken } = (await res.json()) as { accessToken: string };
    return { authorization: `Bearer ${accessToken}`, token: accessToken, id: user.id, loginId };
  }

  async function workspaceWith(owner: LoggedIn, ...members: LoggedIn[]): Promise<Workspace> {
    const res = await fetch(`${base}/api/workspaces`, {
      method: 'POST',
      headers: { authorization: owner.authorization, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'ピン留めの場所' }),
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
    const name = `pin-${sequence}`;
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

  function channelPath(workspaceId: string, channelId: string): string {
    return `${base}/api/workspaces/${workspaceId}/channels/${channelId}`;
  }

  async function posted(
    by: LoggedIn,
    workspaceId: string,
    channelId: string,
    body: string,
    parentId?: string,
  ): Promise<Message> {
    const path = `${channelPath(workspaceId, channelId)}/messages`;
    const res = await fetch(parentId === undefined ? path : `${path}/${parentId}/replies`, {
      method: 'POST',
      headers: { authorization: by.authorization, 'content-type': 'application/json' },
      body: JSON.stringify({ body }),
    });
    expect(res.status).toBe(201);
    return (await res.json()) as Message;
  }

  function pin(
    method: 'PUT' | 'DELETE',
    by: LoggedIn,
    workspaceId: string,
    channelId: string,
    messageId: string,
  ): Promise<Response> {
    return fetch(`${channelPath(workspaceId, channelId)}/messages/${messageId}/pin`, {
      method,
      headers: { authorization: by.authorization },
    });
  }

  async function pinned(
    by: LoggedIn,
    workspaceId: string,
    channelId: string,
    messageId: string,
  ): Promise<PinnedMessage> {
    const res = await pin('PUT', by, workspaceId, channelId, messageId);
    expect(res.status).toBe(200);
    return (await res.json()) as PinnedMessage;
  }

  function list(by: LoggedIn, workspaceId: string, channelId: string): Promise<Response> {
    return fetch(`${channelPath(workspaceId, channelId)}/pins`, {
      headers: { authorization: by.authorization },
    });
  }

  async function pins(by: LoggedIn, workspaceId: string, channelId: string): Promise<PinList> {
    const res = await list(by, workspaceId, channelId);
    expect(res.status).toBe(200);
    return (await res.json()) as PinList;
  }

  function summaryOf(user: LoggedIn) {
    return { id: user.id, userId: user.loginId, displayName: expect.any(String) };
  }

  /** オーナーのワークスペースに alice と bob が参加するチャンネルを作り、alice が1件投稿する。carol は所属していて参加していない。 */
  async function postedByAlice(visibility: 'PUBLIC' | 'PRIVATE' = 'PUBLIC') {
    const owner = await login();
    const alice = await login();
    const bob = await login();
    const carol = await login();
    const workspace = await workspaceWith(owner, alice, bob, carol);
    const channelId = await channelRow(workspace.id, visibility, [alice, bob]);
    const message = await posted(alice, workspace.id, channelId, '大事なお知らせ');
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

  afterAll(async () => {
    await app?.close();
    await postgres?.stop();
    await valkey?.stop();
    vi.unstubAllEnvs();
  });

  describe('付け外しと一覧', () => {
    it('参加者はピン留めでき、200 とメッセージ・ピン留めした人・時刻を返し、チャンネルのピン留めの一覧に載せる', async () => {
      const { bob, workspace, channelId, message } = await postedByAlice();

      const result = await pinned(bob, workspace.id, channelId, message.id);

      expect(result).toEqual({ message, pinnedBy: summaryOf(bob), pinnedAt: expect.any(String) });
      expect(Number.isNaN(Date.parse(result.pinnedAt))).toBe(false);
      expect(await pins(bob, workspace.id, channelId)).toEqual({ pins: [result] });
    });

    it('ピン留め済みのメッセージをもう一度ピン留めしても1件のままで、最初にピン留めした人と時刻を返す', async () => {
      const { alice, bob, workspace, channelId, message } = await postedByAlice();
      const first = await pinned(bob, workspace.id, channelId, message.id);

      const again = await pinned(alice, workspace.id, channelId, message.id);

      expect(again).toEqual(first);
      expect(await prisma.messagePin.count({ where: { channelId } })).toBe(1);
    });

    it('一覧はピン留めした新しい順で、そのチャンネルのものだけを返す。返信もピン留めできる', async () => {
      const { alice, bob, workspace, channelId, message } = await postedByAlice();
      const otherChannelId = await channelRow(workspace.id, 'PUBLIC', [alice, bob]);
      const elsewhere = await posted(alice, workspace.id, otherChannelId, '別のチャンネル');
      const later = await posted(bob, workspace.id, channelId, '後の投稿');
      const reply = await posted(bob, workspace.id, channelId, '返信', message.id);

      await pinned(alice, workspace.id, channelId, later.id);
      await pinned(alice, workspace.id, channelId, message.id);
      await pinned(alice, workspace.id, channelId, reply.id);
      await pinned(alice, workspace.id, otherChannelId, elsewhere.id);

      const { pins: found } = await pins(alice, workspace.id, channelId);
      expect(found.map((p) => p.message.id)).toEqual([reply.id, message.id, later.id]);
      expect(found[0]?.message.parentId).toBe(message.id);
    });

    it('ピン留めを外せるのは、ピン留めした本人に限らずそのチャンネルの参加者なら誰でもよく、204 を返して一覧から外す。ピン留めしていないメッセージを外しても 204', async () => {
      const { alice, bob, workspace, channelId, message } = await postedByAlice();
      await pinned(bob, workspace.id, channelId, message.id);

      const res = await pin('DELETE', alice, workspace.id, channelId, message.id);

      expect(res.status).toBe(204);
      expect(await pins(bob, workspace.id, channelId)).toEqual({ pins: [] });
      expect((await pin('DELETE', alice, workspace.id, channelId, message.id)).status).toBe(204);
    });

    it('削除したメッセージは、ピン留めの一覧に出さない', async () => {
      const { alice, workspace, channelId, message } = await postedByAlice();
      const kept = await posted(alice, workspace.id, channelId, '残る');
      await pinned(alice, workspace.id, channelId, message.id);
      await pinned(alice, workspace.id, channelId, kept.id);

      const deleted = await fetch(
        `${channelPath(workspace.id, channelId)}/messages/${message.id}`,
        {
          method: 'DELETE',
          headers: { authorization: alice.authorization },
        },
      );
      expect(deleted.status).toBe(204);

      const { pins: found } = await pins(alice, workspace.id, channelId);
      expect(found.map((p) => p.message.id)).toEqual([kept.id]);
    });

    it('ピン留めした人が退会したら、pinnedBy を null にして返す（機能一覧 1.5）', async () => {
      const { alice, bob, workspace, channelId, message } = await postedByAlice();
      await pinned(bob, workspace.id, channelId, message.id);

      await prisma.user.update({ where: { id: bob.id }, data: { deletedAt: new Date() } });

      const { pins: found } = await pins(alice, workspace.id, channelId);
      expect(found[0]?.pinnedBy).toBeNull();
    });

    it(`1つのチャンネルにピン留めできるのは ${PIN_LIMIT} 件までで、超えたら 409 pin_limit_reached で断る。削除したメッセージのピン留めは数えない`, async () => {
      const { alice, workspace, channelId, message } = await postedByAlice();
      // API を通さずに上限の手前まで作る（投稿の上限に当たらないため）
      const rows = Array.from({ length: PIN_LIMIT }, (_, i) => ({
        channelId,
        workspaceId: workspace.id,
        authorId: alice.id,
        body: `ピン留め ${i}`,
      }));
      await prisma.message.createMany({ data: rows });
      const created = await prisma.message.findMany({
        where: { channelId, id: { not: message.id } },
        select: { id: true },
      });
      await prisma.messagePin.createMany({
        data: created.map(({ id }) => ({ messageId: id, channelId, pinnedById: alice.id })),
      });

      const over = await pin('PUT', alice, workspace.id, channelId, message.id);
      expect(over.status).toBe(409);
      expect(await over.json()).toEqual({
        code: 'pin_limit_reached',
        message: 'このチャンネルにピン留めできる件数の上限に達しています',
      });

      // 1件を削除すると、その分は数えずにピン留めできる
      await prisma.message.update({
        where: { id: created[0]!.id },
        data: { deletedAt: new Date() },
      });
      expect((await pin('PUT', alice, workspace.id, channelId, message.id)).status).toBe(200);
    });
  });

  describe('断る相手', () => {
    it('所属していなければ、種別によらず付け外しと一覧を 404 で断り、書き込まない', async () => {
      for (const visibility of ['PUBLIC', 'PRIVATE'] as const) {
        const { alice, workspace, channelId, message } = await postedByAlice(visibility);
        await pinned(alice, workspace.id, channelId, message.id);
        const outsider = await login();

        for (const res of [
          await pin('PUT', outsider, workspace.id, channelId, message.id),
          await pin('DELETE', outsider, workspace.id, channelId, message.id),
          await list(outsider, workspace.id, channelId),
        ]) {
          expect(res.status).toBe(404);
          expect(await res.json()).toEqual(NOT_FOUND);
        }
        expect(await prisma.messagePin.count({ where: { channelId } })).toBe(1);
      }
    });

    it('所属していて参加していなければ、パブリックは 403 not_a_channel_member、プライベートは 404 で、付け外しも一覧も断る。オーナーでも同じ', async () => {
      for (const [visibility, status, body] of [
        ['PUBLIC', 403, NOT_A_CHANNEL_MEMBER],
        ['PRIVATE', 404, NOT_FOUND],
      ] as const) {
        const { owner, alice, carol, workspace, channelId, message } =
          await postedByAlice(visibility);
        await pinned(alice, workspace.id, channelId, message.id);
        for (const outsider of [carol, owner]) {
          for (const res of [
            await pin('PUT', outsider, workspace.id, channelId, message.id),
            await pin('DELETE', outsider, workspace.id, channelId, message.id),
            await list(outsider, workspace.id, channelId),
          ]) {
            expect(res.status).toBe(status);
            expect(await res.json()).toEqual(body);
          }
        }
        expect(await prisma.messagePin.count({ where: { channelId } })).toBe(1);
      }
    });

    it('無いメッセージ・別のチャンネルのメッセージ・削除済みのメッセージは、付け外しを 404 で断る', async () => {
      const { alice, bob, workspace, channelId, message } = await postedByAlice();
      const otherChannelId = await channelRow(workspace.id, 'PUBLIC', [alice, bob]);
      const elsewhere = await posted(alice, workspace.id, otherChannelId, '別のチャンネル');
      await pinned(bob, workspace.id, channelId, message.id);
      await fetch(`${channelPath(workspace.id, channelId)}/messages/${message.id}`, {
        method: 'DELETE',
        headers: { authorization: alice.authorization },
      });

      for (const messageId of [MISSING_ID, elsewhere.id, message.id]) {
        for (const method of ['PUT', 'DELETE'] as const) {
          const res = await pin(method, bob, workspace.id, channelId, messageId);
          expect(res.status).toBe(404);
          expect(await res.json()).toEqual(NOT_FOUND);
        }
      }
      expect(await prisma.messagePin.count({ where: { messageId: elsewhere.id } })).toBe(0);
    });

    it('アーカイブ済みのチャンネルでは、参加者でも付け外しを 409 channel_archived で断り、一覧は読める（機能一覧 3.2）', async () => {
      const { alice, bob, workspace, channelId, message } = await postedByAlice();
      const other = await posted(alice, workspace.id, channelId, 'もう1件');
      const first = await pinned(bob, workspace.id, channelId, message.id);
      await archive(channelId);

      for (const res of [
        await pin('PUT', alice, workspace.id, channelId, other.id),
        await pin('DELETE', alice, workspace.id, channelId, message.id),
      ]) {
        expect(res.status).toBe(409);
        expect(await res.json()).toEqual(CHANNEL_ARCHIVED);
      }
      expect(await pins(alice, workspace.id, channelId)).toEqual({ pins: [first] });
    });

    it(`付け外しは、同じ利用者で1分に ${PIN_WRITE_LIMIT} 回を超えたら 429 で断る。別の利用者は断らない`, async () => {
      const { alice, bob, workspace, channelId, message } = await postedByAlice();

      for (let i = 0; i < PIN_WRITE_LIMIT; i += 1) {
        expect((await pin('PUT', bob, workspace.id, channelId, message.id)).status).toBe(200);
      }
      expect((await pin('PUT', bob, workspace.id, channelId, message.id)).status).toBe(429);
      expect((await pin('PUT', alice, workspace.id, channelId, message.id)).status).toBe(200);
    }, 60_000);
  });
});
