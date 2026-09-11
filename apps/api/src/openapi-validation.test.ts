import 'reflect-metadata';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import type { components } from '@workspace-chat/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from './app-setup';

type ErrorResponse = components['schemas']['ErrorResponse'];

// 要求を REST の仕様（openapi.yaml）どおりか確かめる経路（要件定義書 4.7）。
// 入力の形の個々の規則は、それを使うエンドポイントのテスト（auth/register.test.ts）が見る。
// ここで見るのは、仕様に無い要求がハンドラへ届かず、ErrorResponse の形で返ること。
describe('REST の仕様による要求の検証', () => {
  let app: INestApplication;
  let base: string;

  beforeAll(async () => {
    // ここで叩く要求はどれもハンドラに届かないため、繋がらない宛先でよい。
    vi.stubEnv('DATABASE_URL', 'postgresql://unused:unused@127.0.0.1:9/unused');
    app = await createApp({ logger: false });
    await app.listen(0, '127.0.0.1');
    const { port } = app.getHttpServer().address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await app?.close();
    vi.unstubAllEnvs();
  });

  // 仕様に載せないままエンドポイントを足しても、公開されない。
  // Nest の既定の 404 は `code` を持たないため、`code` で検証の経路を通ったことを見分ける。
  it('仕様に無いパスは 404（not_found）', async () => {
    const res = await fetch(`${base}/api/undocumented`);
    expect(res.status).toBe(404);
    expect(((await res.json()) as ErrorResponse).code).toBe('not_found');
  });

  it('仕様に無いメソッドは 405（method_not_allowed）', async () => {
    const res = await fetch(`${base}/api/auth/register`);
    expect(res.status).toBe(405);
    expect(((await res.json()) as ErrorResponse).code).toBe('method_not_allowed');
  });

  it('仕様に無いメディア型の本体は 415（unsupported_media_type）', async () => {
    const res = await fetch(`${base}/api/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'userId=someone',
    });
    expect(res.status).toBe(415);
    expect(((await res.json()) as ErrorResponse).code).toBe('unsupported_media_type');
  });

  it('仕様にある要求は通る（死活確認）', async () => {
    const res = await fetch(`${base}/api/health`);
    expect(res.status).toBe(200);
  });
});
