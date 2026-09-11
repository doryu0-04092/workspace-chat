import 'reflect-metadata';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from './app-setup';
import { HealthController } from './health.controller';

// 死活確認（F-39。機能一覧 14.1）。ALB のヘルスチェックが叩く経路である。
//
// 本番の起動（main.ts）と同じ createApp で組み立て、実際に HTTP で叩く。
// main.ts は読み込むと起動処理が走るため、テストからは呼べない。
describe('GET /api/health（F-39）', () => {
  let app: INestApplication;
  let base: string;

  beforeAll(async () => {
    // アプリの組み立てには接続先が要る（prisma.service.ts）。**繋がらない宛先を渡す**——
    // 死活確認が DB に問い合わせれば、ここで失敗する。
    vi.stubEnv('DATABASE_URL', 'postgresql://unused:unused@127.0.0.1:9/unused');
    vi.stubEnv('REDIS_URL', 'redis://127.0.0.1:9');
    vi.stubEnv('TRUST_PROXY_HOPS', '0');
    app = await createApp({ logger: false });
    await app.listen(0, '127.0.0.1');
    const { port } = app.getHttpServer().address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await app?.close();
    vi.unstubAllEnvs();
  });

  it('認証情報（Authorization ヘッダー・Cookie）が無くても 200 を返す', async () => {
    const res = await fetch(`${base}/api/health`);
    expect(res.status).toBe(200);
  });

  it('応答は稼働していることだけであり、秘密を含まない', async () => {
    const res = await fetch(`${base}/api/health`);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  // 全ルートの前置きは /api（#77）。CloudFront は /api/* だけを ALB へ振り分けるため、
  // 前置きが外れると ALB に届かない。createApp から前置きを外すとここが落ちる。
  it('前置きの無いパスでは届かない', async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(404);
  });

  // 浅い死活確認（14.1 の代償）: DB・Redis 等に問い合わせない。
  // 依存を注入した時点で問い合わせの経路ができるため、依存を持たないことを見る。
  it('DB・Redis 等への依存を注入しない', () => {
    const deps: unknown[] = Reflect.getMetadata('design:paramtypes', HealthController) ?? [];
    expect(deps).toHaveLength(0);
  });
});
