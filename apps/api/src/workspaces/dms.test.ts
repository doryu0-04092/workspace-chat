import 'reflect-metadata';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type {
  DmMessageDeletedPayload,
  DmMessageNewPayload,
  DmUnreadUpdatedPayload,
  paths,
} from '@workspace-chat/shared';
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

type Workspace = paths['/workspaces']['post']['responses'][201]['content']['application/json'];
type Dm = paths['/workspaces/{id}/dms']['post']['responses'][200]['content']['application/json'];
type DmMessage =
  paths['/workspaces/{id}/dms/{dmId}/messages']['post']['responses'][201]['content']['application/json'];
type DmMessagePage =
  paths['/workspaces/{id}/dms/{dmId}/messages']['get']['responses'][200]['content']['application/json'];

const NOT_FOUND = { code: 'not_found', message: '見つかりません' };
const MISSING_ID = '00000000-0000-7000-8000-000000000000';

let sequence = 0;
let ipSequence = 0;
function nextIp(): string {
  ipSequence += 1;
  return `2001:db8::d:${ipSequence.toString(16)}`;
}

type LoggedIn = {
  authorization: string;
  token: string;
  id: string;
  loginId: string;
  displayName: string;
};

// 機能一覧 8（F-19）: ダイレクトメッセージ。同一ワークスペース内の1対1。#574。
// 5.2 の DM の箇条: DM で起きるイベントは当事者2人の利用者の部屋へ1回で送り、送受信のたびに当事者であり、ともにそのワークスペースのメンバーであることを確かめる。
// 10.1: 「利用者 × DM」の既読位置からの差分で未読を求め、unread:updated は持ち主の部屋へだけ送る。
// CLAUDE.md「必ずテストを書く箇所」3: 利用者の部屋へ送る値を、受け取る資格の無い利用者（DM なら当事者でない利用者・そのワークスペースのメンバーでない利用者）に届けないこと。
// 同 9: 退会済みのトークンが、読み取り・書き込みのいずれでも拒否されること。
describe('ダイレクトメッセージ（F-19）', () => {
  let postgres: StartedPostgreSqlContainer;
  let valkey: StartedTestContainer;
  let app: INestApplication;
  let base: string;
  let prisma: PrismaService;
  const opened: Socket[] = [];

  async function login(): Promise<LoggedIn> {
    sequence += 1;
    const loginId = `Dm_${Date.now().toString(36)}_${sequence}`;
    const displayName = `DM の人${sequence}`;
    const user = await prisma.user.create({
      data: { loginId, displayName, passwordHash: await hashSecret('dm-password') },
    });
    const res = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': nextIp() },
      body: JSON.stringify({ userId: loginId, password: 'dm-password' }),
    });
    expect(res.status).toBe(200);
    const { accessToken } = (await res.json()) as { accessToken: string };
    return {
      authorization: `Bearer ${accessToken}`,
      token: accessToken,
      id: user.id,
      loginId,
      displayName,
    };
  }

  function request(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
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

  async function workspaceWith(owner: LoggedIn, ...members: LoggedIn[]): Promise<Workspace> {
    const res = await request('POST', '/workspaces', owner, { name: 'DM の場所' });
    expect(res.status).toBe(201);
    const workspace = (await res.json()) as Workspace;
    for (const member of members) {
      await prisma.membership.create({
        data: { workspaceId: workspace.id, userId: member.id, role: 'MEMBER' },
      });
    }
    return workspace;
  }

  function start(by: LoggedIn, workspaceId: string, userId: string): Promise<Response> {
    return request('POST', `/workspaces/${workspaceId}/dms`, by, { userId });
  }

  async function started(by: LoggedIn, workspaceId: string, counterpart: LoggedIn): Promise<Dm> {
    const res = await start(by, workspaceId, counterpart.id);
    expect(res.status).toBe(200);
    return (await res.json()) as Dm;
  }

  async function dmsOf(by: LoggedIn, workspaceId: string): Promise<Dm[]> {
    const res = await request('GET', `/workspaces/${workspaceId}/dms`, by);
    expect(res.status).toBe(200);
    return (await res.json()) as Dm[];
  }

  async function dmOf(by: LoggedIn, workspaceId: string, dmId: string): Promise<Dm | undefined> {
    return (await dmsOf(by, workspaceId)).find((dm) => dm.id === dmId);
  }

  function post(by: LoggedIn, workspaceId: string, dmId: string, body: string) {
    return request('POST', `/workspaces/${workspaceId}/dms/${dmId}/messages`, by, { body });
  }

  async function posted(
    by: LoggedIn,
    workspaceId: string,
    dmId: string,
    body: string,
  ): Promise<DmMessage> {
    const res = await post(by, workspaceId, dmId, body);
    expect(res.status).toBe(201);
    return (await res.json()) as DmMessage;
  }

  function list(by: LoggedIn, workspaceId: string, dmId: string, query = '') {
    return request('GET', `/workspaces/${workspaceId}/dms/${dmId}/messages${query}`, by);
  }

  async function page(
    by: LoggedIn,
    workspaceId: string,
    dmId: string,
    query = '',
  ): Promise<DmMessagePage> {
    const res = await list(by, workspaceId, dmId, query);
    expect(res.status).toBe(200);
    return (await res.json()) as DmMessagePage;
  }

  function edit(by: LoggedIn, workspaceId: string, dmId: string, messageId: string, body: string) {
    return request('PATCH', `/workspaces/${workspaceId}/dms/${dmId}/messages/${messageId}`, by, {
      body,
    });
  }

  function remove(by: LoggedIn, workspaceId: string, dmId: string, messageId: string) {
    return request('DELETE', `/workspaces/${workspaceId}/dms/${dmId}/messages/${messageId}`, by);
  }

  function read(by: LoggedIn, workspaceId: string, dmId: string, lastReadMessageId: string) {
    return request('PUT', `/workspaces/${workspaceId}/dms/${dmId}/read`, by, {
      lastReadMessageId,
    });
  }

  async function kick(owner: LoggedIn, workspaceId: string, member: LoggedIn): Promise<void> {
    const res = await request('DELETE', `/workspaces/${workspaceId}/members/${member.id}`, owner);
    expect(res.status).toBe(204);
  }

  async function open(user: LoggedIn): Promise<Socket> {
    const { socket, error } = await connectRealtime(base, { token: user.token });
    expect(error).toBeUndefined();
    opened.push(socket);
    return socket;
  }

  /** オーナーのワークスペースに alice・bob・carol が参加し、alice と bob の DM を始めた状態。 */
  async function dmOfAliceAndBob() {
    const owner = await login();
    const alice = await login();
    const bob = await login();
    const carol = await login();
    const workspace = await workspaceWith(owner, alice, bob, carol);
    const dm = await started(alice, workspace.id, bob);
    return { owner, alice, bob, carol, workspace, dm };
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

  describe('始める・一覧', () => {
    it('同じワークスペースのメンバーと DM を始められ、同じ相手とは何度始めても・相手の側から始めても同じ DM が返る', async () => {
      const { alice, bob, workspace, dm } = await dmOfAliceAndBob();

      expect(dm).toEqual({
        id: expect.any(String),
        counterpart: { id: bob.id, userId: bob.loginId, displayName: bob.displayName },
        writable: true,
        joinedAt: expect.any(String),
        unread: 0,
        lastReadMessageId: null,
      });
      expect((await started(alice, workspace.id, bob)).id).toBe(dm.id);
      const fromBob = await started(bob, workspace.id, alice);
      expect(fromBob.id).toBe(dm.id);
      expect(fromBob.counterpart?.id).toBe(alice.id);
      expect(await prisma.dm.count({ where: { workspaceId: workspace.id } })).toBe(1);
      expect((await dmsOf(alice, workspace.id)).map(({ id }) => id)).toEqual([dm.id]);
      expect((await dmsOf(bob, workspace.id)).map(({ id }) => id)).toEqual([dm.id]);
    });

    it('同時に始めても DM は1つだけ作られる', async () => {
      const owner = await login();
      const alice = await login();
      const bob = await login();
      const workspace = await workspaceWith(owner, alice, bob);

      const results = await Promise.all([
        start(alice, workspace.id, bob.id),
        start(bob, workspace.id, alice.id),
        start(alice, workspace.id, bob.id),
      ]);

      expect(results.map((res) => res.status)).toEqual([200, 200, 200]);
      const ids = await Promise.all(results.map(async (res) => ((await res.json()) as Dm).id));
      expect(new Set(ids).size).toBe(1);
      expect(await prisma.dm.count({ where: { workspaceId: workspace.id } })).toBe(1);
    });

    it('自分自身とは始められない（422 dm_with_self）', async () => {
      const owner = await login();
      const workspace = await workspaceWith(owner);

      const res = await start(owner, workspace.id, owner.id);

      expect(res.status).toBe(422);
      expect(await res.json()).toMatchObject({ code: 'dm_with_self' });
    });

    // 機能一覧 8: 相手は同一ワークスペースのメンバーに限る。
    it('相手がこのワークスペースのメンバーでない・退会済み・存在しないなら 422 dm_counterpart_not_found で、DM を作らない', async () => {
      const owner = await login();
      const alice = await login();
      const outsider = await login();
      const leaver = await login();
      const workspace = await workspaceWith(owner, alice, leaver);
      await workspaceWith(outsider);
      await prisma.user.update({ where: { id: leaver.id }, data: { deletedAt: new Date() } });

      for (const userId of [outsider.id, leaver.id, MISSING_ID]) {
        const res = await start(alice, workspace.id, userId);
        expect(res.status).toBe(422);
        expect(await res.json()).toMatchObject({ code: 'dm_counterpart_not_found' });
      }
      expect(await prisma.dm.count({ where: { workspaceId: workspace.id } })).toBe(0);
    });

    it('所属していないワークスペースでは、一覧も開始も 404（存在の有無を区別しない）', async () => {
      const { bob, workspace } = await dmOfAliceAndBob();
      const outsider = await login();

      const listed = await request('GET', `/workspaces/${workspace.id}/dms`, outsider);
      expect(listed.status).toBe(404);
      expect(await listed.json()).toEqual(NOT_FOUND);
      const begun = await start(outsider, workspace.id, bob.id);
      expect(begun.status).toBe(404);
      expect(await begun.json()).toEqual(NOT_FOUND);
    });

    it('一覧は自分が当事者の DM だけを返す（同じワークスペースの他人どうしの DM は返さない）', async () => {
      const { bob, carol, workspace, dm } = await dmOfAliceAndBob();
      const carolWithBob = await started(carol, workspace.id, bob);

      expect((await dmsOf(carol, workspace.id)).map(({ id }) => id)).toEqual([carolWithBob.id]);
      expect(new Set((await dmsOf(bob, workspace.id)).map(({ id }) => id))).toEqual(
        new Set([dm.id, carolWithBob.id]),
      );
    });

    it('一覧は新しいメッセージのある DM から並ぶ', async () => {
      const { alice, bob, carol, workspace, dm } = await dmOfAliceAndBob();
      const withCarol = await started(alice, workspace.id, carol);
      await posted(bob, workspace.id, dm.id, 'bob から');
      expect((await dmsOf(alice, workspace.id)).map(({ id }) => id)).toEqual([dm.id, withCarol.id]);

      await posted(carol, workspace.id, withCarol.id, 'carol から');

      expect((await dmsOf(alice, workspace.id)).map(({ id }) => id)).toEqual([withCarol.id, dm.id]);
    });
  });

  // CLAUDE.md「必ずテストを書く箇所」: 当事者でない利用者・そのワークスペースのメンバーでない利用者に DM を渡さない。
  describe('認可', () => {
    it('当事者でない同じワークスペースのメンバー（オーナーを含む）には、メッセージの一覧・投稿・編集・削除・既読のすべてを 404 で断り、何も変えない', async () => {
      const { owner, alice, carol, workspace, dm } = await dmOfAliceAndBob();
      const message = await posted(alice, workspace.id, dm.id, '二人だけの話');

      for (const stranger of [carol, owner]) {
        const responses = [
          await list(stranger, workspace.id, dm.id),
          await post(stranger, workspace.id, dm.id, '割り込み'),
          await edit(stranger, workspace.id, dm.id, message.id, '書き換え'),
          await remove(stranger, workspace.id, dm.id, message.id),
          await read(stranger, workspace.id, dm.id, message.id),
        ];
        for (const res of responses) {
          expect(res.status).toBe(404);
          expect(await res.json()).toEqual(NOT_FOUND);
        }
      }
      expect((await page(alice, workspace.id, dm.id)).messages).toEqual([message]);
      expect(await prisma.dmRead.count({ where: { dmId: dm.id } })).toBe(0);
    });

    it('別のワークスペースの人・別のワークスペースのパスからは、DM の id を知っていても 404', async () => {
      const { alice, workspace, dm } = await dmOfAliceAndBob();
      const outsider = await login();
      const elsewhere = await workspaceWith(outsider, alice);
      await posted(alice, workspace.id, dm.id, '二人だけの話');

      for (const res of [
        await list(outsider, workspace.id, dm.id),
        await post(outsider, workspace.id, dm.id, '割り込み'),
        // 当事者でも、DM が属さないワークスペースのパスでは 404
        await list(alice, elsewhere.id, dm.id),
        await post(alice, elsewhere.id, dm.id, '別の場所から'),
        await list(alice, workspace.id, MISSING_ID),
      ]) {
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual(NOT_FOUND);
      }
    });

    it('ワークスペースからキックされた当事者は、その DM の一覧・メッセージ・投稿のどれも 404', async () => {
      const { owner, alice, bob, workspace, dm } = await dmOfAliceAndBob();
      await posted(alice, workspace.id, dm.id, 'キックの前');

      await kick(owner, workspace.id, bob);

      for (const res of [
        await request('GET', `/workspaces/${workspace.id}/dms`, bob),
        await list(bob, workspace.id, dm.id),
        await post(bob, workspace.id, dm.id, 'キックの後'),
      ]) {
        expect(res.status).toBe(404);
      }
    });

    it('退会済みの利用者のトークンは、DM の読み取りも書き込みも 401 で断り、書き込みを反映しない', async () => {
      const { alice, workspace, dm } = await dmOfAliceAndBob();
      await prisma.user.update({ where: { id: alice.id }, data: { deletedAt: new Date() } });

      expect((await list(alice, workspace.id, dm.id)).status).toBe(401);
      expect((await post(alice, workspace.id, dm.id, '退会の後')).status).toBe(401);
      expect(await prisma.dmMessage.count({ where: { dmId: dm.id } })).toBe(0);
    });
  });

  describe('メッセージ', () => {
    it('当事者は投稿し、新しい順のページで読める（before と nextBefore で遡る）', async () => {
      const { alice, bob, workspace, dm } = await dmOfAliceAndBob();
      const first = await posted(alice, workspace.id, dm.id, '1');
      const second = await posted(bob, workspace.id, dm.id, '2');
      const third = await posted(alice, workspace.id, dm.id, '3');

      expect(second).toEqual({
        id: expect.any(String),
        dmId: dm.id,
        author: { id: bob.id, userId: bob.loginId, displayName: bob.displayName },
        body: '2',
        createdAt: expect.any(String),
        editedAt: null,
        deleted: false,
      });
      const newest = await page(bob, workspace.id, dm.id, '?limit=2');
      expect(newest).toEqual({ messages: [third, second], nextBefore: second.id });
      expect(await page(bob, workspace.id, dm.id, `?before=${second.id}`)).toEqual({
        messages: [first],
        nextBefore: null,
      });
    });

    it('空白だけの本文は 400 で、保存しない', async () => {
      const { alice, workspace, dm } = await dmOfAliceAndBob();

      expect((await post(alice, workspace.id, dm.id, ' \n ')).status).toBe(400);
      expect(await prisma.dmMessage.count({ where: { dmId: dm.id } })).toBe(0);
    });

    it('退会した書き手のメッセージは残り、author を null で返す（相手は退会済みとして counterpart が null）', async () => {
      const { alice, bob, workspace, dm } = await dmOfAliceAndBob();
      const byBob = await posted(bob, workspace.id, dm.id, '退会する前');
      await prisma.user.update({ where: { id: bob.id }, data: { deletedAt: new Date() } });

      expect((await page(alice, workspace.id, dm.id)).messages).toEqual([
        { ...byBob, author: null },
      ]);
      expect(await dmOf(alice, workspace.id, dm.id)).toMatchObject({
        counterpart: null,
        writable: false,
      });
    });

    // CLAUDE.md「必ずテストを書く箇所」6: 自分以外のメッセージを編集・削除できないこと。
    it('自分のメッセージは編集・削除でき、相手のメッセージは 403 not_message_author で断って変えない', async () => {
      const { alice, bob, workspace, dm } = await dmOfAliceAndBob();
      const mine = await posted(alice, workspace.id, dm.id, 'もとの本文');
      const theirs = await posted(bob, workspace.id, dm.id, '相手の本文');

      const denied = [
        await edit(alice, workspace.id, dm.id, theirs.id, '書き換え'),
        await remove(alice, workspace.id, dm.id, theirs.id),
      ];
      for (const res of denied) {
        expect(res.status).toBe(403);
        expect(await res.json()).toMatchObject({ code: 'not_message_author' });
      }

      const edited = await edit(alice, workspace.id, dm.id, mine.id, '直した本文');
      expect(edited.status).toBe(200);
      expect(await edited.json()).toMatchObject({
        body: '直した本文',
        editedAt: expect.any(String),
      });
      expect((await remove(alice, workspace.id, dm.id, mine.id)).status).toBe(204);

      const { messages } = await page(bob, workspace.id, dm.id);
      expect(messages.map(({ id, body, deleted }) => ({ id, body, deleted }))).toEqual([
        { id: theirs.id, body: '相手の本文', deleted: false },
        { id: mine.id, body: null, deleted: true },
      ]);
      // 削除済みは編集も削除もできない（404）
      expect((await edit(alice, workspace.id, dm.id, mine.id, 'もう一度')).status).toBe(404);
      expect((await remove(alice, workspace.id, dm.id, mine.id)).status).toBe(404);
    });

    it('別の DM のメッセージの id では、編集・削除を 404 で断る', async () => {
      const { alice, carol, workspace, dm } = await dmOfAliceAndBob();
      const other = await started(alice, workspace.id, carol);
      const elsewhere = await posted(alice, workspace.id, other.id, '別の DM');

      expect((await edit(alice, workspace.id, dm.id, elsewhere.id, '書き換え')).status).toBe(404);
      expect((await remove(alice, workspace.id, dm.id, elsewhere.id)).status).toBe(404);
    });

    // 機能一覧 8「相手は同一ワークスペースのメンバーに限る」と、1.5・2.2「過去のメッセージは残る」。
    it('相手がワークスペースから抜けた DM は、過去のメッセージを読め、自分のメッセージを直せるが、投稿は 409 dm_counterpart_unavailable', async () => {
      const { owner, alice, bob, workspace, dm } = await dmOfAliceAndBob();
      const mine = await posted(alice, workspace.id, dm.id, '抜ける前');

      await kick(owner, workspace.id, bob);

      expect(await dmOf(alice, workspace.id, dm.id)).toMatchObject({
        counterpart: { id: bob.id },
        writable: false,
      });
      expect((await page(alice, workspace.id, dm.id)).messages).toEqual([mine]);
      const refused = await post(alice, workspace.id, dm.id, '抜けた後');
      expect(refused.status).toBe(409);
      expect(await refused.json()).toMatchObject({ code: 'dm_counterpart_unavailable' });
      expect((await edit(alice, workspace.id, dm.id, mine.id, '直す')).status).toBe(200);
      expect(await prisma.dmMessage.count({ where: { dmId: dm.id } })).toBe(1);
    });
  });

  // 機能一覧 5.2 の DM の箇条: 当事者2人の利用者の部屋へ1回で送る。DM はチャンネルの部屋を持たない。
  describe('配信', () => {
    it('投稿すると、当事者2人の接続（送った本人の別の接続を含む）に message:new が1回ずつ届き、当事者でない接続には届かない', async () => {
      const { alice, bob, carol, workspace, dm } = await dmOfAliceAndBob();
      const aliceTabs = [await open(alice), await open(alice)];
      const bobSocket = await open(bob);
      const carolSocket = await open(carol);
      const counts = new Map<Socket, number>();
      for (const socket of [...aliceTabs, bobSocket, carolSocket]) {
        socket.on('message:new', () => counts.set(socket, (counts.get(socket) ?? 0) + 1));
      }

      const toBob = nextEvent(bobSocket, 'message:new', 2_000);
      const message = await posted(alice, workspace.id, dm.id, '届くか');

      const payload = (await toBob) as DmMessageNewPayload | undefined;
      expect(payload).toEqual({ message, sentAt: expect.any(String) });
      expect(Number.isNaN(Date.parse(payload?.sentAt ?? ''))).toBe(false);
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(aliceTabs.map((socket) => counts.get(socket))).toEqual([1, 1]);
      expect(counts.get(bobSocket)).toBe(1);
      expect(counts.get(carolSocket)).toBeUndefined();
    });

    it('編集は message:updated、削除は本文を載せない message:deleted として当事者に届き、当事者でない接続には届かない', async () => {
      const { alice, bob, carol, workspace, dm } = await dmOfAliceAndBob();
      const message = await posted(alice, workspace.id, dm.id, 'もとの本文');
      const bobSocket = await open(bob);
      const carolSocket = await open(carol);

      const updated = nextEvent(bobSocket, 'message:updated', 2_000);
      const carolUpdated = nextEvent(carolSocket, 'message:updated', 1_000);
      const res = await edit(alice, workspace.id, dm.id, message.id, '直した本文');
      expect(await updated).toEqual({ message: await res.json(), sentAt: expect.any(String) });
      expect(await carolUpdated).toBeUndefined();

      const deleted = nextEvent(bobSocket, 'message:deleted', 2_000);
      const carolDeleted = nextEvent(carolSocket, 'message:deleted', 1_000);
      expect((await remove(alice, workspace.id, dm.id, message.id)).status).toBe(204);
      const payload: DmMessageDeletedPayload = {
        dmId: dm.id,
        messageId: message.id,
        sentAt: expect.any(String) as unknown as string,
      };
      expect(await deleted).toEqual(payload);
      expect(await carolDeleted).toBeUndefined();
    });

    // 5.2「DM では、イベントの送受信のたびに、送信元と宛先が当事者であり、ともにそのワークスペースのメンバーであること（Membership があり、退会していないこと）を確認する」。
    // 接続を切らずに資格だけを失わせ、配信の側の確認が関門であることを見る（キックの処理は接続を切らない）。
    it('ワークスペースから抜けた相手と、Membership を残したまま退会した相手の接続には、DM の配信が届かない', async () => {
      const { owner, alice, bob, carol, workspace, dm } = await dmOfAliceAndBob();
      const withCarol = await started(alice, workspace.id, carol);
      const toBob = await posted(alice, workspace.id, dm.id, 'bob へ');
      const toCarol = await posted(alice, workspace.id, withCarol.id, 'carol へ');
      const aliceSocket = await open(alice);
      const bobSocket = await open(bob);
      const carolSocket = await open(carol);

      await kick(owner, workspace.id, bob);
      // 退会の処理が Membership を消し損ねた状態（書き込み側の規約の取りこぼし）
      await prisma.user.update({ where: { id: carol.id }, data: { deletedAt: new Date() } });

      const bobReceived = nextEvent(bobSocket, 'message:updated', 1_000);
      const carolReceived = nextEvent(carolSocket, 'message:updated', 1_000);
      const aliceReceived = nextEvent(aliceSocket, 'message:updated', 2_000);
      expect((await edit(alice, workspace.id, dm.id, toBob.id, 'bob へ（直した）')).status).toBe(
        200,
      );
      expect(
        (await edit(alice, workspace.id, withCarol.id, toCarol.id, 'carol へ（直した）')).status,
      ).toBe(200);

      expect(await aliceReceived).toBeDefined();
      expect(await bobReceived).toBeUndefined();
      expect(await carolReceived).toBeUndefined();
    });
  });

  // 機能一覧 10.1（F-23）: 「利用者 × DM」の既読位置からの差分で未読を求める。
  describe('未読', () => {
    it('相手の投稿を数え、自分の投稿と削除済みは数えない。既読を進めると減り、既読位置を返す。古い位置を渡しても戻らない', async () => {
      const { alice, bob, workspace, dm } = await dmOfAliceAndBob();
      const first = await posted(bob, workspace.id, dm.id, '1');
      const second = await posted(bob, workspace.id, dm.id, '2');
      const removed = await posted(bob, workspace.id, dm.id, '消す');
      await posted(alice, workspace.id, dm.id, '自分の');
      expect((await dmOf(alice, workspace.id, dm.id))?.unread).toBe(3);

      expect((await remove(bob, workspace.id, dm.id, removed.id)).status).toBe(204);
      expect((await dmOf(alice, workspace.id, dm.id))?.unread).toBe(2);

      expect((await read(alice, workspace.id, dm.id, second.id)).status).toBe(204);
      expect(await dmOf(alice, workspace.id, dm.id)).toMatchObject({
        unread: 0,
        lastReadMessageId: second.id,
      });

      expect((await read(alice, workspace.id, dm.id, first.id)).status).toBe(204);
      expect((await dmOf(alice, workspace.id, dm.id))?.lastReadMessageId).toBe(second.id);
      // 相手の側の未読は、相手の既読位置で決まる（alice が読んでも bob の未読は変わらない）
      expect((await dmOf(bob, workspace.id, dm.id))?.unread).toBe(1);
    });

    it('既読の更新は、その DM に無いメッセージ・削除済みのメッセージの id を 404 で断る', async () => {
      const { alice, bob, carol, workspace, dm } = await dmOfAliceAndBob();
      const other = await started(alice, workspace.id, carol);
      const elsewhere = await posted(carol, workspace.id, other.id, '別の DM');
      const removed = await posted(bob, workspace.id, dm.id, '消す');
      expect((await remove(bob, workspace.id, dm.id, removed.id)).status).toBe(204);

      for (const id of [elsewhere.id, removed.id, MISSING_ID]) {
        expect((await read(alice, workspace.id, dm.id, id)).status).toBe(404);
      }
      expect(await prisma.dmRead.count({ where: { dmId: dm.id } })).toBe(0);
    });

    it('ワークスペースから抜けて戻った当事者は、既読位置を持たない状態に戻り、戻る前のメッセージを未読に数えない', async () => {
      const { owner, alice, bob, workspace, dm } = await dmOfAliceAndBob();
      const before = await posted(alice, workspace.id, dm.id, '抜ける前');
      expect((await read(bob, workspace.id, dm.id, before.id)).status).toBe(204);
      await posted(alice, workspace.id, dm.id, '抜ける前の未読');

      await kick(owner, workspace.id, bob);
      await prisma.membership.create({
        data: { workspaceId: workspace.id, userId: bob.id, role: 'MEMBER' },
      });
      expect(await dmOf(bob, workspace.id, dm.id)).toMatchObject({
        unread: 0,
        lastReadMessageId: null,
      });

      await posted(alice, workspace.id, dm.id, '戻った後');
      expect((await dmOf(bob, workspace.id, dm.id))?.unread).toBe(1);
    });

    // 5.2: unread:updated は、その未読の持ち主の利用者の部屋へだけ送る（DM の未読でも、相手には送らない）。
    it('投稿すると相手にだけ unread:updated（dmId と未読数）が届き、書いた本人と当事者でない接続には届かない。既読を進めると本人にだけ届く', async () => {
      const { alice, bob, carol, workspace, dm } = await dmOfAliceAndBob();
      const aliceSocket = await open(alice);
      const bobSocket = await open(bob);
      const carolSocket = await open(carol);

      const toBob = nextEvent(bobSocket, 'unread:updated', 2_000);
      const toAlice = nextEvent(aliceSocket, 'unread:updated', 1_000);
      const toCarol = nextEvent(carolSocket, 'unread:updated', 1_000);
      const message = await posted(alice, workspace.id, dm.id, '未読になる');

      const payload: DmUnreadUpdatedPayload = {
        dmId: dm.id,
        unread: 1,
        sentAt: expect.any(String) as unknown as string,
      };
      expect(await toBob).toEqual(payload);
      expect(await toAlice).toBeUndefined();
      expect(await toCarol).toBeUndefined();

      const readByBob = nextEvent(bobSocket, 'unread:updated', 2_000);
      const readToAlice = nextEvent(aliceSocket, 'unread:updated', 1_000);
      expect((await read(bob, workspace.id, dm.id, message.id)).status).toBe(204);
      expect(await readByBob).toEqual({ ...payload, unread: 0 });
      expect(await readToAlice).toBeUndefined();
    });

    it('相手の削除で未読が減ると、相手（未読の持ち主）に unread:updated が届く', async () => {
      const { alice, bob, workspace, dm } = await dmOfAliceAndBob();
      const message = await posted(alice, workspace.id, dm.id, '消される');
      const bobSocket = await open(bob);

      const toBob = nextEvent(bobSocket, 'unread:updated', 2_000);
      expect((await remove(alice, workspace.id, dm.id, message.id)).status).toBe(204);

      expect(await toBob).toMatchObject({ dmId: dm.id, unread: 0 });
    });
  });
});
