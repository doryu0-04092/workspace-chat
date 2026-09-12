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

type Profile = paths['/users/me']['get']['responses'][200]['content']['application/json'];
type ErrorResponse = paths['/users/me']['patch']['responses'][400]['content']['application/json'];

let sequence = 0;
let ipSequence = 0;
function nextIp(): string {
  ipSequence += 1;
  return `2001:db8::8:${ipSequence.toString(16)}`;
}

// 機能一覧 1.3（F-04。アバターを除く）。
describe('GET・PATCH /api/users/me（F-04）', () => {
  let postgres: StartedPostgreSqlContainer;
  let valkey: StartedTestContainer;
  let app: INestApplication;
  let base: string;
  let prisma: PrismaService;

  /** 利用者を作ってログインし、Authorization ヘッダーの値・User.id・登録したユーザーID を返す。 */
  async function login(): Promise<{ authorization: string; id: string; loginId: string }> {
    sequence += 1;
    const loginId = `Profile_${Date.now().toString(36)}_${sequence}`;
    const user = await prisma.user.create({
      data: {
        loginId,
        displayName: '最初の名前',
        passwordHash: await hashSecret('profile-password'),
      },
    });
    const res = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': nextIp() },
      body: JSON.stringify({ userId: loginId, password: 'profile-password' }),
    });
    expect(res.status).toBe(200);
    const { accessToken } = (await res.json()) as { accessToken: string };
    return { authorization: `Bearer ${accessToken}`, id: user.id, loginId };
  }

  function getMe(authorization: string): Promise<Response> {
    return fetch(`${base}/api/users/me`, { headers: { authorization } });
  }

  function patchMe(authorization: string, body: unknown): Promise<Response> {
    return fetch(`${base}/api/users/me`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization },
      body: JSON.stringify(body),
    });
  }

  async function row(id: string) {
    return prisma.user.findUniqueOrThrow({
      where: { id },
      select: { loginId: true, displayName: true, statusEmoji: true, statusText: true },
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

  it('GET は、トークンの利用者のプロフィールを返す（ユーザーID は登録時の綴り）', async () => {
    const { authorization, id, loginId } = await login();
    const res = await getMe(authorization);

    expect(res.status).toBe(200);
    expect((await res.json()) as Profile).toEqual({
      id,
      userId: loginId,
      displayName: '最初の名前',
      avatarUrl: null,
      status: null,
    });
  });

  it('PATCH は送った項目だけを変え、変えた後のプロフィールを返す', async () => {
    const { authorization, id } = await login();
    const other = await login();

    const res = await patchMe(authorization, { displayName: '新しい名前' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as Profile).displayName).toBe('新しい名前');

    const status = await patchMe(authorization, { status: { emoji: '🍵', text: '休憩中' } });
    expect(status.status).toBe(200);
    expect((await status.json()) as Profile).toMatchObject({
      displayName: '新しい名前',
      status: { emoji: '🍵', text: '休憩中' },
    });
    expect((await (await getMe(authorization)).json()) as Profile).toMatchObject({
      displayName: '新しい名前',
      status: { emoji: '🍵', text: '休憩中' },
    });
    // 他の利用者の行は変わらない。
    expect((await row(other.id)).displayName).toBe('最初の名前');
    expect((await row(id)).displayName).toBe('新しい名前');
  });

  // 機能一覧 1.3: 絵文字とテキストは1セット（決定・2026-09-12・依頼側。#283）。
  it('ステータスは絵文字とテキストの1セットで、null を送ると両方消える', async () => {
    const { authorization, id } = await login();
    await patchMe(authorization, { status: { emoji: '🍵', text: '休憩中' } });
    expect(await row(id)).toMatchObject({ statusEmoji: '🍵', statusText: '休憩中' });

    const res = await patchMe(authorization, { status: null });
    expect(res.status).toBe(200);
    expect(((await res.json()) as Profile).status).toBeNull();
    expect(await row(id)).toMatchObject({ statusEmoji: null, statusText: null });
  });

  it.each([
    ['絵文字だけ', { emoji: '🍵' }],
    ['テキストだけ', { text: '休憩中' }],
    ['絵文字が null', { emoji: null, text: '休憩中' }],
    ['空のオブジェクト', {}],
  ])('ステータスの片方が欠けた本体（%s）は 400 で、何も変えない', async (_label, status) => {
    const { authorization, id } = await login();
    const res = await patchMe(authorization, { status, displayName: '変える' });

    expect(res.status).toBe(400);
    expect(((await res.json()) as ErrorResponse).code).toBe('validation_failed');
    expect(await row(id)).toMatchObject({
      displayName: '最初の名前',
      statusEmoji: null,
      statusText: null,
    });
  });

  it('絵文字とテキストを別々の項目（statusEmoji / statusText）で送る形は受け付けない', async () => {
    const { authorization } = await login();
    expect((await patchMe(authorization, { statusEmoji: '🍵', statusText: '休憩中' })).status).toBe(
      400,
    );
  });

  // 機能一覧 1.3「ユーザーID は変更できない」。
  it('ユーザーID は変えられない（本体に userId を含めると 400 で、何も変えない）', async () => {
    const { authorization, id, loginId } = await login();
    const res = await patchMe(authorization, { userId: 'renamed_user', displayName: '変える' });

    expect(res.status).toBe(400);
    expect(((await res.json()) as ErrorResponse).code).toBe('validation_failed');
    expect(await row(id)).toMatchObject({ loginId, displayName: '最初の名前' });
  });

  it('変える項目が1つも無い本体は 400', async () => {
    const { authorization } = await login();
    expect((await patchMe(authorization, {})).status).toBe(400);
  });

  // 機能一覧 1.3「表示名は1〜50文字で、空白だけは不可」。文字数はコードポイントで数える。
  describe('表示名', () => {
    it('50 文字（絵文字 50 個）まで通り、51 文字・空文字・空白だけは 400', async () => {
      const { authorization, id } = await login();
      expect((await patchMe(authorization, { displayName: '😀'.repeat(50) })).status).toBe(200);

      for (const displayName of ['😀'.repeat(51), '', ' 　 ']) {
        const res = await patchMe(authorization, { displayName });
        expect(res.status).toBe(400);
      }
      expect((await row(id)).displayName).toBe('😀'.repeat(50));
    });
  });

  // 機能一覧 1.3「ステータスは絵文字1つとテキスト（最大100文字）で構成される」。
  describe('ステータス', () => {
    it.each(['😀', '👍🏽', '👨‍👩‍👧', '🇯🇵', '#️⃣'])('絵文字1つ（%s）は通る', async (emoji) => {
      const { authorization, id } = await login();
      expect((await patchMe(authorization, { status: { emoji, text: 'x' } })).status).toBe(200);
      expect((await row(id)).statusEmoji).toBe(emoji);
    });

    it.each([
      ['文字', 'a'],
      ['数字', '1'],
      ['絵文字2つ', '😀😀'],
      ['絵文字と文字', '😀a'],
      ['空文字', ''],
    ])('絵文字1つでないもの（%s）は 400 で、落ちた項目を返し、変えない', async (_label, emoji) => {
      const { authorization, id } = await login();
      const res = await patchMe(authorization, {
        status: { emoji, text: 'x' },
        displayName: '変える',
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as ErrorResponse;
      expect(body.code).toBe('validation_failed');
      expect(body.errors?.map((e) => e.path)).toEqual(['/body/status/emoji']);
      expect(await row(id)).toMatchObject({ displayName: '最初の名前', statusEmoji: null });
    });

    it('テキストは 100 文字（絵文字 100 個）まで通り、101 文字と空文字は 400', async () => {
      const { authorization, id } = await login();
      const withText = (text: string) => patchMe(authorization, { status: { emoji: '😀', text } });
      expect((await withText('😀'.repeat(100))).status).toBe(200);
      expect((await withText('😀'.repeat(101))).status).toBe(400);
      expect((await withText('')).status).toBe(400);
      expect((await row(id)).statusText).toBe('😀'.repeat(100));
    });
  });
});
