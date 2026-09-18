import 'reflect-metadata';
import { generateKeyPairSync, randomBytes, verify } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { paths } from '@workspace-chat/shared';
import type { StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app-setup';
import { hashSecret } from '../auth/secret-hash';
import { PrismaService } from '../prisma.service';
import { stubApiEnv, TEST_WEB_ORIGIN } from '../testing/api-env';
import { POSTGRES_STARTUP_TIMEOUT_MS, startMigratedPostgres } from '../testing/postgres';
import { startValkey } from '../testing/valkey';

type SignedCookies =
  paths['/avatars/cookies']['post']['responses'][200]['content']['application/json'];
type Workspace = paths['/workspaces']['post']['responses'][201]['content']['application/json'];

const NOT_FOUND = { code: 'not_found', message: '見つかりません' };
const NOT_A_CHANNEL_MEMBER = {
  code: 'not_a_channel_member',
  message: 'このチャンネルの参加者ではありません',
};
const MISSING_ID = '00000000-0000-7000-8000-000000000000';
const KEY_PAIR_ID = 'KTESTKEYPAIR01';
/** 署名付き Cookie の有効期間（秒）。発行する側の値（delivery/signed-cookies.ts）と揃える。 */
const TTL_SECONDS = 15 * 60;

let sequence = 0;
let ipSequence = 0;
function nextIp(): string {
  ipSequence += 1;
  return `2001:db8::c0:${ipSequence.toString(16)}`;
}

type LoggedIn = { authorization: string; id: string };

type Cookie = { name: string; value: string; attributes: Map<string, string> };

/** Set-Cookie の1行を、名前・値・属性（名前は小文字）に分ける。 */
function parseSetCookie(line: string): Cookie {
  const [pair = '', ...attributes] = line.split(';').map((part) => part.trim());
  const at = pair.indexOf('=');
  return {
    name: pair.slice(0, at),
    value: pair.slice(at + 1),
    attributes: new Map(
      attributes.map((attribute) => {
        const eq = attribute.indexOf('=');
        return eq < 0
          ? [attribute.toLowerCase(), '']
          : [attribute.slice(0, eq).toLowerCase(), attribute.slice(eq + 1)];
      }),
    ),
  };
}

/** CloudFront の Cookie の値（base64 の + = / を - _ ~ に置き換えたもの）を元のバイト列に戻す。 */
function cloudFrontBase64(value: string): Buffer {
  return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '=').replace(/~/g, '/'), 'base64');
}

// 機能一覧 1.3（F-04。/avatars/* の Cookie はログインしている利用者に発行する）・11.2（F-29。/files の Cookie はチャンネルの参加者だけに発行する）。
// 要件定義書 4.3 の表: Cookie の対象は配信 URL のパス、Path 属性は /avatars・/files。必ずテストを書く箇所の2（非参加者を拒否する）。
describe('アバターと添付の配信の署名付き Cookie（F-04・F-29）', () => {
  let postgres: StartedPostgreSqlContainer;
  let valkey: StartedTestContainer;
  let app: INestApplication;
  /** CloudFront の署名鍵を設定していない（手元と同じ）api。 */
  let unsignedApp: INestApplication;
  let base: string;
  let unsignedBase: string;
  let prisma: PrismaService;
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });

  async function listen(target: INestApplication): Promise<string> {
    await target.listen(0, '127.0.0.1');
    const { port } = target.getHttpServer().address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  async function login(): Promise<LoggedIn> {
    sequence += 1;
    const loginId = `Sc_${Date.now().toString(36)}_${sequence}`;
    const user = await prisma.user.create({
      data: {
        loginId,
        displayName: `配信の人${sequence}`,
        passwordHash: await hashSecret('cookies-password'),
      },
    });
    const res = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': nextIp() },
      body: JSON.stringify({ userId: loginId, password: 'cookies-password' }),
    });
    expect(res.status).toBe(200);
    const { accessToken } = (await res.json()) as { accessToken: string };
    return { authorization: `Bearer ${accessToken}`, id: user.id };
  }

  function send(
    method: 'POST' | 'DELETE',
    path: string,
    by: LoggedIn | null,
    { to = base, body }: { to?: string; body?: unknown } = {},
  ): Promise<Response> {
    return fetch(`${to}/api${path}`, {
      method,
      headers: {
        ...(by === null ? {} : { authorization: by.authorization }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  const filesPath = (workspaceId: string, channelId: string) =>
    `/workspaces/${workspaceId}/channels/${channelId}/files/cookies`;

  /** オーナーのワークスペースを作り、渡した利用者をメンバーとして参加させる。 */
  async function workspaceWith(owner: LoggedIn, ...members: LoggedIn[]): Promise<Workspace> {
    const res = await send('POST', '/workspaces', owner, { body: { name: '配信の場所' } });
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
    visibility: 'PUBLIC' | 'PRIVATE',
    participants: LoggedIn[],
    archived = false,
  ): Promise<string> {
    sequence += 1;
    const name = `files-${sequence}`;
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

  /**
   * 発行された3つの Cookie を確かめ、署名した方針（policy）を返す。
   * **属性（Path・HttpOnly・Secure・SameSite・Max-Age）がどの Cookie にも付き、署名が公開鍵で確かめられること**を見る。
   */
  async function issuedPolicy(res: Response, path: '/avatars' | '/files') {
    expect(res.status).toBe(200);
    expect((await res.json()) as SignedCookies).toEqual({ expiresIn: TTL_SECONDS });
    const cookies = res.headers.getSetCookie().map(parseSetCookie);
    expect(cookies.map(({ name }) => name).sort()).toEqual([
      'CloudFront-Key-Pair-Id',
      'CloudFront-Policy',
      'CloudFront-Signature',
    ]);
    for (const cookie of cookies) {
      expect(cookie.attributes.get('path'), cookie.name).toBe(path);
      expect(cookie.attributes.has('httponly'), cookie.name).toBe(true);
      expect(cookie.attributes.has('secure'), cookie.name).toBe(true);
      expect(cookie.attributes.get('samesite'), cookie.name).toBe('Strict');
      expect(cookie.attributes.get('max-age'), cookie.name).toBe(String(TTL_SECONDS));
      expect(cookie.attributes.has('domain'), cookie.name).toBe(false);
    }
    const value = (name: string) => cookies.find((cookie) => cookie.name === name)?.value ?? '';
    expect(value('CloudFront-Key-Pair-Id')).toBe(KEY_PAIR_ID);
    const policy = cloudFrontBase64(value('CloudFront-Policy'));
    expect(
      verify('RSA-SHA1', policy, publicKey, cloudFrontBase64(value('CloudFront-Signature'))),
    ).toBe(true);
    return JSON.parse(policy.toString('utf8')) as {
      Statement: { Resource: string; Condition: { DateLessThan: { 'AWS:EpochTime': number } } }[];
    };
  }

  function expectNoCookies(res: Response): void {
    expect(res.headers.getSetCookie()).toEqual([]);
  }

  beforeAll(async () => {
    postgres = await startMigratedPostgres();
    const started = await startValkey();
    valkey = started.container;
    // 2つの api で同じアクセストークンを使えるよう、署名の鍵を揃える（stubApiEnv は呼ぶたびに乱数で作る）
    const env = {
      DATABASE_URL: postgres.getConnectionUri(),
      REDIS_URL: started.url,
      TRUST_PROXY_HOPS: '1',
      JWT_SECRET: randomBytes(32).toString('base64url'),
    };
    stubApiEnv(env);
    unsignedApp = await createApp({ logger: false });
    unsignedBase = await listen(unsignedApp);
    stubApiEnv({
      ...env,
      CLOUDFRONT_KEY_PAIR_ID: KEY_PAIR_ID,
      CLOUDFRONT_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    });
    app = await createApp({ logger: false });
    base = await listen(app);
    prisma = app.get(PrismaService);
  }, POSTGRES_STARTUP_TIMEOUT_MS);

  afterAll(async () => {
    await app?.close();
    await unsignedApp?.close();
    await postgres?.stop();
    await valkey?.stop();
    vi.unstubAllEnvs();
  });

  describe('アバター（/avatars/*）', () => {
    it('ログインしている利用者に、/avatars/* を対象に Path=/avatars の Cookie を、期限つきで発行する', async () => {
      const alice = await login();
      const before = Math.floor(Date.now() / 1000);

      const policy = await issuedPolicy(await send('POST', '/avatars/cookies', alice), '/avatars');

      expect(policy.Statement).toHaveLength(1);
      expect(policy.Statement[0]?.Resource).toBe(`${TEST_WEB_ORIGIN}/avatars/*`);
      const expiresAt = policy.Statement[0]?.Condition.DateLessThan['AWS:EpochTime'] ?? 0;
      expect(expiresAt).toBeGreaterThanOrEqual(before + TTL_SECONDS);
      expect(expiresAt).toBeLessThanOrEqual(Math.ceil(Date.now() / 1000) + TTL_SECONDS);
    });

    it('ワークスペースに所属していなくても発行する（アバターはどの画面にも出る）', async () => {
      const loner = await login();
      expect((await send('POST', '/avatars/cookies', loner)).status).toBe(200);
    });

    it('ログインしていなければ 401 で、Cookie を発行しない', async () => {
      const res = await send('POST', '/avatars/cookies', null);
      expect(res.status).toBe(401);
      expectNoCookies(res);
    });

    it('退会済みの利用者のアクセストークンでは 401 で、Cookie を発行しない', async () => {
      const gone = await login();
      await prisma.user.update({ where: { id: gone.id }, data: { deletedAt: new Date() } });

      const res = await send('POST', '/avatars/cookies', gone);

      expect(res.status).toBe(401);
      expectNoCookies(res);
    });

    it('CloudFront の署名鍵を設定していなければ 204 で、Cookie を発行しない', async () => {
      const alice = await login();
      const res = await send('POST', '/avatars/cookies', alice, { to: unsignedBase });
      expect(res.status).toBe(204);
      expectNoCookies(res);
    });
  });

  describe('チャンネルの添付（/files/workspace/{ws}/channel/{ch}/*）', () => {
    it.each(['PUBLIC', 'PRIVATE'] as const)(
      '%s チャンネルの参加者に、そのチャンネルのパスだけを対象に Path=/files の Cookie を発行する',
      async (visibility) => {
        const owner = await login();
        const alice = await login();
        const workspace = await workspaceWith(owner, alice);
        const channelId = await channelRow(workspace.id, visibility, [alice]);

        const policy = await issuedPolicy(
          await send('POST', filesPath(workspace.id, channelId), alice),
          '/files',
        );

        expect(policy.Statement.map(({ Resource }) => Resource)).toEqual([
          `${TEST_WEB_ORIGIN}/files/workspace/${workspace.id}/channel/${channelId}/*`,
        ]);
      },
    );

    it('アーカイブ済みのチャンネルでも、参加者には発行する（読める。機能一覧 3.2）', async () => {
      const owner = await login();
      const alice = await login();
      const workspace = await workspaceWith(owner, alice);
      const channelId = await channelRow(workspace.id, 'PRIVATE', [alice], true);

      await issuedPolicy(await send('POST', filesPath(workspace.id, channelId), alice), '/files');
    });

    // 対象のパスは S3 のキーの形そのもの（認可の一部）。大文字で要求されても、キーと同じ小文字の id で組み立てる。
    it('id を大文字で要求されても、対象のパスはキーと同じ小文字の id で組み立てる', async () => {
      const owner = await login();
      const alice = await login();
      const workspace = await workspaceWith(owner, alice);
      const channelId = await channelRow(workspace.id, 'PUBLIC', [alice]);

      const policy = await issuedPolicy(
        await send('POST', filesPath(workspace.id.toUpperCase(), channelId.toUpperCase()), alice),
        '/files',
      );

      expect(policy.Statement[0]?.Resource).toBe(
        `${TEST_WEB_ORIGIN}/files/workspace/${workspace.id}/channel/${channelId}/*`,
      );
    });

    // 3.1 の2段階のコード（所属していなければ種別によらず 404、所属していればプライベートは 404 / パブリックは 403）。
    it.each(['PUBLIC', 'PRIVATE'] as const)(
      '所属していないワークスペースの %s チャンネルは 404 で、Cookie を発行しない',
      async (visibility) => {
        const owner = await login();
        const outsider = await login();
        const workspace = await workspaceWith(owner);
        const channelId = await channelRow(workspace.id, visibility, [owner]);

        const res = await send('POST', filesPath(workspace.id, channelId), outsider);

        expect(res.status).toBe(404);
        expect(await res.json()).toEqual(NOT_FOUND);
        expectNoCookies(res);
      },
    );

    it.each([
      ['PUBLIC', 403, NOT_A_CHANNEL_MEMBER],
      ['PRIVATE', 404, NOT_FOUND],
    ] as const)(
      '所属していて %s チャンネルに参加していなければ %i で、Cookie を発行しない',
      async (visibility, status, body) => {
        const owner = await login();
        const bob = await login();
        const workspace = await workspaceWith(owner, bob);
        const channelId = await channelRow(workspace.id, visibility, [owner]);

        const res = await send('POST', filesPath(workspace.id, channelId), bob);

        expect(res.status).toBe(status);
        expect(await res.json()).toEqual(body);
        expectNoCookies(res);
      },
    );

    // 機能一覧 3.1 のオーナーの例外は、添付ファイルに及ばない（CLAUDE.md「必ずテストを書く箇所」）。
    it('オーナーでも、参加していないプライベートチャンネルには 404 で、Cookie を発行しない', async () => {
      const owner = await login();
      const alice = await login();
      const workspace = await workspaceWith(owner, alice);
      const channelId = await channelRow(workspace.id, 'PRIVATE', [alice]);

      const res = await send('POST', filesPath(workspace.id, channelId), owner);

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual(NOT_FOUND);
      expectNoCookies(res);
    });

    it('別のワークスペースのチャンネル・無いチャンネルは 404 で、Cookie を発行しない', async () => {
      const owner = await login();
      const alice = await login();
      const mine = await workspaceWith(owner, alice);
      const other = await workspaceWith(alice);
      const otherChannelId = await channelRow(other.id, 'PUBLIC', [alice]);

      for (const path of [filesPath(mine.id, otherChannelId), filesPath(mine.id, MISSING_ID)]) {
        const res = await send('POST', path, alice);
        expect(res.status, path).toBe(404);
        expect(await res.json()).toEqual(NOT_FOUND);
        expectNoCookies(res);
      }
    });

    it('ログインしていなければ 401 で、Cookie を発行しない', async () => {
      const owner = await login();
      const workspace = await workspaceWith(owner);
      const channelId = await channelRow(workspace.id, 'PUBLIC', [owner]);

      const res = await send('POST', filesPath(workspace.id, channelId), null);

      expect(res.status).toBe(401);
      expectNoCookies(res);
    });

    // 機能一覧 11.2「チャンネルから外れた（キック・退出した）利用者は、次の再発行を受けられない」。
    it('ワークスペースからキックされた利用者は、次の再発行を 404 で受けられない', async () => {
      const owner = await login();
      const bob = await login();
      const workspace = await workspaceWith(owner, bob);
      const channelId = await channelRow(workspace.id, 'PUBLIC', [owner, bob]);
      await issuedPolicy(await send('POST', filesPath(workspace.id, channelId), bob), '/files');

      expect(
        (await send('DELETE', `/workspaces/${workspace.id}/members/${bob.id}`, owner)).status,
      ).toBe(204);
      const res = await send('POST', filesPath(workspace.id, channelId), bob);

      expect(res.status).toBe(404);
      expectNoCookies(res);
    });

    it.each([
      ['PUBLIC', 403],
      ['PRIVATE', 404],
    ] as const)(
      '%s チャンネルから退出した利用者は、次の再発行を %i で受けられない',
      async (visibility, status) => {
        const owner = await login();
        const bob = await login();
        const workspace = await workspaceWith(owner, bob);
        const channelId = await channelRow(workspace.id, visibility, [owner, bob]);
        await issuedPolicy(await send('POST', filesPath(workspace.id, channelId), bob), '/files');

        const left = await send(
          'POST',
          `/workspaces/${workspace.id}/channels/${channelId}/leave`,
          bob,
        );
        expect(left.status).toBe(204);
        const res = await send('POST', filesPath(workspace.id, channelId), bob);

        expect(res.status).toBe(status);
        expectNoCookies(res);
      },
    );

    it('プライベートチャンネルからキックされた利用者は、次の再発行を 404 で受けられない', async () => {
      const owner = await login();
      const bob = await login();
      const workspace = await workspaceWith(owner, bob);
      const channelId = await channelRow(workspace.id, 'PRIVATE', [owner, bob]);
      await issuedPolicy(await send('POST', filesPath(workspace.id, channelId), bob), '/files');

      const kicked = await send(
        'DELETE',
        `/workspaces/${workspace.id}/channels/${channelId}/members/${bob.id}`,
        owner,
      );
      expect(kicked.status).toBe(204);
      const res = await send('POST', filesPath(workspace.id, channelId), bob);

      expect(res.status).toBe(404);
      expectNoCookies(res);
    });

    it('CloudFront の署名鍵を設定していなければ、参加者には 204 で Cookie を発行せず、非参加者には同じ 2段階のコードを返す', async () => {
      const owner = await login();
      const alice = await login();
      const workspace = await workspaceWith(owner, alice);
      const channelId = await channelRow(workspace.id, 'PRIVATE', [owner]);

      const participant = await send('POST', filesPath(workspace.id, channelId), owner, {
        to: unsignedBase,
      });
      expect(participant.status).toBe(204);
      expectNoCookies(participant);
      const outsider = await send('POST', filesPath(workspace.id, channelId), alice, {
        to: unsignedBase,
      });
      expect(outsider.status).toBe(404);
      expectNoCookies(outsider);
    });
  });

  // #239: DM の添付の配信。当事者だけに、その DM のパスだけを対象に発行する（必ずテストを書く箇所の2。当事者でなければ拒否する）。
  describe('DM の添付（/files/workspace/{ws}/dm/{dmId}/*）', () => {
    const dmFilesPath = (workspaceId: string, dmId: string) =>
      `/workspaces/${workspaceId}/dms/${dmId}/files/cookies`;

    /** オーナー・alice・bob のワークスペースで、alice と bob の DM を作る。 */
    async function dmOfTwo() {
      const owner = await login();
      const alice = await login();
      const bob = await login();
      const workspace = await workspaceWith(owner, alice, bob);
      const res = await send('POST', `/workspaces/${workspace.id}/dms`, alice, {
        body: { userId: bob.id },
      });
      expect(res.status).toBe(200);
      const dm = (await res.json()) as { id: string };
      return { owner, alice, bob, workspace, dmId: dm.id };
    }

    it('当事者のそれぞれに、その DM のパスだけを対象に Path=/files の Cookie を発行する', async () => {
      const { alice, bob, workspace, dmId } = await dmOfTwo();

      for (const party of [alice, bob]) {
        const policy = await issuedPolicy(
          await send('POST', dmFilesPath(workspace.id, dmId), party),
          '/files',
        );
        expect(policy.Statement.map(({ Resource }) => Resource)).toEqual([
          `${TEST_WEB_ORIGIN}/files/workspace/${workspace.id}/dm/${dmId}/*`,
        ]);
      }
    });

    it('当事者でない利用者（オーナーを含む）・所属していない利用者には 404 で、Cookie を発行しない', async () => {
      const { owner, workspace, dmId } = await dmOfTwo();
      const outsider = await login();

      for (const who of [owner, outsider]) {
        const res = await send('POST', dmFilesPath(workspace.id, dmId), who);
        expect(res.status).toBe(404);
        expectNoCookies(res);
      }
    });

    it('別のワークスペースの id で当事者が求めても 404 で、Cookie を発行しない', async () => {
      const { alice, dmId } = await dmOfTwo();
      const other = await workspaceWith(alice);

      const res = await send('POST', dmFilesPath(other.id, dmId), alice);
      expect(res.status).toBe(404);
      expectNoCookies(res);
    });
  });
});
