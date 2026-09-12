import 'reflect-metadata';
import { UnauthorizedException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { LoginBackoffStore } from './login-backoff';
import { RecoveryService } from './recovery.service';
import { verifySecret } from './secret-hash';

vi.mock('./secret-hash', () => ({
  dummySecretHash: vi.fn(async () => 'dummy-argon2id-hash'),
  hashSecret: vi.fn(async () => 'new-hash'),
  verifySecret: vi.fn(async () => true),
}));

function backoff(): LoginBackoffStore {
  return {
    begin: vi.fn(async () => ({ allowed: true as const })),
    recordFailure: vi.fn(async () => undefined),
    reset: vi.fn(async () => undefined),
  };
}

/** DB の応答を差し替えた RecoveryService。`rows` は利用者と未使用のコードの行、`updatedCount` はコードの無効化の件数。 */
function createService(rows: unknown[], updatedCount = 1) {
  const tx = {
    recoveryCode: {
      updateMany: vi.fn(async () => ({ count: updatedCount })),
      create: vi.fn(async () => undefined),
    },
    user: { update: vi.fn(async () => undefined) },
    refreshToken: { updateMany: vi.fn(async () => ({ count: 0 })) },
  };
  const prisma = {
    $queryRaw: vi.fn(async () => rows),
    $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  const store = backoff();
  return { service: new RecoveryService(prisma as never, store), tx, store };
}

const INPUT = {
  userId: 'Some_User',
  recoveryCode: 'abcd-efgh-jkmn-pqrs',
  newPassword: 'new-password',
};

describe('RecoveryService', () => {
  // 見つからないときに照合を飛ばすと、応答までの時間で登録済みの ID を見分けられる。
  it('利用者が見つからなくても、捨てるためのハッシュで照合を1回行い、失敗として数える', async () => {
    vi.mocked(verifySecret).mockClear();
    const { service, store } = createService([]);

    await expect(service.recover(INPUT)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(verifySecret).toHaveBeenCalledExactlyOnceWith('dummy-argon2id-hash', 'ABCDEFGHJKMNPQRS');
    expect(store.recordFailure).toHaveBeenCalledWith('recovery:some_user', expect.any(Number));
    // 照合に失敗した経路では、ログイン側（login:）のキーを数え直さない。数え直すのは成功したときだけ（#280・#298）。
    expect(store.reset).not.toHaveBeenCalled();
  });

  // 同時の再設定の後の側・退会の処理と重なった場合は、無効化する行が 0 件になる。
  it('コードの無効化が 0 件なら、パスワードも新しいコードもリフレッシュトークンも変えずに 401', async () => {
    const { service, tx, store } = createService(
      [{ id: 'user-1', codeId: 'code-1', codeHash: 'hash' }],
      0,
    );

    await expect(service.recover(INPUT)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(tx.recoveryCode.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'code-1', usedAt: null } }),
    );
    expect(tx.user.update).not.toHaveBeenCalled();
    expect(tx.recoveryCode.create).not.toHaveBeenCalled();
    expect(tx.refreshToken.updateMany).not.toHaveBeenCalled();
    // パスワードを入れ替えていないので、再設定・ログインのどちらの回数も数え直さない。
    expect(store.reset).not.toHaveBeenCalled();
  });

  it('成功したら、再設定のキーとログインのキーの両方を数え直す', async () => {
    const { service, store } = createService([
      { id: 'user-1', codeId: 'code-1', codeHash: 'hash' },
    ]);

    await service.recover(INPUT);
    expect(store.reset).toHaveBeenCalledWith('recovery:some_user');
    expect(store.reset).toHaveBeenCalledWith('login:some_user');
  });
});
