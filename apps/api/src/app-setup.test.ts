import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from './app-setup';

// 起動を止める設定の検証は、アプリを組み立てる前に済ませる（main.ts の PORT と同じ。PR #254 第1巡・#256）。
// 組み立ての後に置くと、Prisma と Valkey への接続を一通り試してから落ちる。
describe('createApp の設定の検証', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it.each([
    ['DATABASE_URL', undefined],
    ['REDIS_URL', ''],
    ['TRUST_PROXY_HOPS', undefined],
    ['API_TASK_COUNT', '0'],
    ['REGISTRATION_ENABLED', 'FALSE'],
  ])('%s が %j なら、アプリを組み立てる前に落ちる', async (name, raw) => {
    vi.stubEnv('DATABASE_URL', 'postgresql://unused:unused@127.0.0.1:9/unused');
    vi.stubEnv('REDIS_URL', 'redis://127.0.0.1:9');
    vi.stubEnv('TRUST_PROXY_HOPS', '0');
    vi.stubEnv('API_TASK_COUNT', undefined);
    vi.stubEnv('REGISTRATION_ENABLED', undefined);
    vi.stubEnv(name, raw);
    // 組み立てを本当に走らせると、Nest は失敗時にプロセスを終わらせる（テストの実行ごと落ちて原因が読めない）。
    // 呼ばれたら分かる失敗に差し替える。
    const create = vi
      .spyOn(NestFactory, 'create')
      .mockRejectedValue(new Error('アプリを組み立ててしまった'));

    await expect(createApp({ logger: false })).rejects.toThrow(new RegExp(name));
    expect(create).not.toHaveBeenCalled();
  });
});
