import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import {
  CopyObjectCommand,
  CreateBucketCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutBucketVersioningCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { INestApplication } from '@nestjs/common';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { UPLOAD_FORMATS, type paths } from '@workspace-chat/shared';
import type { StartedTestContainer } from 'testcontainers';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app-setup';
import { hashSecret } from '../auth/secret-hash';
import { PrismaService } from '../prisma.service';
import { S3_CLIENT } from '../storage/storage.module';
import { stubApiEnv } from '../testing/api-env';
import { type StartedMinio, startMinio } from '../testing/minio';
import { POSTGRES_STARTUP_TIMEOUT_MS, startMigratedPostgres } from '../testing/postgres';
import { SAMPLES } from '../testing/upload-samples';
import { startValkey } from '../testing/valkey';

type Workspace = paths['/workspaces']['post']['responses'][201]['content']['application/json'];
type UploadsPath = paths['/workspaces/{id}/channels/{channelId}/attachments/uploads'];
type Ticket = UploadsPath['post']['responses'][201]['content']['application/json'];
type Attachment =
  paths['/workspaces/{id}/channels/{channelId}/attachments/uploads/{uploadId}/complete']['post']['responses'][200]['content']['application/json'];
type MessagesPath = paths['/workspaces/{id}/channels/{channelId}/messages'];
type Message = MessagesPath['post']['responses'][201]['content']['application/json'];
type MessagePage = MessagesPath['get']['responses'][200]['content']['application/json'];
type ErrorResponse = UploadsPath['post']['responses'][422]['content']['application/json'];

const NOT_FOUND = { code: 'not_found', message: '見つかりません' };
const MB = 1024 * 1024;

let sequence = 0;
let ipSequence = 0;
function nextIp(): string {
  ipSequence += 1;
  return `2001:db8::f:${ipSequence.toString(16)}`;
}

type LoggedIn = { authorization: string; id: string };

// 機能一覧 11.1（F-27・F-28）: 添付のアップロード（発行・確定）と投稿への結び付け。S3 は MinIO で代える（#427）。
// CLAUDE.md「必ずテストを書く箇所」: 添付ファイルのアップロード用の署名付き URL の発行が、非参加者を拒否すること／
// オーナーが、参加していないプライベートチャンネルの添付ファイルを取得できないこと（発行もできない）。
describe('チャンネルの添付ファイルのアップロード（F-27・F-28）', () => {
  let postgres: StartedPostgreSqlContainer;
  let valkey: StartedTestContainer;
  let minio: StartedMinio;
  let app: INestApplication;
  let base: string;
  let prisma: PrismaService;
  let admin: S3Client;
  let apiS3: S3Client;
  const bucket = `attachment-upload-${randomUUID()}`;

  async function login(): Promise<LoggedIn> {
    sequence += 1;
    const loginId = `Attach_${Date.now().toString(36)}_${sequence}`;
    const user = await prisma.user.create({
      data: {
        loginId,
        displayName: `上げる人${sequence}`,
        passwordHash: await hashSecret('attach-password'),
      },
    });
    const res = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': nextIp() },
      body: JSON.stringify({ userId: loginId, password: 'attach-password' }),
    });
    expect(res.status).toBe(200);
    const { accessToken } = (await res.json()) as { accessToken: string };
    return { authorization: `Bearer ${accessToken}`, id: user.id };
  }

  async function workspaceWith(owner: LoggedIn, ...members: LoggedIn[]): Promise<Workspace> {
    const res = await fetch(`${base}/api/workspaces`, {
      method: 'POST',
      headers: { authorization: owner.authorization, 'content-type': 'application/json' },
      body: JSON.stringify({ name: '添付の場所' }),
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

  async function channelRow(
    workspaceId: string,
    visibility: 'PUBLIC' | 'PRIVATE',
    participants: LoggedIn[],
  ): Promise<string> {
    sequence += 1;
    const name = `attach-${sequence}`;
    const channel = await prisma.channel.create({
      data: { workspaceId, name, baseName: name, visibility },
    });
    for (const participant of participants) {
      await prisma.channelMember.create({
        data: { channelId: channel.id, workspaceId, userId: participant.id },
      });
    }
    return channel.id;
  }

  /** オーナーとメンバー2人（alice・bob）のワークスペースに、alice だけが参加するパブリックとプライベートのチャンネルを作る。 */
  async function place() {
    const owner = await login();
    const alice = await login();
    const bob = await login();
    const workspace = await workspaceWith(owner, alice, bob);
    const publicId = await channelRow(workspace.id, 'PUBLIC', [alice]);
    const privateId = await channelRow(workspace.id, 'PRIVATE', [alice]);
    return { owner, alice, bob, workspace, publicId, privateId };
  }

  function uploadsPath(workspaceId: string, channelId: string): string {
    return `${base}/api/workspaces/${workspaceId}/channels/${channelId}/attachments/uploads`;
  }

  function issue(
    by: LoggedIn,
    workspaceId: string,
    channelId: string,
    body: unknown,
  ): Promise<Response> {
    return fetch(uploadsPath(workspaceId, channelId), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: by.authorization },
      body: JSON.stringify(body),
    });
  }

  async function issued(
    by: LoggedIn,
    workspaceId: string,
    channelId: string,
    body: { fileName?: string; contentType?: string; size?: number } = {},
  ): Promise<Ticket> {
    const res = await issue(by, workspaceId, channelId, {
      fileName: 'photo.png',
      contentType: 'image/png',
      size: SAMPLES.png.length,
      ...body,
    });
    expect(res.status).toBe(201);
    return (await res.json()) as Ticket;
  }

  function put(ticket: Ticket, bytes: Uint8Array, url = ticket.uploadUrl): Promise<Response> {
    return fetch(url, { method: 'PUT', headers: ticket.uploadHeaders, body: bytes });
  }

  function complete(
    by: LoggedIn,
    workspaceId: string,
    channelId: string,
    uploadId: string,
  ): Promise<Response> {
    return fetch(`${uploadsPath(workspaceId, channelId)}/${uploadId}/complete`, {
      method: 'POST',
      headers: { authorization: by.authorization },
    });
  }

  /** 発行 → PUT → 確定まで通し、確定した添付を返す。 */
  async function uploaded(
    by: LoggedIn,
    workspaceId: string,
    channelId: string,
    bytes: Uint8Array = SAMPLES.png,
    body: { fileName?: string; contentType?: string } = {},
  ): Promise<Attachment> {
    const ticket = await issued(by, workspaceId, channelId, { ...body, size: bytes.length });
    expect((await put(ticket, bytes)).status).toBe(200);
    const res = await complete(by, workspaceId, channelId, ticket.uploadId);
    expect(res.status).toBe(200);
    return (await res.json()) as Attachment;
  }

  function keyOf(ticket: Ticket): string {
    const path = decodeURIComponent(new URL(ticket.uploadUrl).pathname);
    return path.slice(`/${bucket}/`.length);
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

  async function keysUnder(prefix: string): Promise<string[]> {
    const listed = await admin.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix }));
    return (listed.Contents ?? []).map((object) => object.Key ?? '');
  }

  function recordS3Commands(): string[] {
    const sent: string[] = [];
    const original = apiS3.send.bind(apiS3);
    vi.spyOn(apiS3, 'send').mockImplementation(((command: object, ...rest: unknown[]) => {
      sent.push(command.constructor.name);
      return (original as (...args: unknown[]) => unknown)(command, ...rest);
    }) as typeof apiS3.send);
    return sent;
  }

  function postMessage(
    by: LoggedIn,
    workspaceId: string,
    channelId: string,
    body: unknown,
  ): Promise<Response> {
    return fetch(`${base}/api/workspaces/${workspaceId}/channels/${channelId}/messages`, {
      method: 'POST',
      headers: { authorization: by.authorization, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

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
    apiS3 = app.get<S3Client>(S3_CLIENT);
  }, POSTGRES_STARTUP_TIMEOUT_MS);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    admin?.destroy();
    await app?.close();
    await Promise.all([postgres?.stop(), valkey?.stop(), minio?.container.stop()]);
    vi.unstubAllEnvs();
  });

  describe('発行の参加者判定（3.1 と同じ2段階のコード）', () => {
    it('参加者には、そのチャンネルの隔離用のキーへの署名付き URL を発行する', async () => {
      const { alice, workspace, publicId, privateId } = await place();
      for (const channelId of [publicId, privateId]) {
        const ticket = await issued(alice, workspace.id, channelId);
        expect(keyOf(ticket)).toBe(
          `quarantine/workspace/${workspace.id}/channel/${channelId}/${ticket.uploadId}/photo.png`,
        );
        // 隔離用のキーは、添付の署名付き Cookie の対象（/files/workspace/{ws}/channel/{ch}/*）の前方に一致しない
        expect(`/files/${keyOf(ticket)}`.startsWith(`/files/workspace/`)).toBe(false);
        const url = new URL(ticket.uploadUrl);
        expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
        expect(url.searchParams.get('X-Amz-SignedHeaders')?.split(';')).toEqual(
          expect.arrayContaining(['content-type', 'host', 'if-none-match']),
        );
      }
    });

    it('所属していないワークスペースでは、種別によらず 404 で、行を作らない', async () => {
      const { workspace, publicId, privateId } = await place();
      const outsider = await login();
      for (const channelId of [publicId, privateId]) {
        const res = await issue(outsider, workspace.id, channelId, {
          fileName: 'a.png',
          contentType: 'image/png',
          size: 10,
        });
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual(NOT_FOUND);
      }
      expect(await prisma.attachment.count({ where: { uploaderId: outsider.id } })).toBe(0);
    });

    it('所属していて参加していなければ、パブリックは 403 not_a_channel_member・プライベートは 404 で、行を作らない', async () => {
      const { bob, workspace, publicId, privateId } = await place();
      const body = { fileName: 'a.png', contentType: 'image/png', size: 10 };

      const publicRes = await issue(bob, workspace.id, publicId, body);
      expect(publicRes.status).toBe(403);
      expect(((await publicRes.json()) as ErrorResponse).code).toBe('not_a_channel_member');

      const privateRes = await issue(bob, workspace.id, privateId, body);
      expect(privateRes.status).toBe(404);
      expect(await privateRes.json()).toEqual(NOT_FOUND);
      expect(await prisma.attachment.count({ where: { uploaderId: bob.id } })).toBe(0);
    });

    it('オーナーでも、参加していないプライベートチャンネルでは 404（オーナーの例外は添付に及ばない）', async () => {
      const { owner, workspace, privateId } = await place();
      const res = await issue(owner, workspace.id, privateId, {
        fileName: 'a.png',
        contentType: 'image/png',
        size: 10,
      });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual(NOT_FOUND);
    });

    it('参加者であっても、判定を通したチャンネル以外の接頭辞に署名させられない', async () => {
      const { alice, workspace, publicId, privateId } = await place();
      const otherOwner = await login();
      const other = await workspaceWith(otherOwner);
      const otherChannel = await channelRow(other.id, 'PRIVATE', [otherOwner]);

      // キーやパスを本体で渡す手段は無い
      const withKey = await issue(alice, workspace.id, publicId, {
        fileName: 'a.png',
        contentType: 'image/png',
        size: 10,
        key: `quarantine/workspace/${workspace.id}/channel/${privateId}/x/a.png`,
      });
      expect(withKey.status).toBe(400);

      // ファイル名に別のチャンネルの接頭辞を書いても、判定を通したチャンネルの下の保存名になる
      const ticket = await issued(alice, workspace.id, publicId, {
        fileName: `../../../../workspace/${other.id}/channel/${otherChannel}/x.png`,
      });
      expect(
        keyOf(ticket).startsWith(`quarantine/workspace/${workspace.id}/channel/${publicId}/`),
      ).toBe(true);
      expect(keyOf(ticket).slice(keyOf(ticket).lastIndexOf('/') + 1)).not.toContain('/');

      // 払い出した URL のパスを別のチャンネルの接頭辞に書き換えても PUT できない
      const url = new URL(ticket.uploadUrl);
      url.pathname = url.pathname.replace(`/channel/${publicId}/`, `/channel/${privateId}/`);
      expect((await put(ticket, SAMPLES.png, url.toString())).status).toBe(403);
      // 配信用のキーへも書けない
      const delivery = new URL(ticket.uploadUrl);
      delivery.pathname = delivery.pathname.replace('/quarantine/workspace/', '/workspace/');
      expect((await put(ticket, SAMPLES.png, delivery.toString())).status).toBe(403);
      expect(await keysUnder(`quarantine/workspace/${workspace.id}/channel/${privateId}/`)).toEqual(
        [],
      );
      expect(await keysUnder(`workspace/${workspace.id}/`)).toEqual([]);
    });
  });

  describe('発行の形式と大きさ', () => {
    it.each(UPLOAD_FORMATS.map((format) => [format.id, format.contentType] as const))(
      '許可リストの %s（%s）は発行できる',
      async (_, contentType) => {
        const { alice, workspace, publicId } = await place();
        await issued(alice, workspace.id, publicId, { fileName: 'a', contentType, size: 1 });
      },
    );

    it.each([
      ['SVG', 'image/svg+xml'],
      ['HTML', 'text/html'],
      ['実行形式', 'application/x-msdownload'],
      ['マクロ付きの Word', 'application/vnd.ms-word.document.macroEnabled.12'],
      ['引数付きの Content-Type', 'text/plain; charset=utf-8'],
    ])('許可リストに無い形式（%s）は 422 unsupported_file_type', async (_, contentType) => {
      const { alice, workspace, publicId } = await place();
      const res = await issue(alice, workspace.id, publicId, {
        fileName: 'a',
        contentType,
        size: 10,
      });
      expect(res.status).toBe(422);
      expect(((await res.json()) as ErrorResponse).code).toBe('unsupported_file_type');
      expect(await prisma.attachment.count({ where: { uploaderId: alice.id } })).toBe(0);
    });

    it.each([
      ['画像', 'image/png', 10 * MB],
      ['動画', 'video/mp4', 100 * MB],
      ['文書', 'application/pdf', 25 * MB],
      ['テキスト', 'text/csv', 25 * MB],
      ['圧縮', 'application/zip', 25 * MB],
    ])(
      '%s は上限（%s・%i バイト）ちょうどまで発行でき、超えると 422 file_too_large',
      async (_, contentType, limit) => {
        const { alice, workspace, publicId } = await place();
        await issued(alice, workspace.id, publicId, { contentType, size: limit });
        const res = await issue(alice, workspace.id, publicId, {
          fileName: 'a',
          contentType,
          size: limit + 1,
        });
        expect(res.status).toBe(422);
        expect(((await res.json()) as ErrorResponse).code).toBe('file_too_large');
      },
    );

    it('利用者単位で 10 分に 30 回までで、超えたら 429', async () => {
      const { alice, workspace, publicId } = await place();
      for (let i = 0; i < 30; i += 1) await issued(alice, workspace.id, publicId);
      const res = await issue(alice, workspace.id, publicId, {
        fileName: 'a.png',
        contentType: 'image/png',
        size: 10,
      });
      expect(res.status).toBe(429);
    });
  });

  describe('確定', () => {
    it('検証した画像を配信用のキーへ移し、添付（元のファイル名・配信の形式・配信 URL のパス）を返し、隔離用のキーを削除する', async () => {
      const { alice, workspace, publicId } = await place();
      const ticket = await issued(alice, workspace.id, publicId, { fileName: '会議の写真.png' });
      await put(ticket, SAMPLES.png);

      const res = await complete(alice, workspace.id, publicId, ticket.uploadId);

      expect(res.status).toBe(200);
      const key = `workspace/${workspace.id}/channel/${publicId}/${ticket.uploadId}/_____.png`;
      expect((await res.json()) as Attachment).toEqual({
        id: ticket.uploadId,
        fileName: '会議の写真.png',
        contentType: 'image/png',
        kind: 'image',
        size: SAMPLES.png.length,
        url: `/files/${key}`,
      });
      const delivered = await admin.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      expect(Buffer.from(await delivered.Body!.transformToByteArray())).toEqual(
        Buffer.from(SAMPLES.png),
      );
      expect(delivered.ContentType).toBe('image/png');
      expect(delivered.ContentDisposition).toBe(
        `inline; filename="_____.png"; filename*=UTF-8''_____.png`,
      );
      expect(await exists(keyOf(ticket))).toBe(false);
    });

    it.each([
      ['mp4', 'clip.mp4', 'video/mp4', SAMPLES.mp4, 'video', 'video/mp4', 'inline', 'clip.mp4'],
      [
        'webm',
        'clip.webm',
        'video/webm',
        SAMPLES.webm,
        'video',
        'video/webm',
        'inline',
        'clip.webm',
      ],
      [
        'pdf',
        'doc.pdf',
        'application/pdf',
        SAMPLES.pdf,
        'document',
        'application/pdf',
        'attachment',
        'doc.pdf',
      ],
      [
        'docx（zip の容器）',
        'report.docx',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        SAMPLES.zip,
        'document',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'attachment',
        'report.docx',
      ],
      [
        'zip',
        'a.zip',
        'application/zip',
        SAMPLES.zip,
        'archive',
        'application/zip',
        'attachment',
        'a.zip',
      ],
      [
        'csv（テキスト系は text/plain; charset=utf-8 に固定）',
        'table.csv',
        'text/csv',
        new TextEncoder().encode('名前,値\nあ,1\n'),
        'document',
        'text/plain; charset=utf-8',
        'attachment',
        'table.csv',
      ],
      [
        'HTML の中身を txt と申告したもの（UTF-8 としては正しい。HTML として解釈させないのは配信のヘッダーの役目）',
        'page.html',
        'text/plain',
        SAMPLES.html,
        'document',
        'text/plain; charset=utf-8',
        'attachment',
        'page.txt',
      ],
      [
        '二重拡張子（最後の拡張子を検証した形式のものに付け替える）',
        'shell.jpg.php',
        'image/png',
        SAMPLES.png,
        'image',
        'image/png',
        'inline',
        'shell.jpg.png',
      ],
      [
        '拡張子の無い md',
        'README',
        'text/markdown',
        new TextEncoder().encode('# 見出し'),
        'document',
        'text/plain; charset=utf-8',
        'attachment',
        'README.md',
      ],
    ] as const)(
      '%s: 配信の Content-Type・Content-Disposition・保存名の拡張子を、検証した形式から決める',
      async (_, fileName, contentType, bytes, kind, served, disposition, storedName) => {
        const { alice, workspace, publicId } = await place();
        const attachment = await uploaded(alice, workspace.id, publicId, bytes, {
          fileName,
          contentType,
        });
        const key = `workspace/${workspace.id}/channel/${publicId}/${attachment.id}/${storedName}`;
        expect(attachment).toMatchObject({
          fileName,
          kind,
          contentType: served,
          url: `/files/${key}`,
        });
        const head = await admin.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        expect(head.ContentType).toBe(served);
        expect(head.ContentDisposition).toBe(
          `${disposition}; filename="${storedName}"; filename*=UTF-8''${storedName}`,
        );
      },
    );

    it.each([
      ['SVG を png と申告したもの', 'image/png', SAMPLES.svg, 'unsupported_file_type'],
      [
        'UTF-16 のテキスト（NUL を含む）',
        'text/plain',
        new Uint8Array([0xff, 0xfe, 0x61, 0x00]),
        'unsupported_file_type',
      ],
      [
        'UTF-8 として壊れたテキスト',
        'text/csv',
        new Uint8Array([0x61, 0xff]),
        'unsupported_file_type',
      ],
      ['実行形式を zip と申告したもの', 'application/zip', SAMPLES.exe, 'unsupported_file_type'],
    ])(
      '%s は 422 で断り、配信用のキーへ移さず、隔離用のキーを削除する',
      async (_, contentType, bytes, code) => {
        const { alice, workspace, publicId } = await place();
        const ticket = await issued(alice, workspace.id, publicId, {
          contentType,
          size: bytes.length,
        });
        expect((await put(ticket, bytes)).status).toBe(200);

        const res = await complete(alice, workspace.id, publicId, ticket.uploadId);

        expect(res.status).toBe(422);
        expect(((await res.json()) as ErrorResponse).code).toBe(code);
        expect(await keysUnder(`workspace/${workspace.id}/`)).toEqual([]);
        expect(await exists(keyOf(ticket))).toBe(false);
      },
    );

    it('種別の上限を超える本体は、申告が上限の内でも 422 file_too_large で断る（文書 25 MB）', async () => {
      const { alice, workspace, publicId } = await place();
      const ticket = await issued(alice, workspace.id, publicId, {
        fileName: 'big.pdf',
        contentType: 'application/pdf',
        size: 10,
      });
      const large = new Uint8Array(25 * MB + 1);
      large.set(SAMPLES.pdf);
      expect((await put(ticket, large)).status).toBe(200);

      const res = await complete(alice, workspace.id, publicId, ticket.uploadId);

      expect(res.status).toBe(422);
      expect(((await res.json()) as ErrorResponse).code).toBe('file_too_large');
      expect(await keysUnder(`workspace/${workspace.id}/`)).toEqual([]);
      expect(await exists(keyOf(ticket))).toBe(false);
    });

    it('発行の後にキックされた利用者の確定は 404 で断り、隔離用のキーを削除し、再び参加しても同じ識別子では確定できない', async () => {
      const { owner, alice, workspace, privateId } = await place();
      const ticket = await issued(alice, workspace.id, privateId);
      await put(ticket, SAMPLES.png);
      await fetch(`${base}/api/workspaces/${workspace.id}/members/${alice.id}`, {
        method: 'DELETE',
        headers: { authorization: owner.authorization },
      });

      const res = await complete(alice, workspace.id, privateId, ticket.uploadId);

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual(NOT_FOUND);
      expect(await keysUnder(`workspace/${workspace.id}/`)).toEqual([]);
      expect(await exists(keyOf(ticket))).toBe(false);

      // 再び参加し、期限内に同じ URL で書き直しても、同じ識別子の確定の権利は使い切っている
      await prisma.membership.create({
        data: { workspaceId: workspace.id, userId: alice.id, role: 'MEMBER' },
      });
      await prisma.channelMember.create({
        data: { channelId: privateId, workspaceId: workspace.id, userId: alice.id },
      });
      expect((await put(ticket, SAMPLES.png)).status).toBe(200);
      const sent = recordS3Commands();
      const again = await complete(alice, workspace.id, privateId, ticket.uploadId);
      expect(again.status).toBe(404);
      expect(sent).toEqual([]);
      expect(await keysUnder(`workspace/${workspace.id}/`)).toEqual([]);
    });

    it('発行の後にパブリックチャンネルから退出した利用者の確定は 403 not_a_channel_member で断り、2回目も同じ', async () => {
      const { alice, workspace, publicId } = await place();
      const ticket = await issued(alice, workspace.id, publicId);
      await put(ticket, SAMPLES.png);
      await prisma.channelMember.deleteMany({ where: { channelId: publicId, userId: alice.id } });

      for (let i = 0; i < 2; i += 1) {
        const res = await complete(alice, workspace.id, publicId, ticket.uploadId);
        expect(res.status).toBe(403);
        expect(((await res.json()) as ErrorResponse).code).toBe('not_a_channel_member');
      }
      expect(await exists(keyOf(ticket))).toBe(false);
      expect(await keysUnder(`workspace/${workspace.id}/`)).toEqual([]);
    });

    it('他の利用者に払い出された識別子（別のチャンネルの隔離用のキーを指すものを含む）では確定させられず、払い出された本人の権利も使わない', async () => {
      const { alice, bob, workspace, publicId, privateId } = await place();
      await prisma.channelMember.create({
        data: { channelId: publicId, workspaceId: workspace.id, userId: bob.id },
      });
      const privateTicket = await issued(alice, workspace.id, privateId);
      await put(privateTicket, SAMPLES.png);
      const publicTicket = await issued(alice, workspace.id, publicId);
      await put(publicTicket, SAMPLES.png);
      const sent = recordS3Commands();

      // bob は publicId の参加者だが、alice の識別子（privateId の隔離用のキーを指すもの）を自分のチャンネルの経路で確定させられない
      for (const [channelId, uploadId] of [
        [publicId, privateTicket.uploadId],
        [publicId, publicTicket.uploadId],
        [privateId, privateTicket.uploadId],
        [publicId, randomUUID()],
      ] as const) {
        const res = await complete(bob, workspace.id, channelId, uploadId);
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual(NOT_FOUND);
      }
      // 本人でも、発行した経路と違うチャンネルの経路では確定させられない
      const wrongPath = await complete(alice, workspace.id, publicId, privateTicket.uploadId);
      expect(wrongPath.status).toBe(404);
      expect(sent).toEqual([]);
      vi.restoreAllMocks();

      expect((await complete(alice, workspace.id, privateId, privateTicket.uploadId)).status).toBe(
        200,
      );
      expect(await keysUnder(`workspace/${workspace.id}/channel/${publicId}/`)).toEqual([]);
    });

    it('同じ識別子の2回目以降の確定は、コピーも削除もせず、1回目と同じ結果を返す', async () => {
      const { alice, workspace, publicId } = await place();
      const ticket = await issued(alice, workspace.id, publicId, { fileName: 'once.png' });
      await put(ticket, SAMPLES.png);
      const first = await complete(alice, workspace.id, publicId, ticket.uploadId);
      expect(first.status).toBe(200);
      const attachment = (await first.json()) as Attachment;
      expect((await put(ticket, SAMPLES.gif)).status).toBe(200);
      const sent = recordS3Commands();

      const again = await complete(alice, workspace.id, publicId, ticket.uploadId);

      expect(again.status).toBe(200);
      expect(await again.json()).toEqual(attachment);
      expect(sent).toEqual([]);
      const delivered = await admin.send(
        new GetObjectCommand({ Bucket: bucket, Key: attachment.url.slice('/files/'.length) }),
      );
      expect(Buffer.from(await delivered.Body!.transformToByteArray())).toEqual(
        Buffer.from(SAMPLES.png),
      );
    });

    it('配信用のキーには検証した版のバイト列だけが載る（検証の後に隔離用のキーを差し替えても載らない）', async () => {
      const { alice, workspace, publicId } = await place();
      const ticket = await issued(alice, workspace.id, publicId);
      await put(ticket, SAMPLES.png);
      const original = apiS3.send.bind(apiS3);
      vi.spyOn(apiS3, 'send').mockImplementation((async (command: object, ...rest: unknown[]) => {
        if (command instanceof CopyObjectCommand) {
          await admin.send(
            new PutObjectCommand({ Bucket: bucket, Key: keyOf(ticket), Body: SAMPLES.html }),
          );
        }
        return (original as (...args: unknown[]) => unknown)(command, ...rest);
      }) as typeof apiS3.send);

      const res = await complete(alice, workspace.id, publicId, ticket.uploadId);

      expect(res.status).toBe(200);
      const attachment = (await res.json()) as Attachment;
      const delivered = await admin.send(
        new GetObjectCommand({ Bucket: bucket, Key: attachment.url.slice('/files/'.length) }),
      );
      expect(Buffer.from(await delivered.Body!.transformToByteArray())).toEqual(
        Buffer.from(SAMPLES.png),
      );
    });

    it('利用者単位で 10 分に 30 回までで、超えたら 429', async () => {
      const { alice, workspace, publicId } = await place();
      for (let i = 0; i < 30; i += 1) {
        expect((await complete(alice, workspace.id, publicId, randomUUID())).status).toBe(404);
      }
      expect((await complete(alice, workspace.id, publicId, randomUUID())).status).toBe(429);
    });
  });

  describe('投稿への結び付け', () => {
    it('確定した添付を投稿に付けると、投稿の応答と一覧に上げた順で載る', async () => {
      const { alice, workspace, publicId } = await place();
      const first = await uploaded(alice, workspace.id, publicId, SAMPLES.png, {
        fileName: 'a.png',
      });
      const second = await uploaded(alice, workspace.id, publicId, SAMPLES.pdf, {
        fileName: 'b.pdf',
        contentType: 'application/pdf',
      });

      const res = await postMessage(alice, workspace.id, publicId, {
        body: '資料です',
        attachmentIds: [second.id, first.id],
      });

      expect(res.status).toBe(201);
      const message = (await res.json()) as Message;
      expect(message.attachments).toEqual([first, second]);
      const list = await fetch(
        `${base}/api/workspaces/${workspace.id}/channels/${publicId}/messages`,
        { headers: { authorization: alice.authorization } },
      );
      const page = (await list.json()) as MessagePage;
      expect(page.messages[0]?.attachments).toEqual([first, second]);
    });

    it('添付の無い投稿は attachments が空', async () => {
      const { alice, workspace, publicId } = await place();
      const res = await postMessage(alice, workspace.id, publicId, { body: '本文だけ' });
      expect(((await res.json()) as Message).attachments).toEqual([]);
    });

    it('付けられない添付が1つでもあれば 422 attachment_unavailable で、投稿しない', async () => {
      const { alice, bob, workspace, publicId, privateId } = await place();
      await prisma.channelMember.create({
        data: { channelId: publicId, workspaceId: workspace.id, userId: bob.id },
      });
      const ok = await uploaded(alice, workspace.id, publicId);
      const notCompleted = await issued(alice, workspace.id, publicId);
      const rejectedTicket = await issued(alice, workspace.id, publicId);
      await put(rejectedTicket, SAMPLES.svg);
      expect((await complete(alice, workspace.id, publicId, rejectedTicket.uploadId)).status).toBe(
        422,
      );
      const bobs = await uploaded(bob, workspace.id, publicId);
      const otherChannel = await uploaded(alice, workspace.id, privateId);
      const used = await uploaded(alice, workspace.id, publicId);
      expect(
        (
          await postMessage(alice, workspace.id, publicId, {
            body: '先に使う',
            attachmentIds: [used.id],
          })
        ).status,
      ).toBe(201);
      const before = await prisma.message.count({ where: { channelId: publicId } });

      for (const unavailable of [
        notCompleted.uploadId,
        rejectedTicket.uploadId,
        bobs.id,
        otherChannel.id,
        used.id,
        randomUUID(),
      ]) {
        const res = await postMessage(alice, workspace.id, publicId, {
          body: '付けられない',
          attachmentIds: [ok.id, unavailable],
        });
        expect(res.status).toBe(422);
        expect(((await res.json()) as ErrorResponse).code).toBe('attachment_unavailable');
      }
      expect(await prisma.message.count({ where: { channelId: publicId } })).toBe(before);
      // 断った投稿は、付けられた方の添付も結び付けない
      expect(
        (await prisma.attachment.findUniqueOrThrow({ where: { id: ok.id } })).messageId,
      ).toBeNull();
    });

    it('11 件以上の添付は 400', async () => {
      const { alice, workspace, publicId } = await place();
      const res = await postMessage(alice, workspace.id, publicId, {
        body: '多すぎる',
        attachmentIds: Array.from({ length: 11 }, () => randomUUID()),
      });
      expect(res.status).toBe(400);
    });

    it('削除したメッセージは、添付を返さない', async () => {
      const { alice, workspace, publicId } = await place();
      const attachment = await uploaded(alice, workspace.id, publicId);
      const posted = (await (
        await postMessage(alice, workspace.id, publicId, {
          body: '消す',
          attachmentIds: [attachment.id],
        })
      ).json()) as Message;
      const removed = await fetch(
        `${base}/api/workspaces/${workspace.id}/channels/${publicId}/messages/${posted.id}`,
        { method: 'DELETE', headers: { authorization: alice.authorization } },
      );
      expect(removed.status).toBe(204);

      const list = await fetch(
        `${base}/api/workspaces/${workspace.id}/channels/${publicId}/messages`,
        { headers: { authorization: alice.authorization } },
      );
      const page = (await list.json()) as MessagePage;
      expect(page.messages.find((message) => message.id === posted.id)?.attachments).toEqual([]);
    });
  });
});
