import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from './app-setup';

// 起動を止める設定の検証は、アプリを組み立てる前に済ませる（bootstrap.ts の PORT と同じ。PR #254 第1巡）。
// 組み立ての後に置くと、Prisma と Valkey への接続を一通り試してから落ちる。
describe('createApp の設定の検証', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('TRUST_PROXY_HOPS が未設定なら、アプリを組み立てる前に落ちる', async () => {
    vi.stubEnv('TRUST_PROXY_HOPS', undefined);
    // 組み立てを本当に走らせると、Nest は失敗時にプロセスを終わらせる（テストの実行ごと落ちて原因が読めない）。
    // 呼ばれたら分かる失敗に差し替える。
    const create = vi
      .spyOn(NestFactory, 'create')
      .mockRejectedValue(new Error('アプリを組み立ててしまった'));

    await expect(createApp({ logger: false })).rejects.toThrow(/TRUST_PROXY_HOPS/);
    expect(create).not.toHaveBeenCalled();
  });
});
