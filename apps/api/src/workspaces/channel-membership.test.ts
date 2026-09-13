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
type Channel =
  paths['/workspaces/{id}/channels']['get']['responses'][200]['content']['application/json'][number];
type ErrorResponse =
  paths['/workspaces/{id}/channels/{channelId}/members']['post']['responses'][409]['content']['application/json'];

const NOT_FOUND = { code: 'not_found', message: '見つかりません' };
const MISSING_ID = '00000000-0000-7000-8000-000000000000';

let sequence = 0;
let ipSequence = 0;
function nextIp(): string {
  ipSequence += 1;
  return `2001:db8::d:${ipSequence.toString(16)}`;
}

type LoggedIn = { authorization: string; id: string };

// 機能一覧 2.2（チャンネルからのキック・プライベートチャンネルへの招待）・3.1（パブリックは自由に参加・退出できる）・3.2（アーカイブ後）。
// 決定・2026-09-12・依頼側（#335）: プライベートチャンネルへの招待は招待した時点で参加させ、参加者は自分の意思で退出できる。
describe('チャンネルへの参加・退出・招待・キック（F-10・F-08・F-09）', () => {
  let postgres: StartedPostgreSqlContainer;
  let valkey: StartedTestContainer;
  let app: INestApplication;
  let base: string;
  let prisma: PrismaService;

  async function login(): Promise<LoggedIn> {
    sequence += 1;
    const loginId = `Cm_${Date.now().toString(36)}_${sequence}`;
    const user = await prisma.user.create({
      data: {
        loginId,
        displayName: `参加する人${sequence}`,
        passwordHash: await hashSecret('membership-password'),
      },
    });
    const res = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': nextIp() },
      body: JSON.stringify({ userId: loginId, password: 'membership-password' }),
    });
    expect(res.status).toBe(200);
    const { accessToken } = (await res.json()) as { accessToken: string };
    return { authorization: `Bearer ${accessToken}`, id: user.id };
  }

  function send(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    by: LoggedIn,
    body?: unknown,
  ): Promise<Response> {
    return fetch(`${base}/api${path}`, {
      method,
      headers: {
        authorization: by.authorization,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  /** オーナーのワークスペースを作り、渡した利用者をメンバーとして参加させる。 */
  async function workspaceWith(owner: LoggedIn, ...members: LoggedIn[]): Promise<Workspace> {
    const res = await send('POST', '/workspaces', owner, { name: '参加の場所' });
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
    name: string,
    visibility: 'PUBLIC' | 'PRIVATE',
    participants: LoggedIn[],
    archived = false,
  ): Promise<string> {
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

  async function participantsOf(channelId: string): Promise<string[]> {
    const rows = await prisma.channelMember.findMany({
      where: { channelId },
      select: { userId: true },
    });
    return rows.map((row) => row.userId).sort();
  }

  const ids = (...users: LoggedIn[]): string[] => users.map((user) => user.id).sort();

  async function expectRejected(res: Response, status: number, code: string): Promise<void> {
    expect(res.status).toBe(status);
    // 404 の本体は存在の有無を区別しない（ErrorResponseFilter）。
    if (status === 404) expect(await res.json()).toEqual(NOT_FOUND);
    else expect(((await res.json()) as ErrorResponse).code).toBe(code);
  }

  const join = (by: LoggedIn, workspaceId: string, channelId: string) =>
    send('POST', `/workspaces/${workspaceId}/channels/${channelId}/join`, by);
  const leave = (by: LoggedIn, workspaceId: string, channelId: string) =>
    send('POST', `/workspaces/${workspaceId}/channels/${channelId}/leave`, by);
  const invite = (by: LoggedIn, workspaceId: string, channelId: string, memberId: string) =>
    send('POST', `/workspaces/${workspaceId}/channels/${channelId}/members`, by, { memberId });
  const kick = (by: LoggedIn, workspaceId: string, channelId: string, memberId: string) =>
    send('DELETE', `/workspaces/${workspaceId}/channels/${channelId}/members/${memberId}`, by);

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

  describe('パブリックチャンネルへの参加', () => {
    it('メンバーはパブリックチャンネルに自由に参加でき、一般の一覧で参加済みになる', async () => {
      const owner = await login();
      const member = await login();
      const workspace = await workspaceWith(owner, member);
      const open = await channelRow(workspace.id, 'open', 'PUBLIC', [owner]);

      expect((await join(member, workspace.id, open)).status).toBe(204);
      expect(await participantsOf(open)).toEqual(ids(owner, member));
      const list = await send('GET', `/workspaces/${workspace.id}/channels`, member);
      expect(((await list.json()) as Channel[]).find((c) => c.id === open)?.joined).toBe(true);
    });

    it('既に参加していれば 409（already_channel_member）', async () => {
      const owner = await login();
      const workspace = await workspaceWith(owner);
      const open = await channelRow(workspace.id, 'open', 'PUBLIC', [owner]);

      await expectRejected(await join(owner, workspace.id, open), 409, 'already_channel_member');
    });

    // プライベートチャンネルには招待で参加する（機能一覧 2.2）。参加していなければ存在を隠す（CLAUDE.md 2。オーナーの例外は一覧・取得 API とアーカイブ・復元の応答だけ）。
    it('プライベートチャンネルは、参加していなければオーナーでも 404 で、参加は作られない', async () => {
      const owner = await login();
      const member = await login();
      const insider = await login();
      const workspace = await workspaceWith(owner, member, insider);
      const secret = await channelRow(workspace.id, 'secret', 'PRIVATE', [insider]);

      for (const who of [member, owner]) {
        await expectRejected(await join(who, workspace.id, secret), 404, 'not_found');
      }
      await expectRejected(
        await join(insider, workspace.id, secret),
        409,
        'already_channel_member',
      );
      expect(await participantsOf(secret)).toEqual(ids(insider));
    });

    // 機能一覧 3.2: アーカイブ後は参加・招待もできない（#335）。
    it('アーカイブ済みのパブリックチャンネルには参加できない（409 channel_archived）。アーカイブ済みのプライベートは、参加していなければ 404 のまま', async () => {
      const owner = await login();
      const member = await login();
      const workspace = await workspaceWith(owner, member);
      const old = await channelRow(workspace.id, 'old', 'PUBLIC', [owner], true);
      const oldSecret = await channelRow(workspace.id, 'old-secret', 'PRIVATE', [owner], true);

      await expectRejected(await join(member, workspace.id, old), 409, 'channel_archived');
      expect(await participantsOf(old)).toEqual(ids(owner));
      await expectRejected(await join(member, workspace.id, oldSecret), 404, 'not_found');
    });

    it('所属していなければ 404。別のワークスペースのチャンネル・無いチャンネルも 404', async () => {
      const owner = await login();
      const outsider = await login();
      const workspace = await workspaceWith(owner);
      const other = await workspaceWith(outsider);
      const open = await channelRow(workspace.id, 'open', 'PUBLIC', []);
      const elsewhere = await channelRow(other.id, 'elsewhere', 'PUBLIC', []);
      // DB の複合外部キーは別のワークスペースのチャンネルへの参加を拒むが、コードは拒まない。アーカイブ済みなら 409 で存在が漏れる。
      const archivedElsewhere = await channelRow(other.id, 'old-elsewhere', 'PUBLIC', [], true);

      await expectRejected(await join(outsider, workspace.id, open), 404, 'not_found');
      for (const channel of [elsewhere, archivedElsewhere, MISSING_ID]) {
        await expectRejected(await join(owner, workspace.id, channel), 404, 'not_found');
      }
      expect(await participantsOf(open)).toEqual([]);
      expect(await participantsOf(elsewhere)).toEqual([]);
    });
  });

  describe('チャンネルからの退出', () => {
    it('パブリックでもプライベートでも、参加者（オーナーを含む）は自分だけが抜けられる', async () => {
      const owner = await login();
      const member = await login();
      const workspace = await workspaceWith(owner, member);
      const open = await channelRow(workspace.id, 'open', 'PUBLIC', [owner, member]);
      const secret = await channelRow(workspace.id, 'secret', 'PRIVATE', [owner, member]);

      expect((await leave(member, workspace.id, open)).status).toBe(204);
      expect((await leave(member, workspace.id, secret)).status).toBe(204);
      expect((await leave(owner, workspace.id, open)).status).toBe(204);
      expect(await participantsOf(open)).toEqual([]);
      expect(await participantsOf(secret)).toEqual(ids(owner));
      // ワークスペースの所属は残る（チャンネルだけから抜ける）。
      expect(await prisma.membership.count({ where: { workspaceId: workspace.id } })).toBe(2);
    });

    it('プライベートチャンネルを抜けた後は、一覧にも参加者一覧にも出ず、参加し直せない（戻るには招待が要る）', async () => {
      const owner = await login();
      const member = await login();
      const workspace = await workspaceWith(owner, member);
      const secret = await channelRow(workspace.id, 'secret', 'PRIVATE', [owner, member]);

      expect((await leave(member, workspace.id, secret)).status).toBe(204);
      const list = await send('GET', `/workspaces/${workspace.id}/channels`, member);
      expect(((await list.json()) as Channel[]).map((c) => c.id)).not.toContain(secret);
      await expectRejected(
        await send('GET', `/workspaces/${workspace.id}/channels/${secret}/members`, member),
        404,
        'not_found',
      );
      await expectRejected(await join(member, workspace.id, secret), 404, 'not_found');
    });

    it('アーカイブ済みのチャンネルからも抜けられる', async () => {
      const owner = await login();
      const member = await login();
      const workspace = await workspaceWith(owner, member);
      const old = await channelRow(workspace.id, 'old', 'PRIVATE', [owner, member], true);

      expect((await leave(member, workspace.id, old)).status).toBe(204);
      expect(await participantsOf(old)).toEqual(ids(owner));
    });

    it('参加していなければパブリック・プライベートとも 404、所属していなければ 404。別のワークスペースのチャンネルからは、その経路では抜けられない', async () => {
      const owner = await login();
      const member = await login();
      const outsider = await login();
      const workspace = await workspaceWith(owner, member);
      const other = await workspaceWith(outsider, member);
      const open = await channelRow(workspace.id, 'open', 'PUBLIC', [owner]);
      const secret = await channelRow(workspace.id, 'secret', 'PRIVATE', [owner]);
      const elsewhere = await channelRow(other.id, 'elsewhere', 'PUBLIC', [member]);

      for (const channel of [open, secret, MISSING_ID, elsewhere]) {
        await expectRejected(await leave(member, workspace.id, channel), 404, 'not_found');
      }
      await expectRejected(await leave(outsider, workspace.id, open), 404, 'not_found');
      expect(await participantsOf(open)).toEqual(ids(owner));
      expect(await participantsOf(elsewhere)).toEqual(ids(member));
    });
  });

  describe('プライベートチャンネルへの招待', () => {
    it('参加者なら（オーナーでなくても）招待でき、招待した時点で参加する', async () => {
      const owner = await login();
      const inviter = await login();
      const invitee = await login();
      const workspace = await workspaceWith(owner, inviter, invitee);
      const secret = await channelRow(workspace.id, 'secret', 'PRIVATE', [inviter]);

      expect((await invite(inviter, workspace.id, secret, invitee.id)).status).toBe(204);
      expect(await participantsOf(secret)).toEqual(ids(inviter, invitee));
      const list = await send('GET', `/workspaces/${workspace.id}/channels`, invitee);
      expect(((await list.json()) as Channel[]).find((c) => c.id === secret)?.joined).toBe(true);
    });

    // 機能一覧 2.2「プライベートチャンネルへの招待で、ワークスペース外の利用者は指定できない」・1.5（退会者を参加者に残さない）。
    it('宛先がワークスペースのメンバーでない・退会済み・存在しないなら 422（invitee_not_found）で、参加は作られない', async () => {
      const inviter = await login();
      const outsider = await login();
      const withdrawn = await login();
      const workspace = await workspaceWith(inviter, withdrawn);
      await workspaceWith(outsider);
      const secret = await channelRow(workspace.id, 'secret', 'PRIVATE', [inviter]);
      await prisma.user.update({ where: { id: withdrawn.id }, data: { deletedAt: new Date() } });

      for (const target of [outsider.id, withdrawn.id, MISSING_ID]) {
        await expectRejected(
          await invite(inviter, workspace.id, secret, target),
          422,
          'invitee_not_found',
        );
      }
      expect(await participantsOf(secret)).toEqual(ids(inviter));
    });

    it('宛先が既に参加していれば 409（already_channel_member）', async () => {
      const owner = await login();
      const member = await login();
      const workspace = await workspaceWith(owner, member);
      const secret = await channelRow(workspace.id, 'secret', 'PRIVATE', [owner, member]);

      await expectRejected(
        await invite(owner, workspace.id, secret, member.id),
        409,
        'already_channel_member',
      );
    });

    // 招待できるのはそのチャンネルの参加者だけ（機能一覧 2.2）。オーナーの例外は一覧・取得 API とアーカイブ・復元の応答だけに及ぶ（CLAUDE.md 2）。
    it('要求する側が参加していなければ、プライベートはオーナーでも 404。所属していなければ 404', async () => {
      const owner = await login();
      const member = await login();
      const insider = await login();
      const outsider = await login();
      const workspace = await workspaceWith(owner, member, insider);
      const secret = await channelRow(workspace.id, 'secret', 'PRIVATE', [insider]);

      await expectRejected(await invite(owner, workspace.id, secret, member.id), 404, 'not_found');
      await expectRejected(await invite(member, workspace.id, secret, owner.id), 404, 'not_found');
      await expectRejected(
        await invite(outsider, workspace.id, secret, member.id),
        404,
        'not_found',
      );
      expect(await participantsOf(secret)).toEqual(ids(insider));
    });

    it('パブリックチャンネルへは招待しない: 参加者なら 422（channel_not_private）、参加していなければ 403（not_a_channel_member）', async () => {
      const owner = await login();
      const member = await login();
      const bystander = await login();
      const workspace = await workspaceWith(owner, member, bystander);
      const open = await channelRow(workspace.id, 'open', 'PUBLIC', [owner]);

      await expectRejected(
        await invite(owner, workspace.id, open, member.id),
        422,
        'channel_not_private',
      );
      await expectRejected(
        await invite(bystander, workspace.id, open, member.id),
        403,
        'not_a_channel_member',
      );
      expect(await participantsOf(open)).toEqual(ids(owner));
    });

    it('アーカイブ済みのプライベートチャンネルには招待できない（409 channel_archived）', async () => {
      const owner = await login();
      const member = await login();
      const workspace = await workspaceWith(owner, member);
      const old = await channelRow(workspace.id, 'old', 'PRIVATE', [owner], true);

      await expectRejected(
        await invite(owner, workspace.id, old, member.id),
        409,
        'channel_archived',
      );
      expect(await participantsOf(old)).toEqual(ids(owner));
    });
  });

  describe('チャンネルからのキック（F-09）', () => {
    it('オーナーは参加者をそのチャンネルだけから外せる（他のチャンネルの参加とワークスペースの所属は残る）', async () => {
      const owner = await login();
      const member = await login();
      const workspace = await workspaceWith(owner, member);
      const first = await channelRow(workspace.id, 'first', 'PUBLIC', [owner, member]);
      const second = await channelRow(workspace.id, 'second', 'PUBLIC', [member]);

      expect((await kick(owner, workspace.id, first, member.id)).status).toBe(204);
      expect(await participantsOf(first)).toEqual(ids(owner));
      expect(await participantsOf(second)).toEqual(ids(member));
      expect(
        await prisma.membership.count({ where: { workspaceId: workspace.id, userId: member.id } }),
      ).toBe(1);
    });

    // 機能一覧 3.1「参加者一覧だけを見せる理由」: オーナーは参加していなくても、キックすべき相手を特定して外せる。
    it('オーナーは、参加していないプライベートチャンネル・アーカイブ済みのチャンネルからも外せる', async () => {
      const owner = await login();
      const member = await login();
      const workspace = await workspaceWith(owner, member);
      const secret = await channelRow(workspace.id, 'secret', 'PRIVATE', [member]);
      const old = await channelRow(workspace.id, 'old', 'PUBLIC', [member], true);

      for (const channel of [secret, old]) {
        expect((await kick(owner, workspace.id, channel, member.id)).status).toBe(204);
        expect(await participantsOf(channel)).toEqual([]);
      }
    });

    // CLAUDE.md「必ずテストを書く箇所」: メンバーがオーナー専用の操作を実行できないこと。
    it('オーナーでないメンバーは、参加しているチャンネルでも 403（owner_only）で、外れない', async () => {
      const owner = await login();
      const member = await login();
      const other = await login();
      const workspace = await workspaceWith(owner, member, other);
      const open = await channelRow(workspace.id, 'open', 'PUBLIC', [member, other]);
      const secret = await channelRow(workspace.id, 'secret', 'PRIVATE', [member, other]);

      for (const channel of [open, secret]) {
        await expectRejected(
          await kick(member, workspace.id, channel, other.id),
          403,
          'owner_only',
        );
        expect(await participantsOf(channel)).toEqual(ids(member, other));
      }
    });

    it('所属していなければ 404。チャンネルが無い・別のワークスペースのチャンネル・相手が参加していなければ 404', async () => {
      const owner = await login();
      const member = await login();
      const outsider = await login();
      const workspace = await workspaceWith(owner, member);
      const other = await workspaceWith(outsider, member);
      const open = await channelRow(workspace.id, 'open', 'PUBLIC', [owner]);
      const elsewhere = await channelRow(other.id, 'elsewhere', 'PUBLIC', [member]);

      await expectRejected(await kick(outsider, workspace.id, open, owner.id), 404, 'not_found');
      await expectRejected(await kick(owner, workspace.id, open, member.id), 404, 'not_found');
      for (const channel of [elsewhere, MISSING_ID]) {
        await expectRejected(await kick(owner, workspace.id, channel, member.id), 404, 'not_found');
      }
      expect(await participantsOf(elsewhere)).toEqual(ids(member));
    });
  });
});
