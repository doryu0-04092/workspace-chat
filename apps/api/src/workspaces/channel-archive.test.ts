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
type ManagedChannel =
  paths['/workspaces/{id}/channels/{channelId}/archive']['post']['responses'][200]['content']['application/json'];
type ErrorResponse =
  paths['/workspaces/{id}/channels/{channelId}/archive']['post']['responses'][409]['content']['application/json'];

const NOT_FOUND = { code: 'not_found', message: '見つかりません' };
const MISSING_ID = '00000000-0000-7000-8000-000000000000';

let sequence = 0;
let ipSequence = 0;
function nextIp(): string {
  ipSequence += 1;
  return `2001:db8::e:${ipSequence.toString(16)}`;
}

type LoggedIn = { authorization: string; id: string };

// 機能一覧 3.2（F-35）: 削除ではなくアーカイブ。オーナーだけが実行でき、アーカイブの時点で名前に番号を付ける
// （基底名ごとに、その名前がまだ空いている最小の番号）。復元しても番号は外れず、再びアーカイブしても採番も改名もしない。
describe('チャンネルのアーカイブと復元（F-35）', () => {
  let postgres: StartedPostgreSqlContainer;
  let valkey: StartedTestContainer;
  let app: INestApplication;
  let base: string;
  let prisma: PrismaService;

  async function login(): Promise<LoggedIn> {
    sequence += 1;
    const loginId = `Ar_${Date.now().toString(36)}_${sequence}`;
    const user = await prisma.user.create({
      data: {
        loginId,
        displayName: `アーカイブの人${sequence}`,
        passwordHash: await hashSecret('archive-password'),
      },
    });
    const res = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': nextIp() },
      body: JSON.stringify({ userId: loginId, password: 'archive-password' }),
    });
    expect(res.status).toBe(200);
    const { accessToken } = (await res.json()) as { accessToken: string };
    return { authorization: `Bearer ${accessToken}`, id: user.id };
  }

  function send(
    method: 'GET' | 'POST',
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
    const res = await send('POST', '/workspaces', owner, { name: 'アーカイブの場所' });
    expect(res.status).toBe(201);
    const workspace = (await res.json()) as Workspace;
    for (const member of members) {
      await prisma.membership.create({
        data: { workspaceId: workspace.id, userId: member.id, role: 'MEMBER' },
      });
    }
    return workspace;
  }

  /** オーナーが API でチャンネルを作る（作ったオーナーは参加者になる）。 */
  async function created(
    owner: LoggedIn,
    workspaceId: string,
    name: string,
    visibility: 'PUBLIC' | 'PRIVATE' = 'PUBLIC',
  ): Promise<string> {
    const res = await send('POST', `/workspaces/${workspaceId}/channels`, owner, {
      name,
      visibility,
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as Channel).id;
  }

  const archive = (by: LoggedIn, workspaceId: string, channelId: string) =>
    send('POST', `/workspaces/${workspaceId}/channels/${channelId}/archive`, by);
  const restore = (by: LoggedIn, workspaceId: string, channelId: string) =>
    send('POST', `/workspaces/${workspaceId}/channels/${channelId}/restore`, by);

  async function row(channelId: string) {
    return prisma.channel.findUniqueOrThrow({
      where: { id: channelId },
      select: { name: true, baseName: true, archiveSequence: true, archivedAt: true },
    });
  }

  async function listed(by: LoggedIn, workspaceId: string): Promise<string[]> {
    const res = await send('GET', `/workspaces/${workspaceId}/channels`, by);
    expect(res.status).toBe(200);
    return ((await res.json()) as Channel[]).map((c) => c.name);
  }

  /** トランザクションを開いて行のロックを取り、確定しないまま release を呼ぶまで持ち続ける。 */
  async function holdWith(
    lock: (tx: Pick<PrismaService, 'channel' | '$queryRaw'>) => Promise<unknown>,
  ) {
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let markLocked!: () => void;
    const locked = new Promise<void>((resolve) => {
      markLocked = resolve;
    });
    const done = prisma.$transaction(
      async (tx) => {
        await lock(tx);
        markLocked();
        await released;
      },
      { timeout: 10_000 },
    );
    await Promise.race([locked, done]);
    return { release, done };
  }

  /** チャンネルの行の更新を書いたまま確定しない。 */
  function holdUpdate(channelId: string, data: object) {
    return holdWith((tx) => tx.channel.update({ where: { id: channelId }, data }));
  }

  /** 行のロックを待っている接続の数。 */
  async function waitingOnLock(): Promise<number> {
    const [found] = await prisma.$queryRaw<{ waiting: number }[]>`
      SELECT count(*)::int AS "waiting" FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'
    `;
    return found?.waiting ?? 0;
  }

  /** 行の更新を確定しないまま要求を送り、要求がロックを待つのを見てから確定し、要求の応答を返す。 */
  async function racedWithUpdate(
    channelId: string,
    data: object,
    request: () => Promise<Response>,
  ): Promise<Response> {
    const held = await holdUpdate(channelId, data);
    try {
      const pending = request();
      // 要求が行のロックを待たずに先へ進むと、ここで時間切れになる。
      await vi.waitFor(async () => expect(await waitingOnLock()).toBeGreaterThan(0), {
        timeout: 3_000,
        interval: 50,
      });
      held.release();
      await held.done;
      return await pending;
    } finally {
      held.release();
      await held.done.catch(() => undefined);
    }
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

  describe('アーカイブ', () => {
    it('オーナーがアーカイブすると名前に番号が付き、一般の一覧から外れ、同じ名前で作り直せる', async () => {
      const owner = await login();
      const workspace = await workspaceWith(owner);
      const general = await created(owner, workspace.id, 'general');

      const res = await archive(owner, workspace.id, general);
      expect(res.status).toBe(200);
      expect((await res.json()) as ManagedChannel).toEqual({
        id: general,
        name: 'general-1',
        visibility: 'PUBLIC',
        memberCount: 1,
        archived: true,
      });
      expect(await row(general)).toMatchObject({
        name: 'general-1',
        baseName: 'general',
        archiveSequence: 1,
      });
      expect(await listed(owner, workspace.id)).toEqual([]);
      await created(owner, workspace.id, 'general');
    });

    // 機能一覧 3.2「利用者が先に general-1 を作っていても、general をアーカイブできる」（MAX + 1 ではなく、空いている最小の番号）。
    it('利用者が先に「基底名-1」を作っていても、空いている最小の番号でアーカイブできる', async () => {
      const owner = await login();
      const workspace = await workspaceWith(owner);
      const report = await created(owner, workspace.id, 'report');
      await created(owner, workspace.id, 'report-1');
      await created(owner, workspace.id, 'report-3');

      const res = await archive(owner, workspace.id, report);
      expect(res.status).toBe(200);
      expect(((await res.json()) as ManagedChannel).name).toBe('report-2');
    });

    it('同じ基底名で作り直したチャンネルをアーカイブすると、次に空いている番号が付く', async () => {
      const owner = await login();
      const workspace = await workspaceWith(owner);
      const first = await created(owner, workspace.id, 'random');
      expect((await archive(owner, workspace.id, first)).status).toBe(200);
      const second = await created(owner, workspace.id, 'random');

      const res = await archive(owner, workspace.id, second);
      expect(((await res.json()) as ManagedChannel).name).toBe('random-2');
    });

    // 参照実装の注記（prisma-schema.test.ts の nextArchiveSequence）: 基底名は利用者が付けた名前で ' を含められる。値は問い合わせに埋め込まない。
    it("基底名に ' や % を含むチャンネルもアーカイブでき、別の基底名の番号に影響されない", async () => {
      const owner = await login();
      const workspace = await workspaceWith(owner);
      const quoted = await created(owner, workspace.id, "it's %");
      await created(owner, workspace.id, "it's x-1");

      const res = await archive(owner, workspace.id, quoted);
      expect(res.status).toBe(200);
      expect(((await res.json()) as ManagedChannel).name).toBe("it's %-1");
    });

    // 機能一覧 3.1「オーナーには、管理のためのチャンネル一覧を返す」: 管理の対象は参加していないプライベートにも及ぶ。
    it('オーナーは、参加していないプライベートチャンネルもアーカイブ・復元できる', async () => {
      const owner = await login();
      const member = await login();
      const workspace = await workspaceWith(owner, member);
      // オーナーが作り、メンバーを参加させてからオーナーの参加を外す（オーナーは参加していない状態にする）。
      const secret = await created(owner, workspace.id, 'secret', 'PRIVATE');
      await prisma.channelMember.create({
        data: { channelId: secret, workspaceId: workspace.id, userId: member.id },
      });
      await prisma.channelMember.deleteMany({ where: { channelId: secret, userId: owner.id } });

      const archived = await archive(owner, workspace.id, secret);
      expect(archived.status).toBe(200);
      expect((await archived.json()) as ManagedChannel).toMatchObject({
        name: 'secret-1',
        visibility: 'PRIVATE',
        memberCount: 1,
        archived: true,
      });
      expect((await restore(owner, workspace.id, secret)).status).toBe(200);
    });

    it('アーカイブ済みのチャンネルを再びアーカイブすると 409（channel_archived）で、名前も番号も変わらない', async () => {
      const owner = await login();
      const workspace = await workspaceWith(owner);
      const channel = await created(owner, workspace.id, 'twice');
      expect((await archive(owner, workspace.id, channel)).status).toBe(200);

      const again = await archive(owner, workspace.id, channel);
      expect(again.status).toBe(409);
      expect(((await again.json()) as ErrorResponse).code).toBe('channel_archived');
      expect(await row(channel)).toMatchObject({ name: 'twice-1', archiveSequence: 1 });
    });
  });

  describe('復元', () => {
    it('復元すると一般の一覧に戻るが、名前と番号は外れない', async () => {
      const owner = await login();
      const workspace = await workspaceWith(owner);
      const channel = await created(owner, workspace.id, 'general');
      expect((await archive(owner, workspace.id, channel)).status).toBe(200);

      const res = await restore(owner, workspace.id, channel);
      expect(res.status).toBe(200);
      expect((await res.json()) as ManagedChannel).toMatchObject({
        id: channel,
        name: 'general-1',
        archived: false,
      });
      expect(await row(channel)).toMatchObject({
        name: 'general-1',
        archiveSequence: 1,
        archivedAt: null,
      });
      expect(await listed(owner, workspace.id)).toEqual(['general-1']);
    });

    // 機能一覧 3.2「再びアーカイブするとき: 採番も改名も行わない」。採番し直すと自分自身が general-1 を塞いでいて 2 になる。
    it('復元したチャンネルを再びアーカイブしても、採番も改名もしない', async () => {
      const owner = await login();
      const workspace = await workspaceWith(owner);
      const channel = await created(owner, workspace.id, 'cycle');
      // アーカイブのたびに名前を確かめる（最後の1回だけを見ると、採番し直しても番号が 1 → 2 → 1 と戻って通ってしまう）。
      for (let i = 0; i < 2; i += 1) {
        const archived = await archive(owner, workspace.id, channel);
        expect(((await archived.json()) as ManagedChannel).name).toBe('cycle-1');
        expect((await restore(owner, workspace.id, channel)).status).toBe(200);
      }
      const res = await archive(owner, workspace.id, channel);
      expect(((await res.json()) as ManagedChannel).name).toBe('cycle-1');
      expect(await row(channel)).toMatchObject({ name: 'cycle-1', archiveSequence: 1 });
    });

    it('アーカイブしていないチャンネルの復元は 409（channel_not_archived）', async () => {
      const owner = await login();
      const workspace = await workspaceWith(owner);
      const channel = await created(owner, workspace.id, 'active');

      const res = await restore(owner, workspace.id, channel);
      expect(res.status).toBe(409);
      expect(((await res.json()) as ErrorResponse).code).toBe('channel_not_archived');
      expect(await row(channel)).toMatchObject({
        name: 'active',
        archiveSequence: null,
        archivedAt: null,
      });
    });
  });

  describe('権限と存在', () => {
    // CLAUDE.md「必ずテストを書く箇所」: メンバーがオーナー専用の操作を実行できないこと。機能一覧 3.2「メンバーがアーカイブ・復元 API を呼ぶと 403」。
    it('オーナーでないメンバーは、参加しているチャンネルでもアーカイブも復元もできない（403 owner_only）', async () => {
      const owner = await login();
      const member = await login();
      const workspace = await workspaceWith(owner, member);
      const open = await created(owner, workspace.id, 'open');
      await prisma.channelMember.create({
        data: { channelId: open, workspaceId: workspace.id, userId: member.id },
      });
      const old = await created(owner, workspace.id, 'old');
      expect((await archive(owner, workspace.id, old)).status).toBe(200);

      const archived = await archive(member, workspace.id, open);
      expect(archived.status).toBe(403);
      expect(((await archived.json()) as ErrorResponse).code).toBe('owner_only');
      const restored = await restore(member, workspace.id, old);
      expect(restored.status).toBe(403);
      expect(((await restored.json()) as ErrorResponse).code).toBe('owner_only');
      expect(await row(open)).toMatchObject({ name: 'open', archivedAt: null });
      expect(await row(old)).toMatchObject({ name: 'old-1' });
      expect((await row(old)).archivedAt).not.toBeNull();
    });

    it('所属していなければ 404。無いチャンネル・別のワークスペースのチャンネルは 404 で、変わらない', async () => {
      const owner = await login();
      const outsider = await login();
      const workspace = await workspaceWith(owner);
      const other = await workspaceWith(outsider);
      const mine = await created(owner, workspace.id, 'mine');
      const theirs = await created(outsider, other.id, 'theirs');

      for (const res of [
        await archive(outsider, workspace.id, mine),
        await archive(owner, workspace.id, theirs),
        await archive(owner, workspace.id, MISSING_ID),
        await restore(owner, workspace.id, theirs),
        await restore(owner, workspace.id, MISSING_ID),
      ]) {
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual(NOT_FOUND);
      }
      expect(await row(mine)).toMatchObject({ name: 'mine', archivedAt: null });
      expect(await row(theirs)).toMatchObject({ name: 'theirs', archivedAt: null });
    });
  });

  // 機能一覧 3.2「アーカイブ後: 参加・招待もできない」: アーカイブと同時に来た参加・招待も、アーカイブの後には成立しない。
  describe('アーカイブと参加・招待の同時実行', () => {
    type ArchiveKind = { label: string; data: (baseName: string) => object; prepare: boolean };
    // 初回のアーカイブは名前（一意索引の列）も変えるが、復元したものの再アーカイブは archivedAt だけを変える。
    // 行のロックの強さが違う（名前を変える更新は FOR UPDATE、変えない更新は FOR NO KEY UPDATE）ため、両方で確かめる。
    const kinds: ArchiveKind[] = [
      {
        label: '初回のアーカイブ（改名を伴う）',
        data: (baseName) => ({ archivedAt: new Date(), archiveSequence: 1, name: `${baseName}-1` }),
        prepare: false,
      },
      {
        label: '復元したものの再アーカイブ（archivedAt だけ）',
        data: () => ({ archivedAt: new Date() }),
        prepare: true,
      },
    ];

    async function participates(channelId: string, userId: string): Promise<boolean> {
      return (await prisma.channelMember.count({ where: { channelId, userId } })) > 0;
    }

    it.each(kinds)(
      'パブリックチャンネルへの参加は、$label の確定を待って 409（channel_archived）になり、参加は作られない',
      async (kind) => {
        const owner = await login();
        const member = await login();
        const workspace = await workspaceWith(owner, member);
        const channel = await created(owner, workspace.id, 'racing');
        if (kind.prepare) {
          expect((await archive(owner, workspace.id, channel)).status).toBe(200);
          expect((await restore(owner, workspace.id, channel)).status).toBe(200);
        }

        const res = await racedWithUpdate(channel, kind.data('racing'), () =>
          send('POST', `/workspaces/${workspace.id}/channels/${channel}/join`, member),
        );

        expect(res.status).toBe(409);
        expect(((await res.json()) as ErrorResponse).code).toBe('channel_archived');
        expect(await participates(channel, member.id)).toBe(false);
      },
    );

    it.each(kinds)(
      'プライベートチャンネルへの招待は、$label の確定を待って 409（channel_archived）になり、参加は作られない',
      async (kind) => {
        const owner = await login();
        const member = await login();
        const workspace = await workspaceWith(owner, member);
        const channel = await created(owner, workspace.id, 'hidden', 'PRIVATE');
        if (kind.prepare) {
          expect((await archive(owner, workspace.id, channel)).status).toBe(200);
          expect((await restore(owner, workspace.id, channel)).status).toBe(200);
        }

        const res = await racedWithUpdate(channel, kind.data('hidden'), () =>
          send('POST', `/workspaces/${workspace.id}/channels/${channel}/members`, owner, {
            memberId: member.id,
          }),
        );

        expect(res.status).toBe(409);
        expect(((await res.json()) as ErrorResponse).code).toBe('channel_archived');
        expect(await participates(channel, member.id)).toBe(false);
      },
    );
  });

  // 機能一覧 3.2「再びアーカイブするとき: 採番も改名も行わない」を、読みと更新のあいだに採番と復元が確定しても保つ
  // （schema.prisma の Channel.archiveSequence の注記。検査制約はこれを止めない）。
  describe('アーカイブの同時実行', () => {
    it('採番と復元が確定しかけていたら、その確定を待ってから読み、番号を持つ行として採番も改名もしない', async () => {
      const owner = await login();
      const workspace = await workspaceWith(owner);
      const channel = await created(owner, workspace.id, 'numbered');

      // 別の要求が「numbered-3 として採番し、復元した」状態を書いたまま確定しない。
      const res = await racedWithUpdate(
        channel,
        { name: 'numbered-3', archiveSequence: 3, archivedAt: null },
        () => archive(owner, workspace.id, channel),
      );

      expect(res.status).toBe(200);
      expect(((await res.json()) as ManagedChannel).name).toBe('numbered-3');
      expect(await row(channel)).toMatchObject({ name: 'numbered-3', archiveSequence: 3 });
      expect((await row(channel)).archivedAt).not.toBeNull();
    });

    // 行を掴む強さ: 共有ロック（FOR SHARE）で掴むと、同時の2つのアーカイブが両方とも掴んだまま更新に進み、互いを待って行き詰まる。
    it('同じチャンネルを同時にアーカイブすると、1つだけが 200 で番号を付け、もう1つは 409（channel_archived）になる', async () => {
      const owner = await login();
      const workspace = await workspaceWith(owner);
      const channel = await created(owner, workspace.id, 'twin');

      // 行を共有ロックで掴んだまま確定せず、2つのアーカイブがどちらも行のロックを待つところまで進めてから放す。
      const held = await holdWith(
        (tx) => tx.$queryRaw`SELECT 1 FROM "Channel" WHERE "id" = ${channel}::uuid FOR SHARE`,
      );
      const responses = await (async () => {
        try {
          const pending = [
            archive(owner, workspace.id, channel),
            archive(owner, workspace.id, channel),
          ];
          await vi.waitFor(async () => expect(await waitingOnLock()).toBeGreaterThanOrEqual(2), {
            timeout: 3_000,
            interval: 50,
          });
          held.release();
          await held.done;
          return await Promise.all(pending);
        } finally {
          held.release();
          await held.done.catch(() => undefined);
        }
      })();

      expect(responses.map((res) => res.status).sort((a, b) => a - b)).toEqual([200, 409]);
      const rejected = responses.find((res) => res.status === 409);
      expect(((await rejected?.json()) as ErrorResponse).code).toBe('channel_archived');
      expect(await row(channel)).toMatchObject({ name: 'twin-1', archiveSequence: 1 });
    });
  });
});
