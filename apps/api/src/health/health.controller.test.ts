import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REALTIME_EVENT_KINDS } from '@workspace-chat/shared';
import { AppModule } from '../app.module';
import { HealthController } from './health.controller';

describe('ヘルスチェック', () => {
  let app: INestApplication;

  beforeAll(async () => {
    // 型が通っても DI の結線が誤っていれば、ここで落ちる。
    // 「ビルドは通るが起動しない」を検出するのがこのテストの目的である。
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('AppModule が起動し、HealthController が解決できる', () => {
    expect(app.get(HealthController)).toBeInstanceOf(HealthController);
  });

  it('status: ok と、共有パッケージから読んだ種類数を返す', () => {
    expect(app.get(HealthController).check()).toEqual({
      status: 'ok',
      realtimeEventKinds: REALTIME_EVENT_KINDS.length,
    });
  });
});
