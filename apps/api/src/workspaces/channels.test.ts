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
  paths['/workspaces/{id}/channels']['post']['responses'][201]['content']['application/json'];
type ManagedChannel =
  paths['/workspaces/{id}/managed-channels']['get']['responses'][200]['content']['application/json'][number];
type ChannelMember =
  paths['/workspaces/{id}/channels/{channelId}/members']['get']['responses'][200]['content']['application/json'][number];
type ErrorResponse =
  paths['/workspaces/{id}/channels']['post']['responses'][409]['content']['application/json'];

const NOT_FOUND = { code: 'not_found', message: '見つかりません' };
const MISSING_ID = '00000000-0000-7000-8000-000000000000';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let sequence = 0;
let ipSequence = 0;
function nextIp(): string {
  ipSequence += 1;
  return `2001:db8::c:${ipSequence.toString(16)}`;
}

type LoggedIn = { authorization: string; id: string; loginId: string };

// 機能一覧 3.1（F-10）: チャンネルの作成・一覧・オーナーの管理用の一覧・参加者一覧。#335。
describe('チャンネルの作成・一覧・参加者一覧（F-10）', () => {
  let postgres: StartedPostgreSqlContainer;
  let valkey: StartedTestContainer;
  let app: INestApplication;
  let base: string;
  let prisma: PrismaService;

  async function login(): Promise<LoggedIn> {
    sequence += 1;
    const loginId = `Ch_${Date.now().toString(36)}_${sequence}`;
    const user = await prisma.user.create({
      data: {
        loginId,
        displayName: `チャンネルの人${sequence}`,
        passwordHash: await hashSecret('channel-password'),
      },
    });
    const res = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': nextIp() },
      body: JSON.stringify({ userId: loginId, password: 'channel-password' }),
    });
    expect(res.status).toBe(200);
    const { accessToken } = (await res.json()) as { accessToken: string };
    return { authorization: `Bearer ${accessToken}`, id: user.id, loginId };
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

  /** オーナーのワークスペースを作り、渡した利用者をメンバーとして参加させる。 */
  async function workspaceWith(owner: LoggedIn, ...members: LoggedIn[]): Promise<Workspace> {
    const res = await request('POST', '/workspaces', owner.authorization, {
      name: 'チャンネルの場所',
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

  function create(
    by: LoggedIn,
    workspaceId: string,
    name: string,
    visibility: 'PUBLIC' | 'PRIVATE' = 'PUBLIC',
  ): Promise<Response> {
    return request('POST', `/workspaces/${workspaceId}/channels`, by.authorization, {
      name,
      visibility,
    });
  }

  async function created(
    by: LoggedIn,
    workspaceId: string,
    name: string,
    visibility: 'PUBLIC' | 'PRIVATE' = 'PUBLIC',
  ): Promise<Channel> {
    const res = await create(by, workspaceId, name, visibility);
    expect(res.status).toBe(201);
    return (await res.json()) as Channel;
  }

  /** API を通さずにチャンネルを作る（オーナーが参加していないチャンネル・アーカイブ済みのチャンネルを用意するため）。 */
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

  function members(by: LoggedIn, workspaceId: string, channelId: string): Promise<Response> {
    return request(
      'GET',
      `/workspaces/${workspaceId}/channels/${channelId}/members`,
      by.authorization,
    );
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

  describe('作成', () => {
    it('オーナーはパブリック・プライベートのチャンネルを作れ、作ったオーナーはその参加者になる', async () => {
      const owner = await login();
      const workspace = await workspaceWith(owner);

      for (const visibility of ['PUBLIC', 'PRIVATE'] as const) {
        const res = await create(owner, workspace.id, `作る-${visibility}`, visibility);
        expect(res.status).toBe(201);
        const channel = (await res.json()) as Channel;
        expect(channel).toEqual({
          id: expect.stringMatching(UUID) as string,
          name: `作る-${visibility}`,
          visibility,
          joined: true,
          // 作った直後は未読なし（F-23。機能一覧 10.1）。参加した時刻は「ここから未読」の線に要る。
          joinedAt: expect.any(String) as string,
          unread: 0,
          lastReadMessageId: null,
        });
        expect(
          await prisma.channelMember.count({ where: { channelId: channel.id, userId: owner.id } }),
        ).toBe(1);
      }
    });

    // CLAUDE.md「必ずテストを書く箇所」: メンバーがオーナー専用の操作を実行できないこと。
    it('オーナーでないメンバーが作ると 403（owner_only）で、作られない', async () => {
      const owner = await login();
      const member = await login();
      const workspace = await workspaceWith(owner, member);

      const res = await create(member, workspace.id, 'メンバーが作る');
      expect(res.status).toBe(403);
      expect(((await res.json()) as ErrorResponse).code).toBe('owner_only');
      expect(await prisma.channel.count({ where: { workspaceId: workspace.id } })).toBe(0);
    });

    it('所属していないワークスペースへの作成は、存在の有無によらず 404', async () => {
      const owner = await login();
      const outsider = await login();
      const workspace = await workspaceWith(owner);

      for (const workspaceId of [workspace.id, MISSING_ID]) {
        const res = await create(outsider, workspaceId, '外から作る');
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual(NOT_FOUND);
      }
    });

    // 機能一覧 3.1: 名前は 1〜50 文字（コードポイント）・空白だけは不可（#290）。
    it.each([
      { label: '空', name: '', status: 400 },
      { label: '空白だけ', name: ' \t　', status: 400 },
      { label: '50 文字（サロゲートペア）', name: '🍵'.repeat(50), status: 201 },
      { label: '51 文字', name: 'あ'.repeat(51), status: 400 },
    ])('名前が $label なら $status', async ({ name, status }) => {
      const owner = await login();
      const workspace = await workspaceWith(owner);
      expect((await create(owner, workspace.id, name)).status).toBe(status);
    });

    it('同じワークスペースに同じ名前があれば 409（channel_name_taken）。別のワークスペースなら作れる', async () => {
      const owner = await login();
      const workspace = await workspaceWith(owner);
      const other = await workspaceWith(owner);
      await created(owner, workspace.id, 'general');

      const again = await create(owner, workspace.id, 'general', 'PRIVATE');
      expect(again.status).toBe(409);
      expect(((await again.json()) as ErrorResponse).code).toBe('channel_name_taken');
      expect((await create(owner, other.id, 'general')).status).toBe(201);
    });

    // REVIEW.md 6章: 同時実行の競合は、同時に実行して1件だけ成功することを確かめる（逐次の 409 のテストでは、違反を捕まえない形でも落ちない）。
    it('同じ名前の作成を同時に送ると、201 はちょうど1件で、残りはすべて 409（channel_name_taken）、行は1つだけ', async () => {
      const owner = await login();
      const workspace = await workspaceWith(owner);

      const responses = await Promise.all(
        Array.from({ length: 8 }, () => create(owner, workspace.id, 'race')),
      );

      expect(responses.map((res) => res.status).sort((a, b) => a - b)).toEqual([
        201,
        ...Array<number>(7).fill(409),
      ]);
      for (const res of responses.filter(({ status }) => status === 409)) {
        expect(((await res.json()) as ErrorResponse).code).toBe('channel_name_taken');
      }
      expect(
        await prisma.channel.count({ where: { workspaceId: workspace.id, name: 'race' } }),
      ).toBe(1);
    });
  });

  describe('一覧', () => {
    // 機能一覧 3.1: プライベートは参加者だけに見え、一覧に出ない。アーカイブ済みは一覧から外れる（3.2）。
    it('メンバーには、パブリックと自分が参加しているプライベートだけが、アーカイブ済みを除いて見える', async () => {
      const owner = await login();
      const member = await login();
      const workspace = await workspaceWith(owner, member);
      const open = await channelRow(workspace.id, 'open', 'PUBLIC', []);
      const mine = await channelRow(workspace.id, 'mine', 'PRIVATE', [member]);
      await channelRow(workspace.id, 'secret', 'PRIVATE', [owner]);
      await channelRow(workspace.id, 'old', 'PUBLIC', [member], true);

      const res = await request(
        'GET',
        `/workspaces/${workspace.id}/channels`,
        member.authorization,
      );
      expect(res.status).toBe(200);
      expect((await res.json()) as Channel[]).toEqual([
        {
          id: mine,
          name: 'mine',
          visibility: 'PRIVATE',
          joined: true,
          joinedAt: expect.any(String) as string,
          unread: 0,
          lastReadMessageId: null,
        },
        {
          id: open,
          name: 'open',
          visibility: 'PUBLIC',
          joined: false,
          // **参加していないチャンネルは、参加時刻なし**（線も未読も持たない。機能一覧 10.1）。
          joinedAt: null,
          unread: 0,
          lastReadMessageId: null,
        },
      ]);
    });

    // CLAUDE.md 2: オーナーでも、参加していないプライベートチャンネルは一般の一覧に出ない（管理用の一覧は別）。
    it('オーナーの一般の一覧にも、参加していないプライベートチャンネルは出ない', async () => {
      const owner = await login();
      const member = await login();
      const workspace = await workspaceWith(owner, member);
      await channelRow(workspace.id, 'members-only', 'PRIVATE', [member]);

      const res = await request('GET', `/workspaces/${workspace.id}/channels`, owner.authorization);
      expect(res.status).toBe(200);
      expect((await res.json()) as Channel[]).toEqual([]);
    });

    it('所属していないワークスペースの一覧は、存在の有無によらず 404', async () => {
      const owner = await login();
      const outsider = await login();
      const workspace = await workspaceWith(owner);
      await channelRow(workspace.id, 'open', 'PUBLIC', []);

      for (const workspaceId of [workspace.id, MISSING_ID]) {
        const res = await request(
          'GET',
          `/workspaces/${workspaceId}/channels`,
          outsider.authorization,
        );
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual(NOT_FOUND);
      }
    });
  });

  describe('オーナーの管理用の一覧', () => {
    // 機能一覧 3.1「オーナーには、管理のためのチャンネル一覧を返す」: id・名前・種別・参加者数・アーカイブ済みか。アーカイブ済みも含める。
    it('オーナーには、参加していないプライベートとアーカイブ済みも含めて、id・名前・種別・参加者数（退会者を除く）・アーカイブ済みかだけを返す', async () => {
      const owner = await login();
      const member = await login();
      const withdrawn = await login();
      const workspace = await workspaceWith(owner, member, withdrawn);
      const secret = await channelRow(workspace.id, 'secret', 'PRIVATE', [member, withdrawn]);
      const old = await channelRow(workspace.id, 'old', 'PUBLIC', [], true);
      await prisma.user.update({ where: { id: withdrawn.id }, data: { deletedAt: new Date() } });

      const res = await request(
        'GET',
        `/workspaces/${workspace.id}/managed-channels`,
        owner.authorization,
      );
      expect(res.status).toBe(200);
      // 会話の中身（メッセージ・未読数・在席）を返さないことを、項目を完全に一致させて固定する。
      expect((await res.json()) as ManagedChannel[]).toEqual([
        { id: old, name: 'old-1', visibility: 'PUBLIC', memberCount: 0, archived: true },
        { id: secret, name: 'secret', visibility: 'PRIVATE', memberCount: 1, archived: false },
      ]);
    });

    it('オーナーでないメンバーには 403（owner_only）、所属していなければ 404', async () => {
      const owner = await login();
      const member = await login();
      const outsider = await login();
      const workspace = await workspaceWith(owner, member);

      const byMember = await request(
        'GET',
        `/workspaces/${workspace.id}/managed-channels`,
        member.authorization,
      );
      expect(byMember.status).toBe(403);
      expect(((await byMember.json()) as ErrorResponse).code).toBe('owner_only');
      const byOutsider = await request(
        'GET',
        `/workspaces/${workspace.id}/managed-channels`,
        outsider.authorization,
      );
      expect(byOutsider.status).toBe(404);
      expect(await byOutsider.json()).toEqual(NOT_FOUND);
    });
  });

  describe('参加者一覧（コードは2段階）', () => {
    it('参加者は、退会者を除いた参加者一覧を取得できる', async () => {
      const owner = await login();
      const member = await login();
      const withdrawn = await login();
      const workspace = await workspaceWith(owner, member, withdrawn);
      const channel = await channelRow(workspace.id, 'team', 'PRIVATE', [member, withdrawn]);
      await prisma.user.update({ where: { id: withdrawn.id }, data: { deletedAt: new Date() } });

      const res = await members(member, workspace.id, channel);
      expect(res.status).toBe(200);
      expect((await res.json()) as ChannelMember[]).toEqual([
        { id: member.id, userId: member.loginId, displayName: expect.any(String) as string },
      ]);
    });

    // 機能一覧 3.1「上記の2段階のコードを検証する自動テストが存在する」: 所属していない（404）・プライベートの非参加者（404）・パブリックの非参加者（403）。
    it('所属していなければ種別によらず 404、所属していればパブリックは 403・プライベートは 404', async () => {
      const owner = await login();
      const participant = await login();
      const bystander = await login();
      const outsider = await login();
      const workspace = await workspaceWith(owner, participant, bystander);
      const open = await channelRow(workspace.id, 'open', 'PUBLIC', [participant]);
      const secret = await channelRow(workspace.id, 'secret', 'PRIVATE', [participant]);

      for (const channel of [open, secret]) {
        const res = await members(outsider, workspace.id, channel);
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual(NOT_FOUND);
      }
      const publicRes = await members(bystander, workspace.id, open);
      expect(publicRes.status).toBe(403);
      expect(((await publicRes.json()) as ErrorResponse).code).toBe('not_a_channel_member');
      const privateRes = await members(bystander, workspace.id, secret);
      expect(privateRes.status).toBe(404);
      expect(await privateRes.json()).toEqual(NOT_FOUND);
    });

    // 機能一覧 3.1「オーナーは、参加していないプライベートチャンネルの参加者一覧も取得できる」（オーナーは例外の側）。
    it('オーナーは、参加していないプライベートチャンネルの参加者一覧も取得できる', async () => {
      const owner = await login();
      const member = await login();
      const workspace = await workspaceWith(owner, member);
      const secret = await channelRow(workspace.id, 'secret', 'PRIVATE', [member]);

      const res = await members(owner, workspace.id, secret);
      expect(res.status).toBe(200);
      expect(((await res.json()) as ChannelMember[]).map((m) => m.id)).toEqual([member.id]);
    });

    it('別のワークスペースのチャンネル・存在しないチャンネルは 404', async () => {
      const owner = await login();
      const workspace = await workspaceWith(owner);
      const other = await workspaceWith(owner);
      const elsewhere = await channelRow(other.id, 'elsewhere', 'PUBLIC', [owner]);

      for (const channel of [elsewhere, MISSING_ID]) {
        const res = await members(owner, workspace.id, channel);
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual(NOT_FOUND);
      }
    });
  });

  // 機能一覧 9.1（F-20）: メンションの補完候補。候補は投稿時の宛先解決（経路1）で解決できる利用者と一致させ、違うのは前方一致であることだけ。#494。
  // CLAUDE.md「必ずテストを書く箇所」: 検索がプライベートチャンネルを漏らさないこと（補完候補も、非参加者にプライベートチャンネルの参加者を出さない）。
  describe('メンションの補完候補（F-20。コードは2段階・オーナーの例外なし）', () => {
    function candidates(
      by: LoggedIn,
      workspaceId: string,
      channelId: string,
      query = '',
    ): Promise<Response> {
      return request(
        'GET',
        `/workspaces/${workspaceId}/channels/${channelId}/mention-candidates${query}`,
        by.authorization,
      );
    }

    /** ユーザーID を決めて利用者を作り、ワークスペースに参加させる（ログインはしない。候補の対象にするだけ）。 */
    async function userNamed(workspaceId: string, loginId: string): Promise<LoggedIn> {
      const user = await prisma.user.create({
        data: { loginId, displayName: `候補の人 ${loginId}`, passwordHash: 'argon2id-placeholder' },
      });
      await prisma.membership.create({ data: { workspaceId, userId: user.id, role: 'MEMBER' } });
      return { authorization: '', id: user.id, loginId };
    }

    function summaryOf(user: LoggedIn) {
      return { id: user.id, userId: user.loginId, displayName: expect.any(String) as string };
    }

    /** この it だけのユーザーID の頭（ほかの it の利用者と前方一致しない）。 */
    function uniqueTag(): string {
      sequence += 1;
      return `m${Date.now().toString(36)}${sequence}`;
    }

    it('参加者は、ユーザーID の前方一致（大文字小文字によらない）で、退会者と非参加者を除いた候補を、ユーザーID の小文字の昇順で取得できる', async () => {
      const owner = await login();
      const member = await login();
      const workspace = await workspaceWith(owner, member);
      const tag = uniqueTag();
      // 登録した綴りに大文字を含む側（列の lower() が要る）と、小文字だけの側（引数の lower() が要る）を並べる
      const bravo = await userNamed(workspace.id, `${tag.toUpperCase()}_Bravo`);
      const alpha = await userNamed(workspace.id, `${tag}_alpha`);
      const gone = await userNamed(workspace.id, `${tag}_charlie`);
      // 同じワークスペースにいて、このチャンネルに参加していない
      await userNamed(workspace.id, `${tag}_delta`);
      const channel = await channelRow(workspace.id, 'mention', 'PRIVATE', [
        member,
        bravo,
        alpha,
        gone,
      ]);
      await prisma.user.update({ where: { id: gone.id }, data: { deletedAt: new Date() } });

      const res = await candidates(member, workspace.id, channel, `?prefix=${tag.toUpperCase()}`);

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([summaryOf(alpha), summaryOf(bravo)]);
    });

    it('候補は10人までで、ユーザーID の小文字の昇順の先頭から返す。prefix を省くと参加者の全員が照合に当たる', async () => {
      const owner = await login();
      const member = await login();
      const workspace = await workspaceWith(owner, member);
      const tag = uniqueTag();
      const people: LoggedIn[] = [];
      for (let i = 0; i < 11; i += 1) {
        people.push(await userNamed(workspace.id, `${tag}_p${String(i).padStart(2, '0')}`));
      }
      const channel = await channelRow(workspace.id, 'many', 'PUBLIC', [member, ...people]);

      const byPrefix = await candidates(member, workspace.id, channel, `?prefix=${tag}`);
      expect(byPrefix.status).toBe(200);
      expect(await byPrefix.json()).toEqual(people.slice(0, 10).map(summaryOf));

      // member のユーザーID（Ch_…）は小文字にすると tag（m…）より前に並ぶ
      const all = await candidates(member, workspace.id, channel);
      expect(all.status).toBe(200);
      expect(await all.json()).toEqual([summaryOf(member), ...people.slice(0, 9).map(summaryOf)]);
    });

    it('前方一致は `_` を文字として比べる（ワイルドカードにしない）', async () => {
      const owner = await login();
      const member = await login();
      const workspace = await workspaceWith(owner, member);
      const tag = uniqueTag();
      const underscore = await userNamed(workspace.id, `${tag}_a`);
      const letter = await userNamed(workspace.id, `${tag}xa`);
      const channel = await channelRow(workspace.id, 'wild', 'PUBLIC', [
        member,
        underscore,
        letter,
      ]);

      const res = await candidates(member, workspace.id, channel, `?prefix=${tag}_`);

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([summaryOf(underscore)]);
    });

    it('所属していなければ種別によらず 404、所属していればパブリックは 403・プライベートは 404。参加していないオーナーも同じ（例外は及ばない）', async () => {
      const owner = await login();
      const participant = await login();
      const bystander = await login();
      const outsider = await login();
      const workspace = await workspaceWith(owner, participant, bystander);
      const open = await channelRow(workspace.id, 'open', 'PUBLIC', [participant]);
      const secret = await channelRow(workspace.id, 'secret', 'PRIVATE', [participant]);

      for (const channel of [open, secret]) {
        const res = await candidates(outsider, workspace.id, channel);
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual(NOT_FOUND);
      }
      for (const by of [bystander, owner]) {
        const publicRes = await candidates(by, workspace.id, open);
        expect(publicRes.status).toBe(403);
        expect(((await publicRes.json()) as ErrorResponse).code).toBe('not_a_channel_member');
        const privateRes = await candidates(by, workspace.id, secret);
        expect(privateRes.status).toBe(404);
        expect(await privateRes.json()).toEqual(NOT_FOUND);
      }
    });

    it('別のワークスペースのチャンネル・存在しないチャンネルは 404', async () => {
      const owner = await login();
      const workspace = await workspaceWith(owner);
      const other = await workspaceWith(owner);
      const elsewhere = await channelRow(other.id, 'elsewhere', 'PUBLIC', [owner]);

      for (const channel of [elsewhere, MISSING_ID]) {
        const res = await candidates(owner, workspace.id, channel);
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual(NOT_FOUND);
      }
    });

    it('prefix がユーザーID に使えない文字を含む・31 文字以上なら 400', async () => {
      const owner = await login();
      const member = await login();
      const workspace = await workspaceWith(owner, member);
      const channel = await channelRow(workspace.id, 'form', 'PUBLIC', [member]);

      for (const query of ['?prefix=a-b', `?prefix=${'a'.repeat(31)}`]) {
        const res = await candidates(member, workspace.id, channel, query);
        expect(res.status).toBe(400);
      }
    });
  });
});
