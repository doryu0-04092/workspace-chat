import 'reflect-metadata';
import type { paths } from '@workspace-chat/shared';
import type { Socket } from 'socket.io-client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { POSTGRES_STARTUP_TIMEOUT_MS } from '../testing/postgres';
import { connectRealtime } from '../testing/realtime-client';
import { type TwoTasks, startTwoTasks } from '../testing/two-tasks';

type ErrorResponse = paths['/users/me']['get']['responses'][401]['content']['application/json'];
type RegisterResponse =
  paths['/auth/register']['post']['responses'][201]['content']['application/json'];
type Message =
  paths['/workspaces/{id}/channels/{channelId}/messages']['get']['responses'][200]['content']['application/json']['messages'][number];

const PASSWORD = 'deletion-password';
/** ブラウザが同じ origin から送るときのヘッダー（リフレッシュ・ログアウトの CSRF の対処。refresh-logout.test.ts と同じ）。 */
const SAME_ORIGIN = { 'x-requested-by': 'workspace-chat', 'sec-fetch-site': 'same-origin' };

let sequence = 0;
let ipSequence = 0;
function nextIp(): string {
  ipSequence += 1;
  return `2001:db8::5:${ipSequence.toString(16)}`;
}

type Account = {
  id: string;
  loginId: string;
  recoveryCode: string;
  authorization: string;
  token: string;
  refreshToken: string;
};

// 機能一覧 1.5（F-36）: アカウントの削除（退会）。#575。
// 必須のテスト（CLAUDE.md「必ずテストを書く箇所」）: 退会済みのトークンが、読み取り・書き込み・WebSocket のいずれでも拒否されること——
// **退会の API を通した後で**確かめる（`deletedAt` を直接埋める既存のテストは、入口の判定だけを見ている）。
// WebSocket の確立済みの接続は、別のタスクに繋いだものも切れることを見る（Redis アダプタを通す）。
describe('アカウントの削除（F-36）', () => {
  let t: TwoTasks;
  const opened: Socket[] = [];

  function post(path: string, body: unknown, headers: Record<string, string> = {}) {
    return fetch(`${t.firstBase}/api${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': nextIp(), ...headers },
      body: JSON.stringify(body),
    });
  }

  function refreshCookie(res: Response): string | undefined {
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith('refresh_token='));
    return cookie === undefined
      ? undefined
      : decodeURIComponent(cookie.split(';')[0]!.slice('refresh_token='.length));
  }

  /** 新規登録の API で利用者を作り（リカバリーコードを受け取る）、ログインしてトークンと Cookie を受け取る。 */
  async function account(): Promise<Account> {
    sequence += 1;
    const loginId = `Leaver_${Date.now().toString(36)}_${sequence}`;
    const registered = await post('/auth/register', {
      userId: loginId,
      password: PASSWORD,
      displayName: `退会する人${sequence}`,
    });
    expect(registered.status).toBe(201);
    const { recoveryCode, user } = (await registered.json()) as RegisterResponse;
    const loggedIn = await post('/auth/login', { userId: loginId, password: PASSWORD });
    expect(loggedIn.status).toBe(200);
    const { accessToken } = (await loggedIn.json()) as { accessToken: string };
    return {
      id: user.id,
      loginId,
      recoveryCode,
      authorization: `Bearer ${accessToken}`,
      token: accessToken,
      refreshToken: refreshCookie(loggedIn)!,
    };
  }

  function deleteAccount(by: { authorization: string }, password: string): Promise<Response> {
    return fetch(`${t.firstBase}/api/users/me/delete`, {
      method: 'POST',
      headers: { authorization: by.authorization, 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
    });
  }

  function refresh(refreshToken: string): Promise<Response> {
    return fetch(`${t.firstBase}/api/auth/refresh`, {
      method: 'POST',
      headers: {
        'x-forwarded-for': nextIp(),
        cookie: `refresh_token=${encodeURIComponent(refreshToken)}`,
        ...SAME_ORIGIN,
      },
    });
  }

  async function open(base: string, token: string) {
    const result = await connectRealtime(base, { token });
    opened.push(result.socket);
    return result;
  }

  /** 接続が切れるのを待つ。切れなければ undefined（他のタスクへの切断は Valkey を通るため、負荷の高いときに備えて長めに待つ）。 */
  function disconnected(socket: Socket, timeoutMs = 5_000): Promise<string | undefined> {
    if (!socket.connected) return Promise.resolve('already');
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(undefined), timeoutMs);
      socket.once('disconnect', (reason) => {
        clearTimeout(timer);
        resolve(reason);
      });
    });
  }

  async function errorOf(res: Response): Promise<ErrorResponse> {
    return (await res.json()) as ErrorResponse;
  }

  /** 削除しなかったこと（どの書き込みも反映していないこと）。 */
  async function expectUntouched(user: Account, workspaceId?: string): Promise<void> {
    const row = await t.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.deletedAt).toBeNull();
    expect(await t.prisma.recoveryCode.count({ where: { userId: user.id, usedAt: null } })).toBe(1);
    expect(
      await t.prisma.refreshToken.count({ where: { userId: user.id, revokedAt: null } }),
    ).toBeGreaterThan(0);
    if (workspaceId !== undefined) {
      expect(await t.prisma.membership.count({ where: { userId: user.id, workspaceId } })).toBe(1);
    }
    expect((await t.send('GET', '/users/me', user)).status).toBe(200);
  }

  beforeAll(async () => {
    t = await startTwoTasks('5');
  }, POSTGRES_STARTUP_TIMEOUT_MS);

  afterEach(() => {
    for (const socket of opened.splice(0)) socket.close();
  });

  afterAll(async () => {
    await t?.stop();
  });

  describe('削除できる', () => {
    it('204 を返して Cookie を消し、同一トランザクションで論理削除・コードの無効化・所属の削除・トークンの失効を行う', async () => {
      const owner = await t.login();
      const leaver = await account();
      const other = await account();
      const workspace = await t.workspaceWith(owner, leaver, other);
      const channelId = await t.channelRow(workspace.id, 'PRIVATE', [owner, leaver, other]);

      const res = await deleteAccount(leaver, PASSWORD);

      expect(res.status).toBe(204);
      const cleared = res.headers.getSetCookie().find((c) => c.startsWith('refresh_token='));
      expect(cleared).toMatch(/^refresh_token=;/);
      expect(cleared).toContain('Path=/api/auth');

      const row = await t.prisma.user.findUniqueOrThrow({ where: { id: leaver.id } });
      expect(row.deletedAt).not.toBeNull();
      expect(
        await t.prisma.recoveryCode.count({ where: { userId: leaver.id, usedAt: null } }),
      ).toBe(0);
      expect(await t.prisma.membership.count({ where: { userId: leaver.id } })).toBe(0);
      expect(await t.prisma.channelMember.count({ where: { channelId, userId: leaver.id } })).toBe(
        0,
      );
      expect(
        await t.prisma.refreshToken.count({ where: { userId: leaver.id, revokedAt: null } }),
      ).toBe(0);

      // 他の利用者には手を付けない
      await expectUntouched(other, workspace.id);
    });

    it('削除した利用者の過去のメッセージは残り、他の参加者が読める（投稿者は null）。参加者一覧には出ない', async () => {
      const owner = await t.login();
      const leaver = await account();
      const workspace = await t.workspaceWith(owner, leaver);
      const channelId = await t.channelRow(workspace.id, 'PUBLIC', [owner, leaver]);
      const posted = await t.send(
        'POST',
        `/workspaces/${workspace.id}/channels/${channelId}/messages`,
        leaver,
        { body: '退会の前に書いた' },
      );
      expect(posted.status).toBe(201);

      expect((await deleteAccount(leaver, PASSWORD)).status).toBe(204);

      const list = await t.send(
        'GET',
        `/workspaces/${workspace.id}/channels/${channelId}/messages`,
        owner,
      );
      expect(list.status).toBe(200);
      const { messages } = (await list.json()) as { messages: Message[] };
      expect(messages.map((m) => [m.body, m.author])).toEqual([['退会の前に書いた', null]]);

      const members = await t.send('GET', `/workspaces/${workspace.id}/members`, owner);
      expect(((await members.json()) as { id: string }[]).map((m) => m.id)).toEqual([owner.id]);
      const channelMembers = await t.send(
        'GET',
        `/workspaces/${workspace.id}/channels/${channelId}/members`,
        owner,
      );
      expect(((await channelMembers.json()) as { id: string }[]).map((m) => m.id)).toEqual([
        owner.id,
      ]);
    });
  });

  describe('削除した後は、そのアカウントのどの資格情報も使えない', () => {
    it('発行済みのアクセストークンは、読み取りも書き込みも 401（invalid_token）で断り、書き込みを反映しない', async () => {
      const leaver = await account();
      expect((await deleteAccount(leaver, PASSWORD)).status).toBe(204);

      const read = await t.send('GET', '/users/me', leaver);
      expect(read.status).toBe(401);
      expect(await errorOf(read)).toEqual({
        code: 'invalid_token',
        message: 'ログインし直してください',
      });
      const write = await t.send('POST', '/workspaces', leaver, { name: '退会後の場所' });
      expect(write.status).toBe(401);
      expect((await errorOf(write)).code).toBe('invalid_token');
      expect(await t.prisma.membership.count({ where: { userId: leaver.id } })).toBe(0);
      // 削除の API そのものも、もう通らない
      expect((await deleteAccount(leaver, PASSWORD)).status).toBe(401);
    });

    it('WebSocket: 確立済みの接続は（別のタスクに繋いだものも）切れ、新しいハンドシェイクは invalid_token で断る', async () => {
      const leaver = await account();
      const stayer = await account();
      const onFirst = await open(t.firstBase, leaver.token);
      const onSecond = await open(t.secondBase, leaver.token);
      const bystander = await open(t.secondBase, stayer.token);
      expect([onFirst.error, onSecond.error, bystander.error]).toEqual([
        undefined,
        undefined,
        undefined,
      ]);
      const cut = [disconnected(onFirst.socket), disconnected(onSecond.socket)];

      expect((await deleteAccount(leaver, PASSWORD)).status).toBe(204);

      expect(await Promise.all(cut)).toEqual(['io server disconnect', 'io server disconnect']);
      expect(bystander.socket.connected).toBe(true);
      for (const base of [t.firstBase, t.secondBase]) {
        const { error, socket } = await open(base, leaver.token);
        expect(error?.data).toEqual({ code: 'invalid_token' });
        expect(socket.connected).toBe(false);
      }
    });

    it('リフレッシュトークンでは再発行できず、パスワードでログインできず、リカバリーコードで再設定できない', async () => {
      const leaver = await account();
      expect((await deleteAccount(leaver, PASSWORD)).status).toBe(204);

      expect((await refresh(leaver.refreshToken)).status).toBe(401);
      const login = await post('/auth/login', { userId: leaver.loginId, password: PASSWORD });
      expect(login.status).toBe(401);
      const recovery = await post('/auth/recovery', {
        userId: leaver.loginId,
        recoveryCode: leaver.recoveryCode,
        newPassword: 'another-password',
      });
      expect(recovery.status).toBe(401);
    });

    it('ユーザーID は再利用できない（綴りの大文字小文字を変えても 409）', async () => {
      const leaver = await account();
      expect((await deleteAccount(leaver, PASSWORD)).status).toBe(204);

      const res = await post('/auth/register', {
        userId: leaver.loginId.toUpperCase(),
        password: PASSWORD,
        displayName: '同じ ID を使いたい人',
      });
      expect(res.status).toBe(409);
      expect((await errorOf(res)).code).toBe('user_id_taken');
    });
  });

  describe('削除できない', () => {
    it('パスワードが違えば 403（password_mismatch）で、何も変えない。続けて試すと照合せずに 429', async () => {
      const owner = await t.login();
      const leaver = await account();
      const workspace = await t.workspaceWith(owner, leaver);
      const socket = await open(t.firstBase, leaver.token);

      const res = await deleteAccount(leaver, 'wrong-password');

      expect(res.status).toBe(403);
      expect(await errorOf(res)).toEqual({
        code: 'password_mismatch',
        message: 'パスワードが違います',
      });
      await expectUntouched(leaver, workspace.id);
      expect(socket.socket.connected).toBe(true);

      // 1回失敗した直後は 1 秒の間照合しない（正しいパスワードでも通さない。login-backoff.ts）
      const retried = await deleteAccount(leaver, PASSWORD);
      expect(retried.status).toBe(429);
      expect(retried.headers.get('retry-after')).toBe('1');
      await expectUntouched(leaver, workspace.id);
    });

    it('ワークスペースのオーナーは 403（owner_cannot_delete_account）で理由を返し、何も変えない', async () => {
      const owner = await account();
      const workspaceRes = await t.send('POST', '/workspaces', owner, {
        name: 'オーナーの場所',
      });
      expect(workspaceRes.status).toBe(201);
      const { id: workspaceId } = (await workspaceRes.json()) as { id: string };
      const socket = await open(t.firstBase, owner.token);

      const res = await deleteAccount(owner, PASSWORD);

      expect(res.status).toBe(403);
      const body = await errorOf(res);
      expect(body.code).toBe('owner_cannot_delete_account');
      expect(body.message).toContain('オーナー');
      await expectUntouched(owner, workspaceId);
      expect(socket.socket.connected).toBe(true);
    });

    it('本体が仕様に合わなければ 400、トークンが無ければ 401', async () => {
      const leaver = await account();
      const empty = await fetch(`${t.firstBase}/api/users/me/delete`, {
        method: 'POST',
        headers: { authorization: leaver.authorization, 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(empty.status).toBe(400);
      const anonymous = await fetch(`${t.firstBase}/api/users/me/delete`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: PASSWORD }),
      });
      expect(anonymous.status).toBe(401);
      await expectUntouched(leaver);
    });
  });

  // **オーナーの拒否は、アプリ側の規約であり DB は止めない**（schema.prisma の User.deletedAt）。
  // 削除とワークスペースの作成が同時に来ても、オーナーが退会済みのワークスペースを作らない——利用者の行を掴んでから読む。
  describe('ワークスペースの作成と重なったとき', () => {
    /** 利用者の行を、別のトランザクションで掴んだまま `during` を走らせ、終わったら確定する。 */
    async function holding(
      lock: (tx: Parameters<Parameters<TwoTasks['prisma']['$transaction']>[0]>[0]) => Promise<void>,
      during: () => Promise<Response>,
    ): Promise<Response> {
      let pending: Promise<Response> | undefined;
      await t.prisma.$transaction(
        async (tx) => {
          await lock(tx);
          pending = during();
          // 要求が行の確定を待っている（待たずに進めば、ここで応答まで済む）
          await new Promise((resolve) => setTimeout(resolve, 500));
        },
        { timeout: 10_000 },
      );
      return pending!;
    }

    it('作成の確定を待ってから所属を読み、オーナーになっていれば削除しない', async () => {
      const user = await account();
      // 作成の途中（利用者の行を FOR SHARE で掴み、オーナーの所属を作った。まだ確定していない）
      const res = await holding(
        async (tx) => {
          await tx.$queryRaw`SELECT 1 FROM "User" WHERE "id" = ${user.id}::uuid FOR SHARE`;
          const workspace = await tx.workspace.create({ data: { name: '同時の場所' } });
          await tx.membership.create({
            data: { workspaceId: workspace.id, userId: user.id, role: 'OWNER' },
          });
        },
        () => deleteAccount(user, PASSWORD),
      );

      expect(res.status).toBe(403);
      expect((await errorOf(res)).code).toBe('owner_cannot_delete_account');
      expect((await t.prisma.user.findUniqueOrThrow({ where: { id: user.id } })).deletedAt).toBe(
        null,
      );
    });

    it('削除の確定を待ってから利用者を読み、退会済みならワークスペースを作らない', async () => {
      const user = await account();
      // 削除の途中（利用者の行を更新した。まだ確定していない）
      const res = await holding(
        async (tx) => {
          await tx.user.update({ where: { id: user.id }, data: { deletedAt: new Date() } });
        },
        () => t.send('POST', '/workspaces', user, { name: '退会と同時の場所' }),
      );

      expect(res.status).toBe(401);
      expect(await t.prisma.membership.count({ where: { userId: user.id } })).toBe(0);
    });
  });
});
