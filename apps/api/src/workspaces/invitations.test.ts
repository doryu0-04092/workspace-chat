import 'reflect-metadata';
import type { AddressInfo } from 'node:net';
import { type INestApplication, NotFoundException } from '@nestjs/common';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { paths } from '@workspace-chat/shared';
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
import { InvitationsService } from './invitations.service';

type Workspace = paths['/workspaces']['post']['responses'][201]['content']['application/json'];
type Invitation =
  paths['/workspaces/{id}/invitations']['post']['responses'][201]['content']['application/json'];
type MyInvitation =
  paths['/invitations']['get']['responses'][200]['content']['application/json'][number];
type ErrorResponse =
  paths['/workspaces/{id}/invitations']['post']['responses'][409]['content']['application/json'];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const NOT_FOUND = { code: 'not_found', message: '見つかりません' };

let sequence = 0;
let ipSequence = 0;
function nextIp(): string {
  ipSequence += 1;
  return `2001:db8::a:${ipSequence.toString(16)}`;
}

type LoggedIn = { authorization: string; token: string; id: string; loginId: string };

// 機能一覧 2.2（F-08）・招待の承諾と退出（F-38）。
// 決定・2026-09-12・依頼側（#326）: 招待された側への通知はリアルタイム（invitation:new）・期限なし・二重の招待と既存のメンバーへの招待は 409。
describe('ワークスペースへの招待と、招待の承諾・辞退（F-08 / F-38）', () => {
  let postgres: StartedPostgreSqlContainer;
  let valkey: StartedTestContainer;
  let app: INestApplication;
  let base: string;
  let prisma: PrismaService;
  const opened: Socket[] = [];

  async function login(): Promise<LoggedIn> {
    sequence += 1;
    const loginId = `Inv_${Date.now().toString(36)}_${sequence}`;
    const user = await prisma.user.create({
      data: {
        loginId,
        displayName: `招待する人${sequence}`,
        passwordHash: await hashSecret('invite-password'),
      },
    });
    const res = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': nextIp() },
      body: JSON.stringify({ userId: loginId, password: 'invite-password' }),
    });
    expect(res.status).toBe(200);
    const { accessToken } = (await res.json()) as { accessToken: string };
    return { authorization: `Bearer ${accessToken}`, token: accessToken, id: user.id, loginId };
  }

  function request(
    method: 'GET' | 'POST',
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

  async function createWorkspace(owner: LoggedIn, name = '招待する場所'): Promise<Workspace> {
    const res = await request('POST', '/workspaces', owner.authorization, { name });
    expect(res.status).toBe(201);
    return (await res.json()) as Workspace;
  }

  function invite(from: LoggedIn, workspaceId: string, userId: string): Promise<Response> {
    return request('POST', `/workspaces/${workspaceId}/invitations`, from.authorization, {
      userId,
    });
  }

  async function invited(owner: LoggedIn, workspaceId: string, to: LoggedIn): Promise<Invitation> {
    const res = await invite(owner, workspaceId, to.loginId);
    expect(res.status).toBe(201);
    return (await res.json()) as Invitation;
  }

  async function socketOf(user: LoggedIn): Promise<Socket> {
    const { socket, error } = await connectRealtime(base, { token: user.token });
    opened.push(socket);
    expect(error).toBeUndefined();
    return socket;
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

  describe('招待（F-08）', () => {
    it('オーナーはユーザーID（大文字小文字を区別しない）で招待でき、招待された利用者にだけ invitation:new が届く。参加はまだ成立しない', async () => {
      const owner = await login();
      const invitee = await login();
      const bystander = await login();
      const workspace = await createWorkspace(owner, '通知の届く場所');
      const received = nextEvent(await socketOf(invitee), 'invitation:new');
      const leaked = nextEvent(await socketOf(bystander), 'invitation:new', 1_000);

      const res = await invite(owner, workspace.id, invitee.loginId.toUpperCase());
      expect(res.status).toBe(201);
      const invitation = (await res.json()) as Invitation;
      expect(invitation).toEqual({
        id: expect.stringMatching(UUID) as string,
        workspaceId: workspace.id,
        invitee: {
          id: invitee.id,
          userId: invitee.loginId,
          displayName: expect.any(String) as string,
        },
        createdAt: expect.any(String) as string,
      });

      expect(await received).toEqual({
        invitationId: invitation.id,
        workspace: { id: workspace.id, name: '通知の届く場所' },
        invitedBy: {
          id: owner.id,
          userId: owner.loginId,
          displayName: expect.any(String) as string,
        },
        sentAt: expect.any(String) as string,
      });
      expect(await leaked).toBeUndefined();
      // 承諾していない招待は参加ではない（schema.prisma の Membership の注記）。
      expect(
        await prisma.membership.count({
          where: { workspaceId: workspace.id, userId: invitee.id },
        }),
      ).toBe(0);
    });

    // CLAUDE.md「必ずテストを書く箇所」: メンバーがオーナー専用の操作を実行できないこと。
    it('オーナーでないメンバーが招待すると 403（owner_only）で、招待は作られない', async () => {
      const owner = await login();
      const member = await login();
      const invitee = await login();
      const workspace = await createWorkspace(owner);
      await prisma.membership.create({
        data: { workspaceId: workspace.id, userId: member.id, role: 'MEMBER' },
      });

      const res = await invite(member, workspace.id, invitee.loginId);
      expect(res.status).toBe(403);
      expect(((await res.json()) as ErrorResponse).code).toBe('owner_only');
      expect(await prisma.invitation.count({ where: { workspaceId: workspace.id } })).toBe(0);
    });

    it('所属していないワークスペースへの招待は、存在の有無によらず 404（本体は「見つかりません」）', async () => {
      const owner = await login();
      const outsider = await login();
      const invitee = await login();
      const workspace = await createWorkspace(owner);

      const others = await invite(outsider, workspace.id, invitee.loginId);
      expect(others.status).toBe(404);
      expect(await others.json()).toEqual(NOT_FOUND);
      const missing = await invite(
        outsider,
        '00000000-0000-7000-8000-000000000000',
        invitee.loginId,
      );
      expect(missing.status).toBe(404);
      expect(await missing.json()).toEqual(NOT_FOUND);
    });

    it('宛先のユーザーID の利用者がいない・退会済みなら 422（invitee_not_found）', async () => {
      const owner = await login();
      const withdrawn = await login();
      await prisma.user.update({ where: { id: withdrawn.id }, data: { deletedAt: new Date() } });
      const workspace = await createWorkspace(owner);

      for (const userId of ['Nobody_Here_At_All', withdrawn.loginId]) {
        const res = await invite(owner, workspace.id, userId);
        expect(res.status).toBe(422);
        expect(((await res.json()) as ErrorResponse).code).toBe('invitee_not_found');
      }
      expect(await prisma.invitation.count({ where: { workspaceId: workspace.id } })).toBe(0);
    });

    it('同じ人への未承諾の招待が既にあれば 409（already_invited）、既にメンバーなら 409（already_member）', async () => {
      const owner = await login();
      const invitee = await login();
      const member = await login();
      const workspace = await createWorkspace(owner);
      await prisma.membership.create({
        data: { workspaceId: workspace.id, userId: member.id, role: 'MEMBER' },
      });
      await invited(owner, workspace.id, invitee);

      const again = await invite(owner, workspace.id, invitee.loginId.toLowerCase());
      expect(again.status).toBe(409);
      expect(((await again.json()) as ErrorResponse).code).toBe('already_invited');
      for (const target of [member, owner]) {
        const res = await invite(owner, workspace.id, target.loginId);
        expect(res.status).toBe(409);
        expect(((await res.json()) as ErrorResponse).code).toBe('already_member');
      }
      expect(await prisma.invitation.count({ where: { workspaceId: workspace.id } })).toBe(1);
    });

    it('宛先のユーザーID が無い本体は 400', async () => {
      const owner = await login();
      const workspace = await createWorkspace(owner);
      const res = await request(
        'POST',
        `/workspaces/${workspace.id}/invitations`,
        owner.authorization,
        {},
      );
      expect(res.status).toBe(400);
    });
  });

  // #616（2026-09-18・依頼側）: ユーザーID を正確に知らなくても招待できるよう、一部の文字や表示名から候補を出す。
  describe('招待の候補（#616）', () => {
    type Candidate = { id: string; userId: string; displayName: string };

    function candidates(from: LoggedIn, workspaceId: string, q: string): Promise<Response> {
      return request(
        'GET',
        `/workspaces/${workspaceId}/invitation-candidates?q=${encodeURIComponent(q)}`,
        from.authorization,
      );
    }

    async function candidateIds(from: LoggedIn, workspaceId: string, q: string): Promise<string[]> {
      const res = await candidates(from, workspaceId, q);
      expect(res.status).toBe(200);
      return ((await res.json()) as Candidate[]).map((candidate) => candidate.id);
    }

    /** ほかの検査の利用者に当たらない、英小文字だけの目印（ユーザーID は英数字とアンダースコア）。 */
    function tag(): string {
      sequence += 1;
      const letters = 'abcdefghijklmnopqrstuvwxyz';
      const seed = `${Date.now()}${sequence}`;
      return `c${[...seed].map((digit) => letters[Number(digit)]).join('')}`;
    }

    async function user(loginId: string, displayName: string, deleted = false): Promise<string> {
      const created = await prisma.user.create({
        data: {
          loginId,
          displayName,
          passwordHash: 'argon2id-placeholder',
          ...(deleted ? { deletedAt: new Date() } : {}),
        },
      });
      return created.id;
    }

    it('オーナーは、ユーザーID と表示名の一部から退会していない利用者を探せる。並びはユーザーID の先頭一致 → 表示名の先頭一致 → 途中の一致', async () => {
      const owner = await login();
      const workspace = await createWorkspace(owner);
      const t = tag();
      const idPrefix = await user(`${t}_alpha`, 'アルファ');
      const namePrefix = await user(`zz_name_${sequence}`, `${t}さん`);
      const nameMiddle = await user(`ww_name_${sequence}`, `名前${t}`);
      const idMiddle = await user(`yy_${t}`, '途中');
      await user(`${t}_gone`, '退会した人', true);

      const expected = [idPrefix, namePrefix, nameMiddle, idMiddle];
      expect(await candidateIds(owner, workspace.id, t)).toEqual(expected);
      // 大文字小文字によらない
      expect(await candidateIds(owner, workspace.id, t.toUpperCase())).toEqual(expected);
      // 返すのはユーザーID と表示名だけ
      const res = await candidates(owner, workspace.id, `${t}_al`);
      expect(await res.json()).toEqual([
        { id: idPrefix, userId: `${t}_alpha`, displayName: 'アルファ' },
      ]);
    });

    it('既にメンバーの人・招待中の人・自分は候補に出ない', async () => {
      const owner = await login();
      const workspace = await createWorkspace(owner);
      const member = await login();
      await invited(owner, workspace.id, member);
      const pending = await login();
      await invited(owner, workspace.id, pending);
      const memberInvitation = (
        (await (
          await request('GET', '/invitations', member.authorization)
        ).json()) as MyInvitation[]
      ).find((invitation) => invitation.workspace.id === workspace.id)!;
      const accepted = await request(
        'POST',
        `/invitations/${memberInvitation.id}/accept`,
        member.authorization,
      );
      expect(accepted.status).toBe(200);
      const free = await login();

      for (const someone of [member, pending, owner]) {
        expect(await candidateIds(owner, workspace.id, someone.loginId)).toEqual([]);
      }
      expect(await candidateIds(owner, workspace.id, free.loginId)).toEqual([free.id]);
    });

    it('候補は最大 10 人', async () => {
      const owner = await login();
      const workspace = await createWorkspace(owner);
      const t = tag();
      for (let i = 0; i < 12; i += 1) {
        await user(`${t}_${String(i).padStart(2, '0')}`, `多い${i}`);
      }
      expect(await candidateIds(owner, workspace.id, t)).toHaveLength(10);
    });

    it('メンバーは 403 owner_only、所属していなければ 404', async () => {
      const owner = await login();
      const workspace = await createWorkspace(owner);
      const member = await login();
      await invited(owner, workspace.id, member);
      const invitation = (
        (await (
          await request('GET', '/invitations', member.authorization)
        ).json()) as MyInvitation[]
      ).find((item) => item.workspace.id === workspace.id)!;
      await request('POST', `/invitations/${invitation.id}/accept`, member.authorization);
      const outsider = await login();

      const forbidden = await candidates(member, workspace.id, 'Inv_');
      expect(forbidden.status).toBe(403);
      expect(((await forbidden.json()) as ErrorResponse).code).toBe('owner_only');
      const hidden = await candidates(outsider, workspace.id, 'Inv_');
      expect(hidden.status).toBe(404);
      expect(await hidden.json()).toEqual(NOT_FOUND);
    });

    it.each([
      ['無い', ''],
      ['空', '?q='],
      ['空白だけ', `?q=${encodeURIComponent(' 　')}`],
      ['51 文字', `?q=${encodeURIComponent('あ'.repeat(51))}`],
    ])('q が%sなら 400', async (_label, query) => {
      const owner = await login();
      const workspace = await createWorkspace(owner);
      const res = await request(
        'GET',
        `/workspaces/${workspace.id}/invitation-candidates${query}`,
        owner.authorization,
      );
      expect(res.status).toBe(400);
    });

    it('同じ利用者は1分に60回までで、超えたら 429', async () => {
      const owner = await login();
      const workspace = await createWorkspace(owner);
      for (let i = 0; i < 60; i += 1) {
        expect((await candidates(owner, workspace.id, 'Inv_')).status).toBe(200);
      }
      expect((await candidates(owner, workspace.id, 'Inv_')).status).toBe(429);
    }, 60_000);
  });

  describe('招待の承諾・辞退（F-38）', () => {
    it('自分宛ての未承諾の招待だけを一覧で返す', async () => {
      const owner = await login();
      const invitee = await login();
      const bystander = await login();
      const workspace = await createWorkspace(owner, '一覧に出る場所');
      const invitation = await invited(owner, workspace.id, invitee);

      const mine = await request('GET', '/invitations', invitee.authorization);
      expect(mine.status).toBe(200);
      expect((await mine.json()) as MyInvitation[]).toEqual([
        {
          id: invitation.id,
          workspace: { id: workspace.id, name: '一覧に出る場所' },
          invitedBy: {
            id: owner.id,
            userId: owner.loginId,
            displayName: expect.any(String) as string,
          },
          createdAt: invitation.createdAt,
        },
      ]);
      expect(await (await request('GET', '/invitations', bystander.authorization)).json()).toEqual(
        [],
      );
    });

    it('承諾すると参加（MEMBER）が成立し、招待は消える。承諾する前はワークスペースを取得できない（404）', async () => {
      const owner = await login();
      const invitee = await login();
      const workspace = await createWorkspace(owner);
      const invitation = await invited(owner, workspace.id, invitee);

      const before = await request('GET', `/workspaces/${workspace.id}`, invitee.authorization);
      expect(before.status).toBe(404);
      expect(await before.json()).toEqual(NOT_FOUND);

      const accepted = await request(
        'POST',
        `/invitations/${invitation.id}/accept`,
        invitee.authorization,
      );
      expect(accepted.status).toBe(200);
      expect((await accepted.json()) as Workspace).toMatchObject({
        id: workspace.id,
        role: 'MEMBER',
      });

      expect(
        (await request('GET', `/workspaces/${workspace.id}`, invitee.authorization)).status,
      ).toBe(200);
      expect(await (await request('GET', '/invitations', invitee.authorization)).json()).toEqual(
        [],
      );
      const membership = await prisma.membership.findUniqueOrThrow({
        where: { workspaceId_userId: { workspaceId: workspace.id, userId: invitee.id } },
      });
      expect(membership.role).toBe('MEMBER');

      // 同じ招待をもう一度承諾しても 404（招待は消えている）。
      expect(
        (await request('POST', `/invitations/${invitation.id}/accept`, invitee.authorization))
          .status,
      ).toBe(404);
    });

    it('辞退すると招待が消え、参加は成立せず、オーナーは再度招待できる', async () => {
      const owner = await login();
      const invitee = await login();
      const workspace = await createWorkspace(owner);
      const invitation = await invited(owner, workspace.id, invitee);

      const declined = await request(
        'POST',
        `/invitations/${invitation.id}/decline`,
        invitee.authorization,
      );
      expect(declined.status).toBe(204);
      expect(await (await request('GET', '/invitations', invitee.authorization)).json()).toEqual(
        [],
      );
      expect(
        await prisma.membership.count({
          where: { workspaceId: workspace.id, userId: invitee.id },
        }),
      ).toBe(0);
      expect((await invite(owner, workspace.id, invitee.loginId)).status).toBe(201);
    });

    // 機能一覧 2.2 の代償: 招待の後に別の経路で既にメンバーになっていたら、承諾は 409 で招待は残る（別の経路は Membership の直接の作成で代用する。#332）。
    it('招待の後に別の経路で既にメンバーになっていたら、承諾は 409（already_member）で招待は残る', async () => {
      const owner = await login();
      const invitee = await login();
      const workspace = await createWorkspace(owner);
      const invitation = await invited(owner, workspace.id, invitee);
      await prisma.membership.create({
        data: { workspaceId: workspace.id, userId: invitee.id, role: 'MEMBER' },
      });

      const accepted = await request(
        'POST',
        `/invitations/${invitation.id}/accept`,
        invitee.authorization,
      );
      expect(accepted.status).toBe(409);
      expect(((await accepted.json()) as ErrorResponse).code).toBe('already_member');
      expect(await prisma.invitation.count({ where: { id: invitation.id } })).toBe(1);
      expect(
        await prisma.membership.count({ where: { workspaceId: workspace.id, userId: invitee.id } }),
      ).toBe(1);
      // 機能一覧 2.2 の代償: 招待は残り、本人が辞退するまで自分宛ての一覧に出続ける。
      const mine = await request('GET', '/invitations', invitee.authorization);
      expect(mine.status).toBe(200);
      expect(((await mine.json()) as MyInvitation[]).map((i) => i.id)).toContain(invitation.id);
    });

    it('他人宛ての招待は、承諾も辞退もできない（404）。招待は残る', async () => {
      const owner = await login();
      const invitee = await login();
      const other = await login();
      const workspace = await createWorkspace(owner);
      const invitation = await invited(owner, workspace.id, invitee);

      for (const action of ['accept', 'decline']) {
        for (const actor of [other, owner]) {
          const res = await request(
            'POST',
            `/invitations/${invitation.id}/${action}`,
            actor.authorization,
          );
          expect(res.status).toBe(404);
          expect(await res.json()).toEqual(NOT_FOUND);
        }
      }
      expect(await prisma.invitation.count({ where: { id: invitation.id } })).toBe(1);
      expect(
        await prisma.membership.count({ where: { workspaceId: workspace.id, userId: other.id } }),
      ).toBe(0);
    });
  });

  // 機能一覧 1.1: ユーザーID は英数字と _ の 3〜30 文字。宛先の形は仕様が確かめる（登録・ログイン・再設定と同じ）。PR #329 第0巡。
  it('宛先のユーザーID が識別子の形でなければ 400', async () => {
    const owner = await login();
    const workspace = await createWorkspace(owner);
    for (const userId of ['ab', 'has space', 'x'.repeat(31), 'with-hyphen']) {
      expect((await invite(owner, workspace.id, userId)).status).toBe(400);
    }
    expect(await prisma.invitation.count({ where: { workspaceId: workspace.id } })).toBe(0);
  });

  // 機能一覧 1.4「2段構え」の1段目: 入口（ガード）とは別に、問い合わせ・書き込みの側でも退会済みの要求者を落とす（PR #329 第0巡）。
  // 退会済みのトークンはガードで 401 になり HTTP では届かないため、サービスを直に呼んで1段目だけを確かめる。
  it('退会済みの利用者には、自分宛ての招待を返さず、承諾も辞退もさせない（参加を作らず、招待も消さない）', async () => {
    const owner = await login();
    const invitee = await login();
    const workspace = await createWorkspace(owner);
    const invitation = await invited(owner, workspace.id, invitee);
    await prisma.user.update({ where: { id: invitee.id }, data: { deletedAt: new Date() } });
    const service = app.get(InvitationsService);

    expect(await service.mine(invitee.id)).toEqual([]);
    await expect(service.accept(invitee.id, invitation.id)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(service.decline(invitee.id, invitation.id)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(
      await prisma.membership.count({ where: { workspaceId: workspace.id, userId: invitee.id } }),
    ).toBe(0);
    expect(await prisma.invitation.count({ where: { id: invitation.id } })).toBe(1);
  });

  // 要求する側の退会済みは、入口（ガード）とは別に招待の問い合わせでも落とす（機能一覧 1.4 の2段構えの1段目。#332）。
  // 退会済みのトークンはガードで 401 になり HTTP では届かないため、mine/accept/decline と同じくサービスを直に呼ぶ。
  it('退会済みのオーナーは招待できない（サービスを直に呼んで404。招待も作らない）', async () => {
    const owner = await login();
    const invitee = await login();
    const workspace = await createWorkspace(owner);
    await prisma.user.update({ where: { id: owner.id }, data: { deletedAt: new Date() } });
    const service = app.get(InvitationsService);

    await expect(
      service.invite(owner.id, workspace.id, { userId: invitee.loginId }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(await prisma.invitation.count({ where: { workspaceId: workspace.id } })).toBe(0);
  });
});
