import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REALTIME_EVENT_KINDS } from '@workspace-chat/shared';
import { AppModule } from './app.module';

describe('AppModule', () => {
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

  it('起動する', () => {
    expect(app).toBeDefined();
  });

  // 共有パッケージは CommonJS で出している（tech-stack.md）。
  // api 側から実際に読めることを確かめる。読めなければここで落ちる。
  it('共有パッケージを読める', () => {
    expect(REALTIME_EVENT_KINDS).toHaveLength(7);
  });
});
