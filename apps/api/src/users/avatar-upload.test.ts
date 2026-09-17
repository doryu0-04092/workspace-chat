import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import {
  CopyObjectCommand,
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutBucketVersioningCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { INestApplication } from '@nestjs/common';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { paths } from '@workspace-chat/shared';
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

type Profile = paths['/users/me']['get']['responses'][200]['content']['application/json'];
type Ticket =
  paths['/users/me/avatar/uploads']['post']['responses'][201]['content']['application/json'];
type ErrorResponse =
  paths['/users/me/avatar/uploads']['post']['responses'][422]['content']['application/json'];

let sequence = 0;
let ipSequence = 0;
function nextIp(): string {
  ipSequence += 1;
  return `2001:db8::a:${ipSequence.toString(16)}`;
}

const MB = 1024 * 1024;

// 機能一覧 1.3（F-04 のアバター画像）。11.1 の受け入れ条件とテストの行を、1.3 の読み替え（画像だけ・本人のプロフィール・
// キーの形式・確定で落ちたら本人に払い出されていない識別子への 404 だけ）で当てる。S3 は MinIO で代える（#427）。
/** 本体を指定の大きさに詰める・切る（署名付き URL は大きさを署名に含むため、同じ URL で送り直すときは申告の大きさに揃える。#611）。 */
function resized(bytes: Uint8Array, length: number): Uint8Array {
  const out = new Uint8Array(length);
  out.set(bytes.subarray(0, length));
  return out;
}

describe('アバター画像のアップロード（F-04。POST /api/users/me/avatar/uploads と complete）', () => {
  let postgres: StartedPostgreSqlContainer;
  let valkey: StartedTestContainer;
  let minio: StartedMinio;
  let app: INestApplication;
  let base: string;
  let prisma: PrismaService;
  /** テストの側から S3 を直接読み書きする（api とは別の、管理者の資格情報のクライアント）。 */
  let admin: S3Client;
  let apiS3: S3Client;
  const bucket = `avatar-upload-${randomUUID()}`;

  async function login(): Promise<{ authorization: string; id: string }> {
    sequence += 1;
    const loginId = `Avatar_${Date.now().toString(36)}_${sequence}`;
    const user = await prisma.user.create({
      data: {
        loginId,
        displayName: 'アバターの利用者',
        passwordHash: await hashSecret('avatar-password'),
      },
    });
    const res = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': nextIp() },
      body: JSON.stringify({ userId: loginId, password: 'avatar-password' }),
    });
    expect(res.status).toBe(200);
    const { accessToken } = (await res.json()) as { accessToken: string };
    return { authorization: `Bearer ${accessToken}`, id: user.id };
  }

  function issue(authorization: string, body: unknown): Promise<Response> {
    return fetch(`${base}/api/users/me/avatar/uploads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization },
      body: JSON.stringify(body),
    });
  }

  async function issued(
    authorization: string,
    body: { fileName?: string; contentType?: string; size?: number } = {},
  ): Promise<Ticket> {
    const res = await issue(authorization, {
      fileName: 'avatar.png',
      contentType: 'image/png',
      size: SAMPLES.png.length,
      ...body,
    });
    expect(res.status).toBe(201);
    return (await res.json()) as Ticket;
  }

  function put(
    ticket: Ticket,
    bytes: Uint8Array,
    headers: Record<string, string | undefined> = ticket.uploadHeaders,
    url = ticket.uploadUrl,
  ): Promise<Response> {
    const sent = Object.fromEntries(
      Object.entries(headers).filter((entry): entry is [string, string] => entry[1] !== undefined),
    );
    return fetch(url, { method: 'PUT', headers: sent, body: bytes });
  }

  function complete(authorization: string, uploadId: string): Promise<Response> {
    return fetch(`${base}/api/users/me/avatar/uploads/${uploadId}/complete`, {
      method: 'POST',
      headers: { authorization },
    });
  }

  function keyOf(ticket: Ticket): string {
    const path = decodeURIComponent(new URL(ticket.uploadUrl).pathname);
    const prefix = `/${bucket}/`;
    expect(path.startsWith(prefix)).toBe(true);
    return path.slice(prefix.length);
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

  async function avatarUrlOf(id: string): Promise<string | null> {
    return (await prisma.user.findUniqueOrThrow({ where: { id }, select: { avatarUrl: true } }))
      .avatarUrl;
  }

  /** api の S3 のクライアントに送られたコマンドの名前を記録する。 */
  function recordS3Commands(): string[] {
    const sent: string[] = [];
    const original = apiS3.send.bind(apiS3);
    vi.spyOn(apiS3, 'send').mockImplementation(((command: object, ...rest: unknown[]) => {
      sent.push(command.constructor.name);
      return (original as (...args: unknown[]) => unknown)(command, ...rest);
    }) as typeof apiS3.send);
    return sent;
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

  describe('発行', () => {
    it('隔離用のキーへの署名付き URL・PUT に付けるヘッダー・期限を返し、キーはサーバーが組み立てる', async () => {
      const { authorization, id } = await login();
      const before = Date.now();
      const ticket = await issued(authorization, { fileName: '../../avatars/私の 顔.png' });

      expect(ticket.uploadId).toMatch(/^[0-9a-f-]{36}$/);
      expect(ticket.uploadHeaders).toEqual({ 'Content-Type': 'image/png', 'If-None-Match': '*' });
      // 保存名は英数字・.・_・- 以外と先頭の . を _ に置き換えたもの。{uid} は User.id、{UUID} はアップロードの識別子
      expect(keyOf(ticket)).toBe(
        `quarantine/avatars/${id}/${ticket.uploadId}/_._.._avatars_____.png`,
      );
      // 隔離用のキーは `/avatars/*`・`/files/workspace/...` の署名付き Cookie の対象の外にある（配信 URL を持たない。11.1）
      expect(keyOf(ticket).startsWith('avatars/')).toBe(false);
      expect(keyOf(ticket).startsWith('workspace/')).toBe(false);

      const expiresAt = Date.parse(ticket.expiresAt);
      expect(expiresAt - before).toBeGreaterThanOrEqual(300_000 - 1_000);
      expect(expiresAt - Date.now()).toBeLessThanOrEqual(300_000 + 1_000);
    });

    it('署名付き URL の有効期限は 5 分で、If-None-Match: * と Content-Type と大きさを署名に含む', async () => {
      const { authorization } = await login();
      const url = new URL((await issued(authorization)).uploadUrl);

      expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
      expect(url.searchParams.get('X-Amz-SignedHeaders')?.split(';')).toEqual(
        expect.arrayContaining(['content-length', 'content-type', 'host', 'if-none-match']),
      );
      // 空の本体のチェックサムを焼き込まない（焼き込むとブラウザの PUT が断られる）
      expect([...url.searchParams.keys()].some((name) => /checksum/i.test(name))).toBe(false);
    });

    it('本体にキーや URL を足すことはできない（400）', async () => {
      const { authorization, id } = await login();
      for (const extra of [
        { key: `avatars/${id}/x/evil.png` },
        { avatarUrl: 'https://evil.example.com/a.png' },
      ]) {
        const res = await issue(authorization, {
          fileName: 'a.png',
          contentType: 'image/png',
          size: 10,
          ...extra,
        });
        expect(res.status).toBe(400);
      }
      expect(await prisma.avatarUpload.count({ where: { userId: id } })).toBe(0);
    });

    it.each([
      ['SVG', 'image/svg+xml', 'a.svg'],
      ['pdf（画像でない許可リストの形式）', 'application/pdf', 'a.pdf'],
      ['許可リストに無い形式', 'application/x-msdownload', 'a.exe'],
      ['大文字の Content-Type', 'IMAGE/PNG', 'a.png'],
    ])('%s は 422 unsupported_file_type で断り、行を作らない', async (_, contentType, fileName) => {
      const { authorization, id } = await login();
      const res = await issue(authorization, { fileName, contentType, size: 10 });
      expect(res.status).toBe(422);
      expect(((await res.json()) as ErrorResponse).code).toBe('unsupported_file_type');
      expect(await prisma.avatarUpload.count({ where: { userId: id } })).toBe(0);
    });

    it('10 MB を超える申告は 422 file_too_large で断る（10 MB ちょうどは通る）', async () => {
      const { authorization, id } = await login();
      const over = await issue(authorization, {
        fileName: 'a.png',
        contentType: 'image/png',
        size: 10 * MB + 1,
      });
      expect(over.status).toBe(422);
      expect(((await over.json()) as ErrorResponse).code).toBe('file_too_large');
      expect(await prisma.avatarUpload.count({ where: { userId: id } })).toBe(0);

      await issued(authorization, { size: 10 * MB });
    });

    it('アクセストークンが無ければ 401、退会済みの利用者のトークンも 401 で、行を作らない', async () => {
      const body = { fileName: 'a.png', contentType: 'image/png', size: 10 };
      const anonymous = await fetch(`${base}/api/users/me/avatar/uploads`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(anonymous.status).toBe(401);

      const { authorization, id } = await login();
      await prisma.user.update({ where: { id }, data: { deletedAt: new Date() } });
      expect((await issue(authorization, body)).status).toBe(401);
      expect(await prisma.avatarUpload.count({ where: { userId: id } })).toBe(0);
    });

    it('利用者単位で 10 分に 30 回までで、超えたら 429', async () => {
      const { authorization } = await login();
      const other = await login();
      for (let i = 0; i < 30; i += 1) await issued(authorization);
      const res = await issue(authorization, {
        fileName: 'a.png',
        contentType: 'image/png',
        size: 10,
      });
      expect(res.status).toBe(429);
      expect(res.headers.get('retry-after')).toEqual(expect.any(String));
      // 利用者単位で数える（別の利用者は止まらない）
      await issued(other.authorization);
    });
  });

  describe('署名付き URL への PUT', () => {
    it('付けるヘッダーのとおりに PUT でき、同じ URL での2回目は 412 で断られる', async () => {
      const { authorization } = await login();
      const ticket = await issued(authorization);
      expect((await put(ticket, SAMPLES.png)).status).toBe(200);
      // 大きさは署名に含まれるため、2回目も同じ大きさで送る（#611）
      expect((await put(ticket, resized(SAMPLES.jpeg, SAMPLES.png.length))).status).toBe(412);
    });

    it('Content-Type を変えた・If-None-Match を外した PUT は断られる', async () => {
      const { authorization } = await login();
      const ticket = await issued(authorization);
      expect(
        (await put(ticket, SAMPLES.png, { ...ticket.uploadHeaders, 'Content-Type': 'text/html' }))
          .status,
      ).toBe(403);
      // 署名したヘッダーが無い要求を、S3 は 403、MinIO は 400 で断る（どちらも書かない）
      expect([400, 403]).toContain(
        (await put(ticket, SAMPLES.png, { ...ticket.uploadHeaders, 'If-None-Match': undefined }))
          .status,
      );
      expect(await exists(keyOf(ticket))).toBe(false);
    });

    it('払い出した署名付き URL のパスを配信用のキーに書き換えても PUT できない', async () => {
      const { authorization } = await login();
      const ticket = await issued(authorization);
      const url = new URL(ticket.uploadUrl);
      url.pathname = url.pathname.replace('/quarantine/avatars/', '/avatars/');
      expect(url.pathname).toContain(`/${bucket}/avatars/`);

      expect((await put(ticket, SAMPLES.png, ticket.uploadHeaders, url.toString())).status).toBe(
        403,
      );
      expect(await exists(keyOf(ticket).slice('quarantine/'.length))).toBe(false);
    });
  });

  describe('確定', () => {
    it('検証した画像を配信用のキーへ移し、avatarUrl を配信 URL のパスにし、隔離用のキーを削除する', async () => {
      const { authorization, id } = await login();
      const ticket = await issued(authorization, { fileName: 'me.png' });
      await put(ticket, SAMPLES.png);

      const res = await complete(authorization, ticket.uploadId);

      expect(res.status).toBe(200);
      const profile = (await res.json()) as Profile;
      expect(profile.avatarUrl).toBe(`/avatars/${id}/${ticket.uploadId}/me.png`);
      expect(await avatarUrlOf(id)).toBe(profile.avatarUrl);

      const delivered = await admin.send(
        new GetObjectCommand({ Bucket: bucket, Key: `avatars/${id}/${ticket.uploadId}/me.png` }),
      );
      expect(Buffer.from(await delivered.Body!.transformToByteArray())).toEqual(
        Buffer.from(SAMPLES.png),
      );
      expect(delivered.ContentType).toBe('image/png');
      expect(delivered.ContentDisposition).toBe(
        `inline; filename="me.png"; filename*=UTF-8''me.png`,
      );
      expect(await exists(keyOf(ticket))).toBe(false);
    });

    it('配信の Content-Type と保存名の拡張子は、申告ではなく検証した形式から決める', async () => {
      const { authorization, id } = await login();
      const ticket = await issued(authorization, {
        fileName: 'photo.png.php',
        size: SAMPLES.jpeg.length,
      });
      // image/png と申告して JPEG を上げる
      await put(ticket, SAMPLES.jpeg);

      const res = await complete(authorization, ticket.uploadId);

      expect(res.status).toBe(200);
      const key = `avatars/${id}/${ticket.uploadId}/photo.png.jpg`;
      expect(((await res.json()) as Profile).avatarUrl).toBe(`/${key}`);
      const delivered = await admin.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      expect(delivered.ContentType).toBe('image/jpeg');
      expect(delivered.ContentDisposition).toBe(
        `inline; filename="photo.png.jpg"; filename*=UTF-8''photo.png.jpg`,
      );
    });

    it.each([
      ['SVG を png と申告したもの', SAMPLES.svg, 'unsupported_file_type'],
      ['HTML を png と申告したもの', SAMPLES.html, 'unsupported_file_type'],
      ['画像でない形式（pdf）', SAMPLES.pdf, 'unsupported_file_type'],
      ['画像でない形式（mp4）', SAMPLES.mp4, 'unsupported_file_type'],
    ])(
      '%s は 422 で断り、配信用のキーへ移さず、隔離用のキーを削除し、avatarUrl を変えない',
      async (_, bytes, code) => {
        const { authorization, id } = await login();
        const ticket = await issued(authorization, { size: bytes.length });
        expect((await put(ticket, bytes)).status).toBe(200);

        const res = await complete(authorization, ticket.uploadId);

        expect(res.status).toBe(422);
        expect(((await res.json()) as ErrorResponse).code).toBe(code);
        expect(await keysUnder(`avatars/${id}/`)).toEqual([]);
        expect(await exists(keyOf(ticket))).toBe(false);
        expect(await avatarUrlOf(id)).toBeNull();
      },
    );

    it('申告と違う大きさの本体は、署名付き URL の PUT の時点で断られ、隔離用のキーに書かれない（#611）', async () => {
      const { authorization } = await login();
      for (const bytes of [new Uint8Array(SAMPLES.png.length + 1), SAMPLES.png.subarray(1)]) {
        const ticket = await issued(authorization);
        expect((await put(ticket, bytes)).status).toBe(403);
        expect(await exists(keyOf(ticket))).toBe(false);
      }
    });

    it('10 MB を超える本体が隔離用のキーに届いても（署名の前提が崩れた場合）、確定で 422 file_too_large で断り、隔離用のキーを削除する', async () => {
      const { authorization, id } = await login();
      const ticket = await issued(authorization);
      const large = new Uint8Array(10 * MB + 1);
      large.set(SAMPLES.png);
      // 署名付き URL は申告と違う大きさを断るため（#611）、管理の資格情報で直接書いて前提が崩れた場合を作る
      await admin.send(new PutObjectCommand({ Bucket: bucket, Key: keyOf(ticket), Body: large }));

      const res = await complete(authorization, ticket.uploadId);

      expect(res.status).toBe(422);
      expect(((await res.json()) as ErrorResponse).code).toBe('file_too_large');
      expect(await keysUnder(`avatars/${id}/`)).toEqual([]);
      expect(await exists(keyOf(ticket))).toBe(false);
    });

    it('10 MB ちょうどの画像は通る', async () => {
      const { authorization } = await login();
      const ticket = await issued(authorization, { size: 10 * MB });
      const exact = new Uint8Array(10 * MB);
      exact.set(SAMPLES.png);
      expect((await put(ticket, exact)).status).toBe(200);
      expect((await complete(authorization, ticket.uploadId)).status).toBe(200);
    });

    it('本体を PUT していなければ 422 upload_not_received', async () => {
      const { authorization, id } = await login();
      const ticket = await issued(authorization);

      const res = await complete(authorization, ticket.uploadId);

      expect(res.status).toBe(422);
      expect(((await res.json()) as ErrorResponse).code).toBe('upload_not_received');
      expect(await avatarUrlOf(id)).toBeNull();
    });

    it('配信用のキーには検証した版のバイト列だけが載る（検証の後に隔離用のキーを差し替えても載らない）', async () => {
      const { authorization, id } = await login();
      const ticket = await issued(authorization, { fileName: 'pinned.png' });
      await put(ticket, SAMPLES.png);
      const original = apiS3.send.bind(apiS3);
      vi.spyOn(apiS3, 'send').mockImplementation((async (command: object, ...rest: unknown[]) => {
        // 検証の後・コピーの前に、署名付き URL の条件を通らない経路（管理者の資格情報）で中身を差し替える
        if (command instanceof CopyObjectCommand) {
          await admin.send(
            new PutObjectCommand({ Bucket: bucket, Key: keyOf(ticket), Body: SAMPLES.html }),
          );
        }
        return (original as (...args: unknown[]) => unknown)(command, ...rest);
      }) as typeof apiS3.send);

      expect((await complete(authorization, ticket.uploadId)).status).toBe(200);

      const delivered = await admin.send(
        new GetObjectCommand({
          Bucket: bucket,
          Key: `avatars/${id}/${ticket.uploadId}/pinned.png`,
        }),
      );
      expect(Buffer.from(await delivered.Body!.transformToByteArray())).toEqual(
        Buffer.from(SAMPLES.png),
      );
    });

    it('同じ識別子の2回目以降の確定は、コピーも削除もせず、1回目と同じ結果を返す（成功）', async () => {
      const { authorization, id } = await login();
      const ticket = await issued(authorization, { fileName: 'once.png' });
      await put(ticket, SAMPLES.png);
      expect((await complete(authorization, ticket.uploadId)).status).toBe(200);
      // 確定で隔離用のキーを削除した後は、期限内に同じ URL でもう1回だけ書ける（現行の版がデリートマーカーのため。11.1）
      expect((await put(ticket, resized(SAMPLES.gif, SAMPLES.png.length))).status).toBe(200);
      const sent = recordS3Commands();

      const again = await complete(authorization, ticket.uploadId);

      expect(again.status).toBe(200);
      expect(((await again.json()) as Profile).avatarUrl).toBe(
        `/avatars/${id}/${ticket.uploadId}/once.png`,
      );
      expect(sent).toEqual([]);
      // 後から書いたバイト列は配信用のキーに届かない
      const delivered = await admin.send(
        new GetObjectCommand({ Bucket: bucket, Key: `avatars/${id}/${ticket.uploadId}/once.png` }),
      );
      expect(Buffer.from(await delivered.Body!.transformToByteArray())).toEqual(
        Buffer.from(SAMPLES.png),
      );
    });

    it('同じ識別子の2回目以降の確定は、コピーも削除もせず、1回目と同じ結果を返す（拒否。正しい画像を上げ直しても通らない）', async () => {
      const { authorization, id } = await login();
      const ticket = await issued(authorization, { size: SAMPLES.svg.length });
      await put(ticket, SAMPLES.svg);
      expect((await complete(authorization, ticket.uploadId)).status).toBe(422);
      expect((await put(ticket, resized(SAMPLES.png, SAMPLES.svg.length))).status).toBe(200);
      const sent = recordS3Commands();

      const again = await complete(authorization, ticket.uploadId);

      expect(again.status).toBe(422);
      expect(((await again.json()) as ErrorResponse).code).toBe('unsupported_file_type');
      expect(sent).toEqual([]);
      expect(await avatarUrlOf(id)).toBeNull();
    });

    it('他の利用者に払い出された識別子・無い識別子では 404 で、払い出された本人の確定の権利を使わない', async () => {
      const owner = await login();
      const other = await login();
      const ticket = await issued(owner.authorization);
      await put(ticket, SAMPLES.png);
      const sent = recordS3Commands();

      for (const uploadId of [ticket.uploadId, randomUUID()]) {
        const res = await complete(other.authorization, uploadId);
        expect(res.status).toBe(404);
        expect((await res.json()) as ErrorResponse).toEqual({
          code: 'not_found',
          message: '見つかりません',
        });
      }
      expect(sent).toEqual([]);
      expect(await avatarUrlOf(other.id)).toBeNull();
      vi.restoreAllMocks();

      // 本人はまだ確定できる
      expect((await complete(owner.authorization, ticket.uploadId)).status).toBe(200);
      expect(await avatarUrlOf(owner.id)).toBe(
        `/avatars/${owner.id}/${ticket.uploadId}/avatar.png`,
      );
    });

    it('識別子の形が uuid でなければ 400', async () => {
      const { authorization } = await login();
      expect((await complete(authorization, 'not-a-uuid')).status).toBe(400);
    });

    it('確定の途中に同じ識別子の確定を求めると 409 upload_in_progress で、1回目はそのまま完了する', async () => {
      const { authorization, id } = await login();
      const ticket = await issued(authorization);
      await put(ticket, SAMPLES.png);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let reachedS3!: () => void;
      const reached = new Promise<void>((resolve) => {
        reachedS3 = resolve;
      });
      const original = apiS3.send.bind(apiS3);
      vi.spyOn(apiS3, 'send').mockImplementation((async (command: object, ...rest: unknown[]) => {
        reachedS3();
        await gate;
        return (original as (...args: unknown[]) => unknown)(command, ...rest);
      }) as typeof apiS3.send);

      const first = complete(authorization, ticket.uploadId);
      await reached;
      const second = await complete(authorization, ticket.uploadId);
      expect(second.status).toBe(409);
      expect(((await second.json()) as ErrorResponse).code).toBe('upload_in_progress');
      release();

      expect((await first).status).toBe(200);
      expect(await avatarUrlOf(id)).toBe(`/avatars/${id}/${ticket.uploadId}/avatar.png`);
    });

    it('プロフィールの編集で avatarUrl を送ることはできない（利用者が渡した URL を入れない）', async () => {
      const { authorization, id } = await login();
      const res = await fetch(`${base}/api/users/me`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', authorization },
        body: JSON.stringify({ avatarUrl: 'https://evil.example.com/a.png' }),
      });
      expect(res.status).toBe(400);
      expect(await avatarUrlOf(id)).toBeNull();
    });

    it('差し替えると avatarUrl は新しい配信 URL のパスになる（古い配信用のオブジェクトは残る）', async () => {
      const { authorization, id } = await login();
      const first = await issued(authorization, { fileName: 'first.png' });
      await put(first, SAMPLES.png);
      await complete(authorization, first.uploadId);
      const second = await issued(authorization, {
        fileName: 'second.gif',
        contentType: 'image/gif',
        size: SAMPLES.gif.length,
      });
      await put(second, SAMPLES.gif);

      const res = await complete(authorization, second.uploadId);

      expect(((await res.json()) as Profile).avatarUrl).toBe(
        `/avatars/${id}/${second.uploadId}/second.gif`,
      );
      expect((await keysUnder(`avatars/${id}/`)).sort()).toEqual(
        [
          `avatars/${id}/${first.uploadId}/first.png`,
          `avatars/${id}/${second.uploadId}/second.gif`,
        ].sort(),
      );
    });

    it('利用者単位で 10 分に 30 回までで、超えたら 429（断られた確定も数える）', async () => {
      const { authorization } = await login();
      for (let i = 0; i < 30; i += 1) {
        expect((await complete(authorization, randomUUID())).status).toBe(404);
      }
      expect((await complete(authorization, randomUUID())).status).toBe(429);
    });
  });

  it('検証に通らなかったときは、コピーを送らずに隔離用のキーの削除を送る', async () => {
    const { authorization } = await login();
    const ticket = await issued(authorization);
    await put(ticket, SAMPLES.svg);
    const sent = recordS3Commands();

    expect((await complete(authorization, ticket.uploadId)).status).toBe(422);
    expect(sent).toContain(DeleteObjectCommand.name);
    expect(sent).not.toContain(CopyObjectCommand.name);
  });
});
