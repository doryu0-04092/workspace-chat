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
type SearchResult =
  paths['/workspaces/{id}/search']['get']['responses'][200]['content']['application/json'];
type ErrorResponse =
  paths['/workspaces/{id}/search']['get']['responses'][403]['content']['application/json'];

const NOT_FOUND = { code: 'not_found', message: '見つかりません' };
const MISSING_ID = '00000000-0000-7000-8000-000000000000';

let sequence = 0;
let ipSequence = 0;
function nextIp(): string {
  ipSequence += 1;
  return `2001:db8::5:${ipSequence.toString(16)}`;
}

type LoggedIn = { authorization: string; id: string; loginId: string };

// 機能一覧 12.1（F-30 / F-31）: 検索と検索の認可。#582。
// CLAUDE.md「必ずテストを書く箇所」: 検索がプライベートチャンネルを漏らさないこと。
describe('検索（F-30・F-31）', () => {
  let postgres: StartedPostgreSqlContainer;
  let valkey: StartedTestContainer;
  let app: INestApplication;
  let base: string;
  let prisma: PrismaService;

  async function login(displayName?: string): Promise<LoggedIn> {
    sequence += 1;
    const loginId = `Se_${Date.now().toString(36)}_${sequence}`;
    const user = await prisma.user.create({
      data: {
        loginId,
        displayName: displayName ?? `検索の人${sequence}`,
        passwordHash: await hashSecret('search-password'),
      },
    });
    const res = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': nextIp() },
      body: JSON.stringify({ userId: loginId, password: 'search-password' }),
    });
    expect(res.status).toBe(200);
    const { accessToken } = (await res.json()) as { accessToken: string };
    return { authorization: `Bearer ${accessToken}`, id: user.id, loginId };
  }

  /** オーナーのワークスペースを作り、渡した利用者をメンバーとして参加させる。 */
  async function workspaceWith(owner: LoggedIn, ...members: LoggedIn[]): Promise<Workspace> {
    const res = await fetch(`${base}/api/workspaces`, {
      method: 'POST',
      headers: { authorization: owner.authorization, 'content-type': 'application/json' },
      body: JSON.stringify({ name: '検索の場所' }),
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

  /** チャンネルを作り、渡した利用者を参加させる（オーナーが参加していないチャンネル・アーカイブ済みを用意するため API を通さない）。 */
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

  async function messageRow(
    workspaceId: string,
    channelId: string,
    author: LoggedIn,
    body: string,
    extra: { parentId?: string; deleted?: boolean } = {},
  ): Promise<string> {
    const row = await prisma.message.create({
      data: {
        workspaceId,
        channelId,
        authorId: author.id,
        body,
        parentId: extra.parentId ?? null,
        deletedAt: extra.deleted ? new Date() : null,
      },
    });
    return row.id;
  }

  function search(by: LoggedIn, workspaceId: string, q: string): Promise<Response> {
    return fetch(`${base}/api/workspaces/${workspaceId}/search?q=${encodeURIComponent(q)}`, {
      headers: { authorization: by.authorization },
    });
  }

  async function found(by: LoggedIn, workspaceId: string, q: string): Promise<SearchResult> {
    const res = await search(by, workspaceId, q);
    expect(res.status).toBe(200);
    return (await res.json()) as SearchResult;
  }

  const bodiesOf = (result: SearchResult) => result.messages.map(({ body }) => body);
  const channelNamesOf = (result: SearchResult) => result.channels.map(({ name }) => name);

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

  describe('プライベートチャンネルを漏らさない（F-31）', () => {
    it('非参加者（メンバー・オーナー）には、プライベートチャンネルの本文が一切現れない。参加者には現れる', async () => {
      const owner = await login();
      const insider = await login();
      const outsider = await login();
      const workspace = await workspaceWith(owner, insider, outsider);
      const secret = await channelRow(workspace.id, 'secret', 'PRIVATE', [insider]);
      const open = await channelRow(workspace.id, 'open', 'PUBLIC', [insider, outsider, owner]);
      await messageRow(workspace.id, secret, insider, '合言葉は極秘の議事録です');
      await messageRow(workspace.id, open, insider, '公開の議事録です');

      expect(bodiesOf(await found(insider, workspace.id, '議事録')).sort()).toEqual([
        '公開の議事録です',
        '合言葉は極秘の議事録です',
      ]);
      for (const viewer of [outsider, owner]) {
        const result = await found(viewer, workspace.id, '議事録');
        // 「何も返さない」実装で通らないよう、パブリックの側が返っていることも見る
        expect(bodiesOf(result)).toEqual(['公開の議事録です']);
        expect(JSON.stringify(result)).not.toContain('極秘');
        expect(channelNamesOf(result)).not.toContain('secret');
      }
    });

    it('in:# で参加していないプライベートチャンネルを指すと、無いチャンネルと同じ 404 で、本文を返さない', async () => {
      const owner = await login();
      const insider = await login();
      const workspace = await workspaceWith(owner, insider);
      const secret = await channelRow(workspace.id, 'secret', 'PRIVATE', [insider]);
      await messageRow(workspace.id, secret, insider, '極秘の議事録');

      for (const q of ['in:#secret 議事録', 'in:#nothing 議事録']) {
        const res = await search(owner, workspace.id, q);
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual(NOT_FOUND);
      }
      expect(bodiesOf(await found(insider, workspace.id, 'in:#secret 議事録'))).toEqual([
        '極秘の議事録',
      ]);
    });

    it('in:# で参加していないパブリックチャンネルを指すと 403（not_a_channel_member）', async () => {
      const owner = await login();
      const member = await login();
      const workspace = await workspaceWith(owner, member);
      const open = await channelRow(workspace.id, 'open', 'PUBLIC', [owner]);
      await messageRow(workspace.id, open, owner, '公開の議事録');

      const res = await search(member, workspace.id, 'in:#open 議事録');
      expect(res.status).toBe(403);
      expect(((await res.json()) as ErrorResponse).code).toBe('not_a_channel_member');
    });

    it('参加していないパブリックチャンネルのメッセージは返さない（検索対象は参加しているチャンネルだけ）', async () => {
      const owner = await login();
      const member = await login();
      const workspace = await workspaceWith(owner, member);
      const open = await channelRow(workspace.id, 'open', 'PUBLIC', [owner]);
      const mine = await channelRow(workspace.id, 'mine', 'PUBLIC', [member]);
      await messageRow(workspace.id, open, owner, '入っていない側の議事録');
      await messageRow(workspace.id, mine, member, '入っている側の議事録');

      expect(bodiesOf(await found(member, workspace.id, '議事録'))).toEqual([
        '入っている側の議事録',
      ]);
    });

    it('チャンネルから抜けた・ワークスペースから外れたら、そのチャンネルのメッセージは返らない', async () => {
      const owner = await login();
      const member = await login();
      const workspace = await workspaceWith(owner, member);
      const secret = await channelRow(workspace.id, 'secret', 'PRIVATE', [owner, member]);
      await messageRow(workspace.id, secret, owner, '抜ける前の議事録');
      expect(bodiesOf(await found(member, workspace.id, '議事録'))).toEqual(['抜ける前の議事録']);

      await prisma.channelMember.deleteMany({ where: { channelId: secret, userId: member.id } });
      expect(bodiesOf(await found(member, workspace.id, '議事録'))).toEqual([]);

      await prisma.membership.deleteMany({
        where: { workspaceId: workspace.id, userId: member.id },
      });
      const res = await search(member, workspace.id, '議事録');
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual(NOT_FOUND);
    });

    it('所属していないワークスペースは、存在の有無によらず 404', async () => {
      const owner = await login();
      const stranger = await login();
      const workspace = await workspaceWith(owner);

      for (const workspaceId of [workspace.id, MISSING_ID]) {
        const res = await search(stranger, workspaceId, '議事録');
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual(NOT_FOUND);
      }
    });

    it('別のワークスペースのメッセージは返さない（同じ利用者が両方に参加していても）', async () => {
      const owner = await login();
      const first = await workspaceWith(owner);
      const second = await workspaceWith(owner);
      const a = await channelRow(first.id, 'a', 'PUBLIC', [owner]);
      const b = await channelRow(second.id, 'b', 'PUBLIC', [owner]);
      await messageRow(first.id, a, owner, 'こちらの議事録');
      await messageRow(second.id, b, owner, 'あちらの議事録');

      expect(bodiesOf(await found(owner, first.id, '議事録'))).toEqual(['こちらの議事録']);
    });

    // CLAUDE.md「必ずテストを書く箇所」: 退会済みのトークンが読み取りでも拒否されること。
    it('退会済みのトークンは 401', async () => {
      const owner = await login();
      const workspace = await workspaceWith(owner);
      await prisma.user.update({ where: { id: owner.id }, data: { deletedAt: new Date() } });

      expect((await search(owner, workspace.id, '議事録')).status).toBe(401);
    });
  });

  describe('メッセージ（F-30）', () => {
    it('日本語の部分一致で当たり、削除済みは返さず、返信は親の id を付けて返す。新しい順', async () => {
      const owner = await login();
      const workspace = await workspaceWith(owner);
      const channel = await channelRow(workspace.id, 'general', 'PUBLIC', [owner]);
      const parent = await messageRow(workspace.id, channel, owner, '明日の全文検索の打ち合わせ');
      await messageRow(workspace.id, channel, owner, '消した全文検索の話', { deleted: true });
      const reply = await messageRow(workspace.id, channel, owner, '全文検索は索引で速くなる', {
        parentId: parent,
      });

      const result = await found(owner, workspace.id, '全文検索');
      expect(result.messages).toEqual([
        {
          id: reply,
          channel: {
            id: channel,
            name: 'general',
            visibility: 'PUBLIC',
            archived: false,
            joined: true,
          },
          parentId: parent,
          author: {
            id: owner.id,
            userId: owner.loginId,
            displayName: expect.any(String) as string,
          },
          body: '全文検索は索引で速くなる',
          createdAt: expect.any(String) as string,
          editedAt: null,
        },
        expect.objectContaining({ id: parent, parentId: null }),
      ]);
    });

    // 機能一覧 3.2: アーカイブされたチャンネルの過去のメッセージは検索結果に出る（参加者に限る）。
    it('アーカイブ済みのチャンネルのメッセージは、参加者にだけ返る', async () => {
      const owner = await login();
      const member = await login();
      const workspace = await workspaceWith(owner, member);
      const archived = await channelRow(workspace.id, 'old', 'PUBLIC', [owner], true);
      await messageRow(workspace.id, archived, owner, '昔の議事録');

      const result = await found(owner, workspace.id, '議事録');
      expect(bodiesOf(result)).toEqual(['昔の議事録']);
      expect(result.messages[0]?.channel).toMatchObject({ name: 'old-1', archived: true });
      expect(bodiesOf(await found(member, workspace.id, '議事録'))).toEqual([]);
    });

    it('語はすべてを含むものに当たり、LIKE の特殊文字は文字として照合する', async () => {
      const owner = await login();
      const workspace = await workspaceWith(owner);
      const channel = await channelRow(workspace.id, 'general', 'PUBLIC', [owner]);
      await messageRow(workspace.id, channel, owner, '進捗は100%です');
      await messageRow(workspace.id, channel, owner, '進捗は1000件です');
      await messageRow(workspace.id, channel, owner, 'snake_case と進捗');
      await messageRow(workspace.id, channel, owner, 'snakeXcase');

      expect(bodiesOf(await found(owner, workspace.id, '100%'))).toEqual(['進捗は100%です']);
      expect(bodiesOf(await found(owner, workspace.id, 'e_c'))).toEqual(['snake_case と進捗']);
      expect(bodiesOf(await found(owner, workspace.id, '進捗 snake'))).toEqual([
        'snake_case と進捗',
      ]);
    });

    it('from:@ は大文字小文字によらず投稿者で絞り、退会した投稿者も指せる（author は null）', async () => {
      const owner = await login();
      const member = await login();
      const workspace = await workspaceWith(owner, member);
      const channel = await channelRow(workspace.id, 'general', 'PUBLIC', [owner, member]);
      await messageRow(workspace.id, channel, owner, 'オーナーの議事録');
      await messageRow(workspace.id, channel, member, 'メンバーの議事録');

      expect(
        bodiesOf(await found(owner, workspace.id, `from:@${member.loginId.toUpperCase()} 議事録`)),
      ).toEqual(['メンバーの議事録']);

      // 退会（機能一覧 1.5）: 論理削除し、所属を消す（チャンネルの参加は連鎖して消える）
      await prisma.user.update({ where: { id: member.id }, data: { deletedAt: new Date() } });
      await prisma.membership.deleteMany({ where: { userId: member.id } });
      const result = await found(owner, workspace.id, `from:@${member.loginId}`);
      expect(bodiesOf(result)).toEqual(['メンバーの議事録']);
      expect(result.messages[0]?.author).toBeNull();
    });

    it('in:# はそのチャンネルに絞る', async () => {
      const owner = await login();
      const workspace = await workspaceWith(owner);
      const a = await channelRow(workspace.id, 'a', 'PUBLIC', [owner]);
      const b = await channelRow(workspace.id, 'b', 'PUBLIC', [owner]);
      await messageRow(workspace.id, a, owner, 'a の議事録');
      await messageRow(workspace.id, b, owner, 'b の議事録');

      expect(bodiesOf(await found(owner, workspace.id, 'in:#b 議事録'))).toEqual(['b の議事録']);
    });

    it('最大20件で、新しい順', async () => {
      const owner = await login();
      const workspace = await workspaceWith(owner);
      const channel = await channelRow(workspace.id, 'general', 'PUBLIC', [owner]);
      for (let n = 1; n <= 21; n += 1) {
        await messageRow(workspace.id, channel, owner, `議事録 ${n}`);
      }

      const result = await found(owner, workspace.id, '議事録');
      expect(result.messages).toHaveLength(20);
      expect(result.messages[0]?.body).toBe('議事録 21');
      expect(result.messages[19]?.body).toBe('議事録 2');
    });

    it('本文の索引（pg_bigm の 2-gram）が LIKE の照合に使える', async () => {
      const plan = await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off');
        return tx.$queryRaw<{ 'QUERY PLAN': string }[]>`
          EXPLAIN SELECT "id" FROM "Message" WHERE "body" LIKE likequery(${'議事録'})
        `;
      });
      expect(plan.map((row) => row['QUERY PLAN']).join('\n')).toContain('Message_body_bigm_idx');
    });
  });

  describe('チャンネルとユーザー（F-30 の種別ごとの分類）', () => {
    it('チャンネルは、パブリックでアーカイブされていないものと、参加しているもの（アーカイブ済みを含む）だけ', async () => {
      const owner = await login();
      const member = await login();
      const workspace = await workspaceWith(owner, member);
      await channelRow(workspace.id, 'dev-open', 'PUBLIC', [owner]);
      await channelRow(workspace.id, 'dev-secret', 'PRIVATE', [owner]);
      await channelRow(workspace.id, 'dev-joined', 'PRIVATE', [member]);
      await channelRow(workspace.id, 'dev-archived', 'PUBLIC', [owner], true);
      await channelRow(workspace.id, 'dev-archived-mine', 'PUBLIC', [member], true);

      const result = await found(member, workspace.id, 'DEV');
      expect(result.channels).toEqual([
        {
          id: expect.any(String) as string,
          name: 'dev-archived-mine-1',
          visibility: 'PUBLIC',
          archived: true,
          joined: true,
        },
        {
          id: expect.any(String) as string,
          name: 'dev-joined',
          visibility: 'PRIVATE',
          archived: false,
          joined: true,
        },
        {
          id: expect.any(String) as string,
          name: 'dev-open',
          visibility: 'PUBLIC',
          archived: false,
          joined: false,
        },
      ]);
    });

    it('ユーザーは、そのワークスペースのメンバーで退会していない利用者を、ユーザーID か表示名で当てる', async () => {
      const owner = await login('オーナー');
      const member = await login('山田 花子');
      const retired = await login('山田 退会');
      const stranger = await login('山田 よそ');
      const workspace = await workspaceWith(owner, member, retired);
      await workspaceWith(stranger);
      await prisma.user.update({ where: { id: retired.id }, data: { deletedAt: new Date() } });

      expect((await found(owner, workspace.id, '山田')).users).toEqual([
        { id: member.id, userId: member.loginId, displayName: '山田 花子' },
      ]);
      expect((await found(owner, workspace.id, member.loginId.toLowerCase())).users).toEqual([
        { id: member.id, userId: member.loginId, displayName: '山田 花子' },
      ]);
    });
  });

  describe('検索のレート制限', () => {
    it('同じ利用者の検索は1分に60回までで、超えたら 429 too_many_requests と Retry-After を返す。別の利用者は断らない', async () => {
      const alice = await login();
      const bob = await login();
      const workspace = await workspaceWith(alice, bob);

      for (let i = 0; i < 60; i += 1) {
        expect((await search(alice, workspace.id, `語${i}`)).status).toBe(200);
      }
      const limited = await search(alice, workspace.id, '多すぎる');
      expect(limited.status).toBe(429);
      expect(((await limited.json()) as ErrorResponse).code).toBe('too_many_requests');
      expect(limited.headers.get('retry-after')).not.toBeNull();

      expect((await search(bob, workspace.id, '別の人')).status).toBe(200);
    });
  });

  describe('入力の形', () => {
    it.each([
      { label: '無い', query: '', status: 400 },
      { label: '空', query: '?q=', status: 400 },
      { label: '空白だけ', query: `?q=${encodeURIComponent(' 　')}`, status: 400 },
      { label: '201 文字', query: `?q=${encodeURIComponent('あ'.repeat(201))}`, status: 400 },
      { label: '200 文字', query: `?q=${encodeURIComponent('🍵'.repeat(200))}`, status: 200 },
    ])('q が $label なら $status', async ({ query, status }) => {
      const owner = await login();
      const workspace = await workspaceWith(owner);
      const res = await fetch(`${base}/api/workspaces/${workspace.id}/search${query}`, {
        headers: { authorization: owner.authorization },
      });
      expect(res.status).toBe(status);
    });
  });
});
