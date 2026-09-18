import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import {
  CreateBucketCommand,
  HeadObjectCommand,
  PutBucketVersioningCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { INestApplication } from '@nestjs/common';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { paths } from '@workspace-chat/shared';
import type { StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app-setup';
import { hashSecret } from '../auth/secret-hash';
import { PrismaService } from '../prisma.service';
import { stubApiEnv } from '../testing/api-env';
import { type StartedMinio, startMinio } from '../testing/minio';
import { POSTGRES_STARTUP_TIMEOUT_MS, startMigratedPostgres } from '../testing/postgres';
import { SAMPLES } from '../testing/upload-samples';
import { startValkey } from '../testing/valkey';

type Workspace = paths['/workspaces']['post']['responses'][201]['content']['application/json'];
type UploadsPath = paths['/workspaces/{id}/dms/{dmId}/attachments/uploads'];
type Ticket = UploadsPath['post']['responses'][201]['content']['application/json'];
type Attachment =
  paths['/workspaces/{id}/dms/{dmId}/attachments/uploads/{uploadId}/complete']['post']['responses'][200]['content']['application/json'];
type DmMessagesPath = paths['/workspaces/{id}/dms/{dmId}/messages'];
type DmMessage = DmMessagesPath['post']['responses'][201]['content']['application/json'];
type DmMessagePage = DmMessagesPath['get']['responses'][200]['content']['application/json'];

const NOT_FOUND = { code: 'not_found', message: '見つかりません' };

let sequence = 0;
let ipSequence = 0;
function nextIp(): string {
  ipSequence += 1;
  return `2001:db8::d1:${ipSequence.toString(16)}`;
}

type LoggedIn = { authorization: string; id: string };

// #239（決定・2026-09-11・依頼側）: DM の添付のアップロード（発行・確定）と投稿への結び付け。S3 は MinIO で代える。
// CLAUDE.md「必ずテストを書く箇所」: 添付ファイルのアップロード用の署名付き URL の発行が、非参加者（DM では当事者でない利用者）を拒否すること。
describe('DM の添付ファイルのアップロード（#239）', () => {
  let postgres: StartedPostgreSqlContainer;
  let valkey: StartedTestContainer;
  let minio: StartedMinio;
  let app: INestApplication;
  let base: string;
  let prisma: PrismaService;
  let admin: S3Client;
  const bucket = `dm-attachment-${randomUUID()}`;

  async function login(): Promise<LoggedIn> {
    sequence += 1;
    const loginId = `DmAt_${Date.now().toString(36)}_${sequence}`;
    const user = await prisma.user.create({
      data: {
        loginId,
        displayName: `DM で上げる人${sequence}`,
        passwordHash: await hashSecret('dm-attach-password'),
      },
    });
    const res = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': nextIp() },
      body: JSON.stringify({ userId: loginId, password: 'dm-attach-password' }),
    });
    expect(res.status).toBe(200);
    const { accessToken } = (await res.json()) as { accessToken: string };
    return { authorization: `Bearer ${accessToken}`, id: user.id };
  }

  function send(method: string, path: string, by: LoggedIn, body?: unknown): Promise<Response> {
    return fetch(`${base}/api${path}`, {
      method,
      headers: {
        authorization: by.authorization,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  /** オーナー・alice・bob のワークスペースで、alice と bob の DM を作る。 */
  async function dmOfTwo() {
    const owner = await login();
    const alice = await login();
    const bob = await login();
    const created = await send('POST', '/workspaces', owner, { name: 'DM の添付の場所' });
    expect(created.status).toBe(201);
    const workspace = (await created.json()) as Workspace;
    for (const member of [alice, bob]) {
      await prisma.membership.create({
        data: { workspaceId: workspace.id, userId: member.id, role: 'MEMBER' },
      });
    }
    const res = await send('POST', `/workspaces/${workspace.id}/dms`, alice, { userId: bob.id });
    expect(res.status).toBe(200);
    const dm = (await res.json()) as { id: string };
    return { owner, alice, bob, workspace, dmId: dm.id };
  }

  const uploadsPath = (workspaceId: string, dmId: string) =>
    `/workspaces/${workspaceId}/dms/${dmId}/attachments/uploads`;

  function issue(by: LoggedIn, workspaceId: string, dmId: string): Promise<Response> {
    return send('POST', uploadsPath(workspaceId, dmId), by, {
      fileName: 'photo.png',
      contentType: 'image/png',
      size: SAMPLES.png.length,
    });
  }

  async function issued(by: LoggedIn, workspaceId: string, dmId: string): Promise<Ticket> {
    const res = await issue(by, workspaceId, dmId);
    expect(res.status).toBe(201);
    return (await res.json()) as Ticket;
  }

  function put(ticket: Ticket): Promise<Response> {
    return fetch(ticket.uploadUrl, {
      method: 'PUT',
      headers: ticket.uploadHeaders,
      body: SAMPLES.png,
    });
  }

  function complete(by: LoggedIn, workspaceId: string, dmId: string, uploadId: string) {
    return send('POST', `${uploadsPath(workspaceId, dmId)}/${uploadId}/complete`, by);
  }

  async function uploaded(by: LoggedIn, workspaceId: string, dmId: string): Promise<Attachment> {
    const ticket = await issued(by, workspaceId, dmId);
    expect((await put(ticket)).status).toBe(200);
    const res = await complete(by, workspaceId, dmId, ticket.uploadId);
    expect(res.status).toBe(200);
    return (await res.json()) as Attachment;
  }

  function keyOf(ticket: Ticket): string {
    return decodeURIComponent(new URL(ticket.uploadUrl).pathname).slice(`/${bucket}/`.length);
  }

  async function exists(key: string): Promise<boolean> {
    try {
      await admin.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      return true;
    } catch (error) {
      if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404)
        return false;
      throw error;
    }
  }

  const messagesPath = (workspaceId: string, dmId: string) =>
    `/workspaces/${workspaceId}/dms/${dmId}/messages`;

  beforeAll(async () => {
    [postgres, minio] = await Promise.all([startMigratedPostgres(), startMinio()]);
    const started = await startValkey();
    valkey = started.container;
    stubApiEnv({
      DATABASE_URL: postgres.getConnectionUri(),
      REDIS_URL: started.url,
      TRUST_PROXY_HOPS: '1',
      S3_BUCKET: bucket,
      S3_ENDPOINT: minio.endpoint,
      S3_FORCE_PATH_STYLE: 'true',
    });
    vi.stubEnv('AWS_ACCESS_KEY_ID', minio.accessKeyId);
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', minio.secretAccessKey);
    vi.stubEnv('AWS_SESSION_TOKEN', undefined);
    admin = new S3Client({
      region: 'ap-northeast-1',
      endpoint: minio.endpoint,
      forcePathStyle: true,
      credentials: { accessKeyId: minio.accessKeyId, secretAccessKey: minio.secretAccessKey },
    });
    await admin.send(new CreateBucketCommand({ Bucket: bucket }));
    await admin.send(
      new PutBucketVersioningCommand({
        Bucket: bucket,
        VersioningConfiguration: { Status: 'Enabled' },
      }),
    );
    app = await createApp({ logger: false });
    await app.listen(0, '127.0.0.1');
    const { port } = app.getHttpServer().address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
    prisma = app.get(PrismaService);
  }, POSTGRES_STARTUP_TIMEOUT_MS);

  afterAll(async () => {
    admin?.destroy();
    await app?.close();
    await Promise.all([postgres?.stop(), valkey?.stop(), minio?.container.stop()]);
    vi.unstubAllEnvs();
  });

  describe('発行と確定の当事者の判定', () => {
    it('当事者は、その DM の隔離用のキーへの署名付き URL を受け取り、確定すると DM の下の配信 URL を持つ添付になる', async () => {
      const { alice, bob, workspace, dmId } = await dmOfTwo();
      for (const party of [alice, bob]) {
        const ticket = await issued(party, workspace.id, dmId);
        expect(keyOf(ticket)).toBe(
          `quarantine/workspace/${workspace.id}/dm/${dmId}/${ticket.uploadId}/photo.png`,
        );
        expect((await put(ticket)).status).toBe(200);
        const res = await complete(party, workspace.id, dmId, ticket.uploadId);
        expect(res.status).toBe(200);
        const attachment = (await res.json()) as Attachment;
        expect(attachment.url).toBe(
          `/files/workspace/${workspace.id}/dm/${dmId}/${ticket.uploadId}/photo.png`,
        );
        expect(
          await exists(`workspace/${workspace.id}/dm/${dmId}/${ticket.uploadId}/photo.png`),
        ).toBe(true);
        expect(await exists(keyOf(ticket))).toBe(false);
      }
    });

    it('当事者でない利用者（オーナーを含む）・所属していない利用者・別のワークスペースの id では、発行を 404 で断り、行を作らない', async () => {
      const { owner, alice, workspace, dmId } = await dmOfTwo();
      const outsider = await login();
      const other = (await (
        await send('POST', '/workspaces', alice, { name: '別' })
      ).json()) as Workspace;

      for (const [who, workspaceId] of [
        [owner, workspace.id],
        [outsider, workspace.id],
        [alice, other.id],
      ] as const) {
        const res = await issue(who, workspaceId, dmId);
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual(NOT_FOUND);
      }
      expect(await prisma.dmAttachment.count({ where: { dmId } })).toBe(0);
    });

    it('払い出された本人でない当事者・別の DM の経路からは、確定を 404 で断る', async () => {
      const { alice, bob, workspace, dmId } = await dmOfTwo();
      const carol = await login();
      await prisma.membership.create({
        data: { workspaceId: workspace.id, userId: carol.id, role: 'MEMBER' },
      });
      const otherDm = (await (
        await send('POST', `/workspaces/${workspace.id}/dms`, alice, { userId: carol.id })
      ).json()) as { id: string };
      const ticket = await issued(alice, workspace.id, dmId);
      expect((await put(ticket)).status).toBe(200);

      expect((await complete(bob, workspace.id, dmId, ticket.uploadId)).status).toBe(404);
      expect((await complete(alice, workspace.id, otherDm.id, ticket.uploadId)).status).toBe(404);
    });

    it('確定の時点でワークスペースから外れていたら 404 で断り、隔離用のキーを消し、配信用のキーへ移さない', async () => {
      const { alice, workspace, dmId } = await dmOfTwo();
      const ticket = await issued(alice, workspace.id, dmId);
      expect((await put(ticket)).status).toBe(200);
      await prisma.membership.deleteMany({
        where: { workspaceId: workspace.id, userId: alice.id },
      });

      const res = await complete(alice, workspace.id, dmId, ticket.uploadId);

      expect(res.status).toBe(404);
      expect(await exists(keyOf(ticket))).toBe(false);
      expect(
        await exists(`workspace/${workspace.id}/dm/${dmId}/${ticket.uploadId}/photo.png`),
      ).toBe(false);
    });
  });

  describe('投稿への結び付け', () => {
    it('確定した添付を付けて投稿でき（本文は空でもよい）、応答と一覧に載り、削除すると載らない', async () => {
      const { alice, bob, workspace, dmId } = await dmOfTwo();
      const attachment = await uploaded(alice, workspace.id, dmId);

      const res = await send('POST', messagesPath(workspace.id, dmId), alice, {
        body: '',
        attachmentIds: [attachment.id],
      });
      expect(res.status).toBe(201);
      const message = (await res.json()) as DmMessage;
      expect(message.attachments).toEqual([attachment]);

      const page = (await (
        await send('GET', messagesPath(workspace.id, dmId), bob)
      ).json()) as DmMessagePage;
      expect(page.messages.find((m) => m.id === message.id)?.attachments).toEqual([attachment]);

      const removed = await send(
        'DELETE',
        `${messagesPath(workspace.id, dmId)}/${message.id}`,
        alice,
      );
      expect(removed.status).toBe(204);
      const after = (await (
        await send('GET', messagesPath(workspace.id, dmId), bob)
      ).json()) as DmMessagePage;
      expect(after.messages.find((m) => m.id === message.id)?.attachments).toEqual([]);
    });

    it('付けられない添付（相手が上げた・別の DM の・確定していない・付け済み）が1つでもあれば 422 attachment_unavailable で、投稿しない', async () => {
      const { alice, bob, workspace, dmId } = await dmOfTwo();
      const carol = await login();
      await prisma.membership.create({
        data: { workspaceId: workspace.id, userId: carol.id, role: 'MEMBER' },
      });
      const otherDm = (await (
        await send('POST', `/workspaces/${workspace.id}/dms`, alice, { userId: carol.id })
      ).json()) as { id: string };
      const bobs = await uploaded(bob, workspace.id, dmId);
      const elsewhere = await uploaded(alice, workspace.id, otherDm.id);
      const notCompleted = await issued(alice, workspace.id, dmId);
      const used = await uploaded(alice, workspace.id, dmId);
      expect(
        (
          await send('POST', messagesPath(workspace.id, dmId), alice, {
            body: '先に付ける',
            attachmentIds: [used.id],
          })
        ).status,
      ).toBe(201);
      const before = await prisma.dmMessage.count({ where: { dmId } });

      for (const id of [bobs.id, elsewhere.id, notCompleted.uploadId, used.id]) {
        const res = await send('POST', messagesPath(workspace.id, dmId), alice, {
          body: '付ける',
          attachmentIds: [id],
        });
        expect(res.status).toBe(422);
        expect(((await res.json()) as { code: string }).code).toBe('attachment_unavailable');
      }
      expect(await prisma.dmMessage.count({ where: { dmId } })).toBe(before);
    });

    it('添付が無ければ、空・空白だけの本文は 400 で断る', async () => {
      const { alice, workspace, dmId } = await dmOfTwo();
      for (const body of [{ body: '' }, { body: '   ' }, { body: '', attachmentIds: [] }]) {
        expect((await send('POST', messagesPath(workspace.id, dmId), alice, body)).status).toBe(
          400,
        );
      }
    });
  });
});
