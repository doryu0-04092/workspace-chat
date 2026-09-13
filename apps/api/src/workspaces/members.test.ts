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
type WorkspaceMember =
  paths['/workspaces/{id}/members']['get']['responses'][200]['content']['application/json'][number];
type ErrorResponse =
  paths['/workspaces/{id}/leave']['post']['responses'][403]['content']['application/json'];

const NOT_FOUND = { code: 'not_found', message: '見つかりません' };
const MISSING_ID = '00000000-0000-7000-8000-000000000000';

let sequence = 0;
let ipSequence = 0;
function nextIp(): string {
  ipSequence += 1;
  return `2001:db8::b:${ipSequence.toString(16)}`;
}

type LoggedIn = { authorization: string; id: string; loginId: string };

// 機能一覧 2.2（F-09 のワークスペースからのキック）・招待の承諾と退出（F-38 の退出）。#330。
// 接続をチャンネルの部屋から外すことは realtime/channel-rooms.test.ts が確かめる（サーバーを2つ立てる必要があるため）。
describe('ワークスペースからのキックと退出（F-09 / F-38）', () => {
  let postgres: StartedPostgreSqlContainer;
  let valkey: StartedTestContainer;
  let app: INestApplication;
  let base: string;
  let prisma: PrismaService;

  async function login(): Promise<LoggedIn> {
    sequence += 1;
    const loginId = `Kick_${Date.now().toString(36)}_${sequence}`;
    const user = await prisma.user.create({
      data: {
        loginId,
        displayName: `抜ける人${sequence}`,
        passwordHash: await hashSecret('kick-password'),
      },
    });
    const res = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': nextIp() },
      body: JSON.stringify({ userId: loginId, password: 'kick-password' }),
    });
    expect(res.status).toBe(200);
    const { accessToken } = (await res.json()) as { accessToken: string };
    return { authorization: `Bearer ${accessToken}`, id: user.id, loginId };
  }

  function request(
    method: 'GET' | 'POST' | 'DELETE',
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

  /** オーナーのワークスペースを作り、渡した利用者をメンバーとして参加させる。 */
  async function workspaceWith(owner: LoggedIn, ...members: LoggedIn[]): Promise<Workspace> {
    const res = await request('POST', '/workspaces', owner.authorization, { name: '抜ける場所' });
    expect(res.status).toBe(201);
    const workspace = (await res.json()) as Workspace;
    for (const member of members) {
      await prisma.membership.create({
        data: { workspaceId: workspace.id, userId: member.id, role: 'MEMBER' },
      });
    }
    return workspace;
  }

  function kick(by: LoggedIn, workspaceId: string, memberId: string): Promise<Response> {
    return request('DELETE', `/workspaces/${workspaceId}/members/${memberId}`, by.authorization);
  }

  function leave(by: LoggedIn, workspaceId: string): Promise<Response> {
    return request('POST', `/workspaces/${workspaceId}/leave`, by.authorization);
  }

  async function memberIds(viewer: LoggedIn, workspaceId: string): Promise<string[]> {
    const res = await request('GET', `/workspaces/${workspaceId}/members`, viewer.authorization);
    expect(res.status).toBe(200);
    return ((await res.json()) as WorkspaceMember[]).map((m) => m.id);
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

  afterAll(async () => {
    await app?.close();
    await postgres?.stop();
    await valkey?.stop();
    vi.unstubAllEnvs();
  });

  describe('キック（F-09）', () => {
    it('オーナーはメンバーをキックでき、キックされた利用者はそのワークスペースのデータを取得できなくなる（404）', async () => {
      const owner = await login();
      const member = await login();
      const workspace = await workspaceWith(owner, member);

      expect((await kick(owner, workspace.id, member.id)).status).toBe(204);

      const after = await request('GET', `/workspaces/${workspace.id}`, member.authorization);
      expect(after.status).toBe(404);
      expect(await after.json()).toEqual(NOT_FOUND);
      expect(await memberIds(owner, workspace.id)).toEqual([owner.id]);
    });

    // 機能一覧 2.2「キックされた利用者は、所属していた全チャンネルから自動的に外れる」（ChannelMember は Membership の連鎖で消える）。
    it('キックされた利用者は、そのワークスペースの全チャンネルから外れ、他のワークスペースの参加は残る', async () => {
      const owner = await login();
      const member = await login();
      const workspace = await workspaceWith(owner, member);
      const other = await workspaceWith(owner, member);
      for (const [workspaceId, name] of [
        [workspace.id, 'general'],
        [other.id, 'general'],
      ] as const) {
        const channel = await prisma.channel.create({
          data: { workspaceId, name, baseName: name, visibility: 'PUBLIC' },
        });
        await prisma.channelMember.create({
          data: { channelId: channel.id, workspaceId, userId: member.id },
        });
      }

      expect((await kick(owner, workspace.id, member.id)).status).toBe(204);

      expect(
        await prisma.channelMember.count({
          where: { workspaceId: workspace.id, userId: member.id },
        }),
      ).toBe(0);
      expect(
        await prisma.channelMember.count({ where: { workspaceId: other.id, userId: member.id } }),
      ).toBe(1);
      expect((await request('GET', `/workspaces/${other.id}`, member.authorization)).status).toBe(
        200,
      );
    });

    // CLAUDE.md「必ずテストを書く箇所」: メンバーがオーナー専用の操作を実行できないこと。
    it('オーナーでないメンバーがキックすると 403（owner_only）で、誰も外れない', async () => {
      const owner = await login();
      const member = await login();
      const another = await login();
      const workspace = await workspaceWith(owner, member, another);

      const res = await kick(member, workspace.id, another.id);
      expect(res.status).toBe(403);
      expect(((await res.json()) as ErrorResponse).code).toBe('owner_only');
      expect((await kick(member, workspace.id, owner.id)).status).toBe(403);
      expect(await memberIds(owner, workspace.id)).toHaveLength(3);
    });

    it('所属していないワークスペースでのキックは、存在の有無によらず 404', async () => {
      const owner = await login();
      const member = await login();
      const outsider = await login();
      const workspace = await workspaceWith(owner, member);

      const others = await kick(outsider, workspace.id, member.id);
      expect(others.status).toBe(404);
      expect(await others.json()).toEqual(NOT_FOUND);
      expect((await kick(outsider, MISSING_ID, member.id)).status).toBe(404);
      expect(await memberIds(owner, workspace.id)).toHaveLength(2);
    });

    it('メンバーでない利用者・存在しない id をキックすると 404', async () => {
      const owner = await login();
      const outsider = await login();
      const workspace = await workspaceWith(owner);

      for (const memberId of [outsider.id, MISSING_ID]) {
        const res = await kick(owner, workspace.id, memberId);
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual(NOT_FOUND);
      }
    });

    it('オーナーは自分をキックできない（403 owner_cannot_leave）', async () => {
      const owner = await login();
      const workspace = await workspaceWith(owner);

      const res = await kick(owner, workspace.id, owner.id);
      expect(res.status).toBe(403);
      expect(((await res.json()) as ErrorResponse).code).toBe('owner_cannot_leave');
      expect(await memberIds(owner, workspace.id)).toEqual([owner.id]);
    });
  });

  describe('退出（F-38）', () => {
    it('メンバーは自分の意思で退出でき、以後そのワークスペースのデータを取得できない（404）', async () => {
      const owner = await login();
      const member = await login();
      const workspace = await workspaceWith(owner, member);

      expect((await leave(member, workspace.id)).status).toBe(204);

      expect(
        (await request('GET', `/workspaces/${workspace.id}`, member.authorization)).status,
      ).toBe(404);
      expect(await memberIds(owner, workspace.id)).toEqual([owner.id]);
    });

    // 機能一覧 F-38「オーナーが退出しようとすると拒否され、理由が画面に表示される」。
    it('オーナーが退出しようとすると 403（owner_cannot_leave）で、理由のメッセージを返し、所属は残る', async () => {
      const owner = await login();
      const workspace = await workspaceWith(owner);

      const res = await leave(owner, workspace.id);
      expect(res.status).toBe(403);
      const body = (await res.json()) as ErrorResponse;
      expect(body.code).toBe('owner_cannot_leave');
      expect(body.message.length).toBeGreaterThan(0);
      expect(
        (await request('GET', `/workspaces/${workspace.id}`, owner.authorization)).status,
      ).toBe(200);
    });

    it('所属していないワークスペースからの退出は、存在の有無によらず 404', async () => {
      const owner = await login();
      const outsider = await login();
      const workspace = await workspaceWith(owner);

      for (const workspaceId of [workspace.id, MISSING_ID]) {
        const res = await leave(outsider, workspaceId);
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual(NOT_FOUND);
      }
    });

    it('キック・退出の後、オーナーは同じ利用者を再度招待できる', async () => {
      const owner = await login();
      const kicked = await login();
      const left = await login();
      const workspace = await workspaceWith(owner, kicked, left);

      expect((await kick(owner, workspace.id, kicked.id)).status).toBe(204);
      expect((await leave(left, workspace.id)).status).toBe(204);
      for (const target of [kicked, left]) {
        const res = await request(
          'POST',
          `/workspaces/${workspace.id}/invitations`,
          owner.authorization,
          { userId: target.loginId },
        );
        expect(res.status).toBe(201);
      }
    });
  });
});
