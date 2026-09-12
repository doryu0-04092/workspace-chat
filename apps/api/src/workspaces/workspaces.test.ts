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
  paths['/workspaces/{id}']['get']['responses'][404]['content']['application/json'];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let sequence = 0;
let ipSequence = 0;
function nextIp(): string {
  ipSequence += 1;
  return `2001:db8::9:${ipSequence.toString(16)}`;
}

// 機能一覧 2.1（F-06）。名前の規則は #290（決定・2026-09-12・依頼側）。
describe('/api/workspaces（F-06）', () => {
  let postgres: StartedPostgreSqlContainer;
  let valkey: StartedTestContainer;
  let app: INestApplication;
  let base: string;
  let prisma: PrismaService;

  /** 利用者を作ってログインし、Authorization ヘッダーの値・User.id・登録したユーザーID を返す。 */
  async function login(): Promise<{ authorization: string; id: string; loginId: string }> {
    sequence += 1;
    const loginId = `Ws_${Date.now().toString(36)}_${sequence}`;
    const user = await prisma.user.create({
      data: {
        loginId,
        displayName: `利用者${sequence}`,
        passwordHash: await hashSecret('ws-password'),
      },
    });
    const res = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': nextIp() },
      body: JSON.stringify({ userId: loginId, password: 'ws-password' }),
    });
    expect(res.status).toBe(200);
    const { accessToken } = (await res.json()) as { accessToken: string };
    return { authorization: `Bearer ${accessToken}`, id: user.id, loginId };
  }

  function post(authorization: string, body: unknown): Promise<Response> {
    return fetch(`${base}/api/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization },
      body: JSON.stringify(body),
    });
  }

  function get(authorization: string, path = ''): Promise<Response> {
    return fetch(`${base}/api/workspaces${path}`, { headers: { authorization } });
  }

  async function create(authorization: string, name: string): Promise<Workspace> {
    const res = await post(authorization, { name });
    expect(res.status).toBe(201);
    return (await res.json()) as Workspace;
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

  it('作成すると、作成者がオーナーとして所属した状態になる', async () => {
    const { authorization, id } = await login();
    const res = await post(authorization, { name: '開発チーム' });

    expect(res.status).toBe(201);
    const workspace = (await res.json()) as Workspace;
    expect(workspace).toEqual({
      id: expect.stringMatching(UUID) as string,
      name: '開発チーム',
      createdAt: expect.any(String) as string,
      role: 'OWNER',
    });
    // 所属の根拠は Membership の行だけ（schema.prisma）。作成と同じ文で作られ、オーナーは1人。
    const memberships = await prisma.membership.findMany({
      where: { workspaceId: workspace.id },
      select: { userId: true, role: true },
    });
    expect(memberships).toEqual([{ userId: id, role: 'OWNER' }]);
  });

  // #290: 1〜50 文字（コードポイント）・空白だけは不可・同名を許す。
  it.each([
    { label: '空', name: '', status: 400 },
    { label: '空白だけ', name: ' \t　', status: 400 },
    { label: '50 文字（多バイト）', name: 'あ'.repeat(50), status: 201 },
    { label: '51 文字', name: 'あ'.repeat(51), status: 400 },
    { label: '50 文字（サロゲートペア。UTF-16 では 100）', name: '🍵'.repeat(50), status: 201 },
  ])('名前が $label なら $status', async ({ name, status }) => {
    const { authorization } = await login();
    const res = await post(authorization, { name });
    expect(res.status).toBe(status);
    if (status === 400) {
      expect(((await res.json()) as ErrorResponse).code).toBe('validation_failed');
    }
  });

  it('同じ名前のワークスペースを、別の利用者も同じ利用者も作れる', async () => {
    const alice = await login();
    const bob = await login();
    const first = await create(alice.authorization, '同名');
    const second = await create(alice.authorization, '同名');
    const third = await create(bob.authorization, '同名');
    expect(new Set([first.id, second.id, third.id]).size).toBe(3);
  });

  it('一覧は、自分が所属するワークスペースだけを参加した順に返す', async () => {
    const alice = await login();
    const bob = await login();
    const a1 = await create(alice.authorization, 'A1');
    const b1 = await create(bob.authorization, 'B1');
    const a2 = await create(alice.authorization, 'A2');

    const res = await get(alice.authorization);
    expect(res.status).toBe(200);
    expect((await res.json()) as Workspace[]).toEqual([a1, a2]);
    expect((await (await get(bob.authorization)).json()) as Workspace[]).toEqual([b1]);
  });

  it('取得は所属しているものだけで、所属していなければ存在の有無によらず 404（本体は「見つかりません」）', async () => {
    const alice = await login();
    const bob = await login();
    const workspace = await create(alice.authorization, 'アリスの');

    const mine = await get(alice.authorization, `/${workspace.id}`);
    expect(mine.status).toBe(200);
    expect((await mine.json()) as Workspace).toEqual(workspace);

    const others = await get(bob.authorization, `/${workspace.id}`);
    expect(others.status).toBe(404);
    expect((await others.json()) as ErrorResponse).toEqual({
      code: 'not_found',
      message: '見つかりません',
    });

    const missing = await get(bob.authorization, '/00000000-0000-7000-8000-000000000000');
    expect(missing.status).toBe(404);
    expect((await missing.json()) as ErrorResponse).toEqual({
      code: 'not_found',
      message: '見つかりません',
    });

    // id の形は仕様が確かめる（uuid でなければ 400）。
    expect((await get(bob.authorization, '/not-a-uuid')).status).toBe(400);
  });

  // 取得と参加者一覧の可否は所属で決まり、役割（OWNER）では決まらない（#314）。
  it('オーナー以外のメンバーも、取得と参加者一覧を 200 で引ける', async () => {
    const alice = await login();
    const bob = await login();
    const workspace = await create(alice.authorization, 'メンバーの取得');
    await prisma.membership.create({
      data: { workspaceId: workspace.id, userId: bob.id, role: 'MEMBER' },
    });

    const got = await get(bob.authorization, `/${workspace.id}`);
    expect(got.status).toBe(200);
    expect((await got.json()) as Workspace).toEqual({ ...workspace, role: 'MEMBER' });

    const members = await get(bob.authorization, `/${workspace.id}/members`);
    expect(members.status).toBe(200);
    expect(((await members.json()) as WorkspaceMember[]).map((m) => m.role).sort()).toEqual([
      'MEMBER',
      'OWNER',
    ]);
  });

  it('参加者一覧は退会済みを含まず、所属していなければ 404', async () => {
    const alice = await login();
    const bob = await login();
    const carol = await login();
    const dave = await login();
    const workspace = await create(alice.authorization, '参加者');
    await prisma.membership.createMany({
      data: [
        { workspaceId: workspace.id, userId: bob.id, role: 'MEMBER' },
        { workspaceId: workspace.id, userId: carol.id, role: 'MEMBER' },
      ],
    });
    // 退会は論理削除で、Membership の行は自動では消えない（schema.prisma）。一覧の側で除くこと（機能一覧 1.5・2.1）。
    await prisma.user.update({ where: { id: carol.id }, data: { deletedAt: new Date() } });

    const res = await get(alice.authorization, `/${workspace.id}/members`);
    expect(res.status).toBe(200);
    expect((await res.json()) as WorkspaceMember[]).toEqual([
      {
        id: alice.id,
        userId: alice.loginId,
        displayName: expect.any(String) as string,
        role: 'OWNER',
      },
      {
        id: bob.id,
        userId: bob.loginId,
        displayName: expect.any(String) as string,
        role: 'MEMBER',
      },
    ]);

    const outsider = await get(dave.authorization, `/${workspace.id}/members`);
    expect(outsider.status).toBe(404);
    expect((await outsider.json()) as ErrorResponse).toEqual({
      code: 'not_found',
      message: '見つかりません',
    });
  });

  it('トークンが無ければ 401', async () => {
    const res = await fetch(`${base}/api/workspaces`);
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Bearer');
  });
});
