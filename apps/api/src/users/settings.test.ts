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

type UserSettings =
  paths['/users/me/settings']['get']['responses'][200]['content']['application/json'];

let sequence = 0;
let ipSequence = 0;
function nextIp(): string {
  ipSequence += 1;
  return `2001:db8::f:${ipSequence.toString(16)}`;
}

type LoggedIn = { authorization: string; id: string; loginId: string };

// 機能一覧 10.1（F-23）: 利用者ごとの設定。プロフィールとは別の経路で、本人にしか返さない。#509。
describe('利用者の設定（F-23）', () => {
  let postgres: StartedPostgreSqlContainer;
  let valkey: StartedTestContainer;
  let app: INestApplication;
  let base: string;
  let prisma: PrismaService;

  async function login(): Promise<LoggedIn> {
    sequence += 1;
    const loginId = `Set_${Date.now().toString(36)}_${sequence}`;
    const user = await prisma.user.create({
      data: {
        loginId,
        displayName: `設定の人${sequence}`,
        passwordHash: await hashSecret('settings-password'),
      },
    });
    const res = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': nextIp() },
      body: JSON.stringify({ userId: loginId, password: 'settings-password' }),
    });
    expect(res.status).toBe(200);
    const { accessToken } = (await res.json()) as { accessToken: string };
    return { authorization: `Bearer ${accessToken}`, id: user.id, loginId };
  }

  /**
   * その利用者の既読位置を1つ作る（API を通さず、最小限の行だけを置く）。
   * 既読位置は `Message` への外部キーを持つため、ワークスペース・参加・チャンネル・参加者・本体まで要る。
   */
  async function readPositionOf(user: LoggedIn): Promise<void> {
    sequence += 1;
    const name = `settings-${sequence}`;
    // 所有は `Membership.role` が持つ（`Workspace` に所有者の列は無い）
    const workspace = await prisma.workspace.create({ data: { name: `設定の場所${sequence}` } });
    await prisma.membership.create({
      data: { workspaceId: workspace.id, userId: user.id, role: 'OWNER' },
    });
    const channel = await prisma.channel.create({
      data: { workspaceId: workspace.id, name, baseName: name, visibility: 'PUBLIC' },
    });
    await prisma.channelMember.create({
      data: { channelId: channel.id, workspaceId: workspace.id, userId: user.id },
    });
    const message = await prisma.message.create({
      data: {
        channelId: channel.id,
        workspaceId: workspace.id,
        authorId: user.id,
        body: '読んだところ',
      },
    });
    await prisma.channelRead.create({
      data: {
        channelId: channel.id,
        workspaceId: workspace.id,
        userId: user.id,
        lastReadMessageId: message.id,
      },
    });
  }

  function request(
    method: 'GET' | 'PATCH',
    authorization: string,
    body?: unknown,
  ): Promise<Response> {
    return fetch(`${base}/api/users/me/settings`, {
      method,
      headers: {
        authorization,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
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

  it('既定では、スレッドの未読を含める', async () => {
    const user = await login();

    const res = await request('GET', user.authorization);

    expect(res.status).toBe(200);
    expect((await res.json()) as UserSettings).toEqual({ threadUnreadIncluded: true });
  });

  it('切り替えると、変えた後の設定を返し、次の取得にも残る', async () => {
    const user = await login();

    const updated = await request('PATCH', user.authorization, { threadUnreadIncluded: false });

    expect(updated.status).toBe(200);
    expect((await updated.json()) as UserSettings).toEqual({ threadUnreadIncluded: false });
    const again = await request('GET', user.authorization);
    expect((await again.json()) as UserSettings).toEqual({ threadUnreadIncluded: false });
  });

  it('他の利用者の設定は混ざらない（本人のものだけを返す）', async () => {
    const alice = await login();
    const bob = await login();
    expect(
      (await request('PATCH', alice.authorization, { threadUnreadIncluded: false })).status,
    ).toBe(200);

    const forBob = await request('GET', bob.authorization);

    expect((await forBob.json()) as UserSettings).toEqual({ threadUnreadIncluded: true });
  });

  it('トークンが無ければ 401', async () => {
    const res = await fetch(`${base}/api/users/me/settings`);

    expect(res.status).toBe(401);
  });

  // **切り替えても既読位置は動かさない**（一括で既読扱いにしない。要件定義書 3.5.2）。
  it('切り替えても既読位置は動かさない', async () => {
    const user = await login();
    await readPositionOf(user);
    const before = await prisma.channelRead.findFirstOrThrow({ where: { userId: user.id } });

    await request('PATCH', user.authorization, { threadUnreadIncluded: false });

    const after = await prisma.channelRead.findFirstOrThrow({ where: { userId: user.id } });
    expect(after.lastReadMessageId).toBe(before.lastReadMessageId);
    expect(await prisma.channelRead.count({ where: { userId: user.id } })).toBe(1);
  });
});
