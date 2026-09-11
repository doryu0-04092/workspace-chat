import 'reflect-metadata';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import type { paths } from '@workspace-chat/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from './app-setup';
import { stubApiEnv } from './testing/api-env';

// 型は仕様の各パスの応答から引く。仕様に 405 / 415 を載せ忘れると、型検査で落ちる。
type RegisterResponses = paths['/auth/register']['post']['responses'];
type ErrorResponse = RegisterResponses[405 | 415]['content']['application/json'];
type HealthErrorResponse = paths['/health']['get']['responses'][405]['content']['application/json'];

// 要求を REST の仕様（openapi.yaml）どおりか確かめる経路（要件定義書 4.7）。
// 入力の形の個々の規則は、それを使うエンドポイントのテスト（auth/register.test.ts）が見る。
// ここで見るのは、仕様に無い要求がハンドラへ届かず、ErrorResponse の形で返ること。
describe('REST の仕様による要求の検証', () => {
  let app: INestApplication;
  let base: string;

  beforeAll(async () => {
    // ここで叩く要求はどれもハンドラに届かないため、繋がらない宛先でよい。
    stubApiEnv();
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

  // 前置き /api の外は、仕様の検証の対象外（servers の外）であり、Nest の既定の 404 が返る。
  // その本体も ErrorResponse に揃える（横断的な例外処理で揃える。機能一覧 1.4）。
  it('前置き /api の外のパスも 404（not_found）の ErrorResponse', async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(404);
    expect(((await res.json()) as ErrorResponse).code).toBe('not_found');
  });

  it('死活確認に仕様に無いメソッドで送ると 405（method_not_allowed）', async () => {
    const res = await fetch(`${base}/api/health`, { method: 'POST' });
    expect(res.status).toBe(405);
    expect(((await res.json()) as HealthErrorResponse).code).toBe('method_not_allowed');
  });

  it('仕様にある要求は通る（死活確認）', async () => {
    const res = await fetch(`${base}/api/health`);
    expect(res.status).toBe(200);
  });
});
