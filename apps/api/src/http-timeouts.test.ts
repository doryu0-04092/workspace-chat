import 'reflect-metadata';
import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from './app-setup';
import { HTTP_HEADERS_TIMEOUT_MS, HTTP_KEEP_ALIVE_TIMEOUT_MS } from './http-timeouts';
import { stubApiEnv } from './testing/api-env';

// ALB の手前で api が先に keep-alive の接続を閉じると、ALB がその接続に送った要求は 502 になる（#703）。
// 本番の起動（main.ts）と同じ createApp で組み立て、待ち受けを始めた後の HTTP サーバーの値を見る。
describe('HTTP サーバーの keep-alive（#703）', () => {
  let app: INestApplication;
  let server: Server;

  beforeAll(async () => {
    stubApiEnv();
    app = await createApp({ logger: false });
    await app.listen(0, '127.0.0.1');
    server = app.getHttpServer() as Server;
  });

  afterAll(async () => {
    await app?.close();
    vi.unstubAllEnvs();
  });

  it('keep-alive の待ち時間は HTTP_KEEP_ALIVE_TIMEOUT_MS である（Node の既定の 5 秒ではない）', () => {
    expect(server.keepAliveTimeout).toBe(HTTP_KEEP_ALIVE_TIMEOUT_MS);
  });

  it('ヘッダーの待ち時間は keep-alive の待ち時間より長い', () => {
    expect(server.headersTimeout).toBe(HTTP_HEADERS_TIMEOUT_MS);
    expect(HTTP_HEADERS_TIMEOUT_MS).toBeGreaterThan(HTTP_KEEP_ALIVE_TIMEOUT_MS);
  });
});
