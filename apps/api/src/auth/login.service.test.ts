import 'reflect-metadata';
import { UnauthorizedException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { LoginBackoffStore } from './login-backoff';
import { LoginService } from './login.service';
import { verifySecret } from './secret-hash';

vi.mock('./secret-hash', () => ({
  dummySecretHash: vi.fn(async () => 'dummy-argon2id-hash'),
  verifySecret: vi.fn(async () => false),
}));

// 利用者が見つからないときに照合を飛ばすと、応答までの時間（Argon2id の数十 ms の有無）で登録済みの ID を見分けられる。
// 時間そのものは揺らぐため、照合を同じ関数（同じパラメータ）で1回行うことで確かめる。
describe('LoginService（利用者が見つからないとき）', () => {
  function createService(): { service: LoginService; backoff: LoginBackoffStore } {
    const prisma = { $queryRaw: vi.fn(async () => []), refreshToken: { create: vi.fn() } };
    const backoff: LoginBackoffStore = {
      begin: vi.fn(async () => ({ allowed: true as const })),
      recordFailure: vi.fn(async () => undefined),
      reset: vi.fn(async () => undefined),
    };
    return { service: new LoginService(prisma as never, {} as never, backoff), backoff };
  }

  it('捨てるためのハッシュ（dummySecretHash）で照合を1回行い、失敗として数える', async () => {
    const { service, backoff } = createService();

    await expect(service.login({ userId: 'Nobody_Here', password: 'pw-1' })).rejects.toBeInstanceOf(
      UnauthorizedException,
    );

    expect(verifySecret).toHaveBeenCalledExactlyOnceWith('dummy-argon2id-hash', 'pw-1');
    expect(backoff.recordFailure).toHaveBeenCalledWith('nobody_here', expect.any(Number));
  });
});
