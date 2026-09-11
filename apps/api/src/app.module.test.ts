import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { REALTIME_EVENT_KINDS } from '@workspace-chat/shared';
import { AppModule } from './app.module';
import { API_SETTINGS } from './config/api-config';

describe('AppModule', () => {
  let app: INestApplication;

  beforeAll(async () => {
    // モジュールの組み立てと初期化が通ることを見る。
    //
    // コンストラクタインジェクションが成立することは、変換の設定に対する
    // 検査として dependency-injection.test.ts が持つ（#14）。
    //
    // **組み立ては、渡された設定だけを使い、環境変数を読まない**（#256。検証は createApp が組み立ての前に済ませる）。
    // 環境変数を不正な値にしておき、どこかのモジュールが読めばここで落ちるようにする。
    for (const name of Object.values(API_SETTINGS).map((setting) => setting.env)) {
      vi.stubEnv(name, '');
    }
    // 接続は最初の問い合わせまで張られないため、繋がらない宛先でよい。
    const moduleRef = await Test.createTestingModule({
      imports: [
        AppModule.forRoot({
          databaseUrl: 'postgresql://unused:unused@127.0.0.1:9/unused',
          redisUrl: 'redis://127.0.0.1:9',
          trustProxyHops: 0,
          apiTaskCount: 1,
          registrationEnabled: true,
          jwtSecret: randomBytes(32).toString('base64url'),
        }),
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    vi.unstubAllEnvs();
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
