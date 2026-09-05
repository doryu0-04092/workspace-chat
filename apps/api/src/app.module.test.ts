import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REALTIME_EVENT_KINDS } from '@workspace-chat/shared';
import { AppModule } from './app.module';

describe('AppModule', () => {
  let app: INestApplication;

  beforeAll(async () => {
    // モジュールの組み立てと初期化が通ることを見る。
    //
    // コンストラクタインジェクションが成立することは、変換の設定に対する
    // 検査として dependency-injection.test.ts が持つ（#14）。
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
  // api 側から実際に読めることだけを確かめる。参照が切れれば import の解決で落ちる。
  //
  // 件数（7）は期待値にしない。それは shared 側のテストが持っており、
  // ここで重ねると、イベントが正当に増減したときに目的の違うこのテストが
  // 道連れで落ちる。落ちた側を読んでも原因を取り違える。
  it('共有パッケージを読める', () => {
    expect(REALTIME_EVENT_KINDS.length).toBeGreaterThan(0);
  });
});
