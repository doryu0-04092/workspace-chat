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
import { POSTGRES_STARTUP_TIMEOUT_MS, startMigratedPostgres } from '../testing/postgres';
import { startValkey } from '../testing/valkey';

type Workspace = paths['/workspaces']['post']['responses'][201]['content']['application/json'];
type Message =
  paths['/workspaces/{id}/channels/{channelId}/messages']['post']['responses'][201]['content']['application/json'];
type NotificationPage =
  paths['/users/me/notifications']['get']['responses'][200]['content']['application/json'];

const NOT_FOUND = { code: 'not_found', message: '見つかりません' };
const MISSING_ID = '00000000-0000-7000-8000-000000000000';

let sequence = 0;
let ipSequence = 0;
function nextIp(): string {
  ipSequence += 1;
  return `2001:db8::e:${ipSequence.toString(16)}`;
}

type LoggedIn = { authorization: string; id: string; loginId: string; displayName: string };

// 機能一覧 10.3（F-26）: 受け取ったメンションを保存し、後から一覧で確かめ、既読化できる。#580。
// CLAUDE.md 2「認可はサーバー側が根拠」: 他の利用者の通知を読めない・既読にできない、参加していないチャンネルの通知を出さない。
describe('通知の一覧と既読化（F-26）', () => {
  let postgres: StartedPostgreSqlContainer;
  let valkey: StartedTestContainer;
  let app: INestApplication;
  let base: string;
  let prisma: PrismaService;

  async function login(): Promise<LoggedIn> {
    sequence += 1;
    const loginId = `Ntf_${Date.now().toString(36)}_${sequence}`;
    const displayName = `通知の人${sequence}`;
    const user = await prisma.user.create({
      data: { loginId, displayName, passwordHash: await hashSecret('notify-password') },
    });
    const res = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': nextIp() },
      body: JSON.stringify({ userId: loginId, password: 'notify-password' }),
    });
    expect(res.status).toBe(200);
    const { accessToken } = (await res.json()) as { accessToken: string };
    return { authorization: `Bearer ${accessToken}`, id: user.id, loginId, displayName };
  }

  async function workspaceWith(owner: LoggedIn, ...members: LoggedIn[]): Promise<Workspace> {
    const res = await fetch(`${base}/api/workspaces`, {
      method: 'POST',
      headers: { authorization: owner.authorization, 'content-type': 'application/json' },
      body: JSON.stringify({ name: '通知の場所' }),
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

  /** API を通さずにチャンネルを作る（参加者の組み合わせを自由に用意するため）。 */
  async function channelRow(
    workspaceId: string,
    visibility: 'PUBLIC' | 'PRIVATE',
    participants: LoggedIn[],
  ): Promise<{ id: string; name: string }> {
    sequence += 1;
    const name = `ntf-${sequence}`;
    const channel = await prisma.channel.create({
      data: { workspaceId, name, baseName: name, visibility },
    });
    for (const participant of participants) {
      await prisma.channelMember.create({
        data: { channelId: channel.id, workspaceId, userId: participant.id },
      });
    }
    return { id: channel.id, name };
  }

  function messagesPath(workspaceId: string, channelId: string): string {
    return `${base}/api/workspaces/${workspaceId}/channels/${channelId}/messages`;
  }

  async function send(
    method: 'POST' | 'PATCH',
    url: string,
    by: LoggedIn,
    body: string,
    status: number,
  ): Promise<Message> {
    const res = await fetch(url, {
      method,
      headers: { authorization: by.authorization, 'content-type': 'application/json' },
      body: JSON.stringify({ body }),
    });
    expect(res.status).toBe(status);
    return (await res.json()) as Message;
  }

  function posted(by: LoggedIn, workspaceId: string, channelId: string, body: string) {
    return send('POST', messagesPath(workspaceId, channelId), by, body, 201);
  }

  function replied(
    by: LoggedIn,
    workspaceId: string,
    channelId: string,
    parentId: string,
    body: string,
  ) {
    return send(
      'POST',
      `${messagesPath(workspaceId, channelId)}/${parentId}/replies`,
      by,
      body,
      201,
    );
  }

  function edited(
    by: LoggedIn,
    workspaceId: string,
    channelId: string,
    messageId: string,
    body: string,
  ) {
    return send('PATCH', `${messagesPath(workspaceId, channelId)}/${messageId}`, by, body, 200);
  }

  function list(by: LoggedIn, query = ''): Promise<Response> {
    return fetch(`${base}/api/users/me/notifications${query}`, {
      headers: { authorization: by.authorization },
    });
  }

  async function notificationsOf(by: LoggedIn, query = ''): Promise<NotificationPage> {
    const res = await list(by, query);
    expect(res.status).toBe(200);
    return (await res.json()) as NotificationPage;
  }

  function markRead(by: LoggedIn, notificationId: string): Promise<Response> {
    return fetch(`${base}/api/users/me/notifications/${notificationId}/read`, {
      method: 'PUT',
      headers: { authorization: by.authorization },
    });
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
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    prisma = app.get(PrismaService);
  }, POSTGRES_STARTUP_TIMEOUT_MS);

  afterAll(async () => {
    await app?.close();
    await postgres?.stop();
    await valkey?.stop();
    vi.unstubAllEnvs();
  });

  describe('保存と一覧', () => {
    it('メンションされると、接続していなくても通知が残り、一覧でワークスペース・チャンネル・メッセージと一緒に読める', async () => {
      const alice = await login();
      const bob = await login();
      const workspace = await workspaceWith(alice, bob);
      const channel = await channelRow(workspace.id, 'PUBLIC', [alice, bob]);

      const message = await posted(alice, workspace.id, channel.id, `@${bob.loginId} 見てください`);

      const { notifications, nextBefore } = await notificationsOf(bob);
      expect(nextBefore).toBeNull();
      expect(notifications).toEqual([
        {
          id: expect.any(String),
          kind: 'MENTION',
          createdAt: expect.any(String),
          readAt: null,
          workspace: { id: workspace.id, name: workspace.name },
          channel: { id: channel.id, name: channel.name },
          message,
        },
      ]);
    });

    it('スレッドの返信でメンションされても載り、メッセージは親の id を持つ', async () => {
      const alice = await login();
      const bob = await login();
      const workspace = await workspaceWith(alice, bob);
      const channel = await channelRow(workspace.id, 'PUBLIC', [alice, bob]);
      const parent = await posted(alice, workspace.id, channel.id, '親');

      await replied(alice, workspace.id, channel.id, parent.id, `@${bob.loginId} 返信`);

      const { notifications } = await notificationsOf(bob);
      expect(notifications.map((n) => n.message.parentId)).toEqual([parent.id]);
    });

    it('新しい順に返し、limit を超えた分は before で続きを取る', async () => {
      const alice = await login();
      const bob = await login();
      const workspace = await workspaceWith(alice, bob);
      const channel = await channelRow(workspace.id, 'PUBLIC', [alice, bob]);
      const bodies = ['1つ目', '2つ目', '3つ目'];
      for (const body of bodies)
        await posted(alice, workspace.id, channel.id, `@${bob.loginId} ${body}`);

      const first = await notificationsOf(bob, '?limit=2');
      expect(first.notifications.map((n) => n.message.body)).toEqual([
        `@${bob.loginId} 3つ目`,
        `@${bob.loginId} 2つ目`,
      ]);
      expect(first.nextBefore).toBe(first.notifications[1]?.id);

      const rest = await notificationsOf(bob, `?limit=2&before=${first.nextBefore}`);
      expect(rest.notifications.map((n) => n.message.body)).toEqual([`@${bob.loginId} 1つ目`]);
      expect(rest.nextBefore).toBeNull();
    });

    it('自分で自分をメンションしても、自分の通知にはしない', async () => {
      const alice = await login();
      const workspace = await workspaceWith(alice);
      const channel = await channelRow(workspace.id, 'PUBLIC', [alice]);

      await posted(alice, workspace.id, channel.id, `@${alice.loginId} メモ`);

      expect((await notificationsOf(alice)).notifications).toEqual([]);
    });

    it('他の利用者の通知は一覧に混ざらない（メンションされていない参加者には何も載らない）', async () => {
      const alice = await login();
      const bob = await login();
      const carol = await login();
      const workspace = await workspaceWith(alice, bob, carol);
      const channel = await channelRow(workspace.id, 'PUBLIC', [alice, bob, carol]);

      await posted(alice, workspace.id, channel.id, `@${bob.loginId} だけ`);

      expect((await notificationsOf(bob)).notifications).toHaveLength(1);
      expect((await notificationsOf(carol)).notifications).toEqual([]);
    });

    it('削除されたメッセージの通知は出さない', async () => {
      const alice = await login();
      const bob = await login();
      const workspace = await workspaceWith(alice, bob);
      const channel = await channelRow(workspace.id, 'PUBLIC', [alice, bob]);
      const message = await posted(alice, workspace.id, channel.id, `@${bob.loginId} 消す`);

      const res = await fetch(`${messagesPath(workspace.id, channel.id)}/${message.id}`, {
        method: 'DELETE',
        headers: { authorization: alice.authorization },
      });
      expect(res.status).toBe(204);

      expect((await notificationsOf(bob)).notifications).toEqual([]);
    });

    it('編集でメンションを外すと通知が消え、編集で足すと通知が載る', async () => {
      const alice = await login();
      const bob = await login();
      const carol = await login();
      const workspace = await workspaceWith(alice, bob, carol);
      const channel = await channelRow(workspace.id, 'PUBLIC', [alice, bob, carol]);
      const message = await posted(alice, workspace.id, channel.id, `@${bob.loginId} へ`);

      await edited(alice, workspace.id, channel.id, message.id, `@${carol.loginId} へ`);

      expect((await notificationsOf(bob)).notifications).toEqual([]);
      expect((await notificationsOf(carol)).notifications.map((n) => n.message.id)).toEqual([
        message.id,
      ]);
    });

    it('編集で本文にメンションを残した対象の通知は、既読のまま残す（作り直さない）', async () => {
      const alice = await login();
      const bob = await login();
      const workspace = await workspaceWith(alice, bob);
      const channel = await channelRow(workspace.id, 'PUBLIC', [alice, bob]);
      const message = await posted(alice, workspace.id, channel.id, `@${bob.loginId} へ`);
      const [notification] = (await notificationsOf(bob)).notifications;
      expect((await markRead(bob, notification?.id ?? '')).status).toBe(204);

      await edited(alice, workspace.id, channel.id, message.id, `@${bob.loginId} へ（直した）`);

      const [after] = (await notificationsOf(bob)).notifications;
      expect(after?.id).toBe(notification?.id);
      expect(after?.readAt).not.toBeNull();
    });

    // CLAUDE.md 2: プライベートチャンネルは非参加者に渡さない。**抜けた・外された後は、そのチャンネルの通知を出さない**。
    it('参加していない（外された）プライベートチャンネルの通知は出さず、既読化も 404', async () => {
      const alice = await login();
      const bob = await login();
      const workspace = await workspaceWith(alice, bob);
      const channel = await channelRow(workspace.id, 'PRIVATE', [alice, bob]);
      await posted(alice, workspace.id, channel.id, `@${bob.loginId} 秘密の話`);
      const [notification] = (await notificationsOf(bob)).notifications;
      expect(notification).toBeDefined();

      await prisma.channelMember.delete({
        where: { channelId_userId: { channelId: channel.id, userId: bob.id } },
      });

      expect((await notificationsOf(bob)).notifications).toEqual([]);
      const res = await markRead(bob, notification?.id ?? '');
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual(NOT_FOUND);
    });

    it('ワークスペースから外れたら、そのワークスペースの通知は出さない', async () => {
      const alice = await login();
      const bob = await login();
      const workspace = await workspaceWith(alice, bob);
      const channel = await channelRow(workspace.id, 'PUBLIC', [alice, bob]);
      await posted(alice, workspace.id, channel.id, `@${bob.loginId} 見て`);

      await prisma.membership.delete({
        where: { workspaceId_userId: { workspaceId: workspace.id, userId: bob.id } },
      });

      expect((await notificationsOf(bob)).notifications).toEqual([]);
    });

    it('limit と before の形が仕様に合わなければ 400', async () => {
      const bob = await login();

      expect((await list(bob, '?limit=0')).status).toBe(400);
      expect((await list(bob, '?before=x')).status).toBe(400);
    });

    it('トークンが無ければ 401', async () => {
      expect((await fetch(`${base}/api/users/me/notifications`)).status).toBe(401);
    });
  });

  describe('既読化', () => {
    it('既読にすると 204 を返し、一覧の readAt が入る。2回目も 204 で、最初の時刻を変えない', async () => {
      const alice = await login();
      const bob = await login();
      const workspace = await workspaceWith(alice, bob);
      const channel = await channelRow(workspace.id, 'PUBLIC', [alice, bob]);
      await posted(alice, workspace.id, channel.id, `@${bob.loginId} 読んで`);
      const [notification] = (await notificationsOf(bob)).notifications;

      expect((await markRead(bob, notification?.id ?? '')).status).toBe(204);
      const [read] = (await notificationsOf(bob)).notifications;
      expect(read?.readAt).toEqual(expect.any(String));

      expect((await markRead(bob, notification?.id ?? '')).status).toBe(204);
      const [again] = (await notificationsOf(bob)).notifications;
      expect(again?.readAt).toBe(read?.readAt);
    });

    // CLAUDE.md 2: 他の利用者の通知は、存在も認めない（404。本体も揃える）。
    it('他の利用者の通知は既読にできず 404（同じチャンネルの参加者でも）', async () => {
      const alice = await login();
      const bob = await login();
      const workspace = await workspaceWith(alice, bob);
      const channel = await channelRow(workspace.id, 'PUBLIC', [alice, bob]);
      await posted(bob, workspace.id, channel.id, `@${alice.loginId} 見て`);
      const [forAlice] = (await notificationsOf(alice)).notifications;

      const res = await markRead(bob, forAlice?.id ?? '');

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual(NOT_FOUND);
      const [still] = (await notificationsOf(alice)).notifications;
      expect(still?.readAt).toBeNull();
    });

    it('存在しない通知は 404、id の形が uuid でなければ 400', async () => {
      const bob = await login();

      const missing = await markRead(bob, MISSING_ID);
      expect(missing.status).toBe(404);
      expect(await missing.json()).toEqual(NOT_FOUND);
      expect((await markRead(bob, 'not-a-uuid')).status).toBe(400);
    });
  });
});
