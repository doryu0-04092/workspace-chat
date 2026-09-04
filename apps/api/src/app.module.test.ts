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
    // **注意: この環境では、コンストラクタインジェクションの誤りは検出できない。**
    // Vitest は esbuild で変換しており、esbuild は emitDecoratorMetadata を
    // 出力しない。依存を持つクラスを足すと、Nest は解決に失敗せず
    // undefined を注入し、使う瞬間に別の場所で落ちる。#14 で扱う。
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
