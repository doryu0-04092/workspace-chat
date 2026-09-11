import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from './app-setup';
import { stubApiEnv } from './testing/api-env';
import { API_SETTINGS } from './config/api-config';

// 起動を止める設定の検証は、アプリを組み立てる前に済ませる（bootstrap.ts の PORT と同じ。PR #254 第1巡・#256）。
// 組み立ての後に置くと、Prisma と Valkey への接続を一通り試してから落ちる。
describe('createApp の設定の検証', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  /** 設定ごとの不正な値。**API_SETTINGS のすべての設定を1つずつ持つ**（下の検査が足し漏れを止める）。 */
  const INVALID: ReadonlyArray<readonly [string, string | undefined]> = [
    ['DATABASE_URL', undefined],
    ['REDIS_URL', ''],
    ['TRUST_PROXY_HOPS', undefined],
    ['API_TASK_COUNT', '0'],
    ['REGISTRATION_ENABLED', 'FALSE'],
    ['JWT_SECRET', 'short'],
    ['WEB_ORIGIN', 'https://chat.example.com/'],
  ];

  it('不正な値の表は、起動の設定のすべてを持つ', () => {
    expect(INVALID.map(([name]) => name).sort()).toEqual(
      Object.values(API_SETTINGS)
        .map((setting) => setting.env)
        .sort(),
    );
  });

  it.each(INVALID)('%s が %j なら、アプリを組み立てる前に落ちる', async (name, raw) => {
    stubApiEnv({ [name]: raw });
    // 組み立てを本当に走らせると、Nest は失敗時にプロセスを終わらせる（テストの実行ごと落ちて原因が読めない）。
    // 呼ばれたら分かる失敗に差し替える。
    const create = vi
      .spyOn(NestFactory, 'create')
      .mockRejectedValue(new Error('アプリを組み立ててしまった'));

    await expect(createApp({ logger: false })).rejects.toThrow(new RegExp(name));
    expect(create).not.toHaveBeenCalled();
  });
});
