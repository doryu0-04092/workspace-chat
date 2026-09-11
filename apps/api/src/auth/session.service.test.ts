import 'reflect-metadata';
import { UnauthorizedException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { SessionService } from './session.service';

/**
 * 同時の入れ替えの競合を、DB の応答を差し替えて決まった形で起こす。
 * 実際の DB に同時に送る検査（refresh-logout.test.ts）は、要求が順に処理されると競合の経路を踏まない。
 */
function createService(updatedCount: number) {
  const row = {
    id: 'row-1',
    userId: 'user-1',
    familyId: 'family-1',
    revokedAt: null,
    expiresAt: new Date(Date.now() + 60_000),
    user: { deletedAt: null },
  };
  const tx = {
    refreshToken: {
      updateMany: vi.fn(async () => ({ count: updatedCount })),
      create: vi.fn(async () => undefined),
    },
  };
  const prisma = {
    refreshToken: {
      findUnique: vi.fn(async () => row),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  const jwt = { signAsync: vi.fn(async () => 'access-token') };
  return { service: new SessionService(prisma as never, jwt as never), prisma, tx, row };
}

describe('SessionService.rotate（同時の入れ替え）', () => {
  it('使ったトークンの失効は、まだ失効していない行だけに当て、同じ系列の新しいトークンを作る', async () => {
    const { service, tx, row } = createService(1);
    await service.rotate('token');

    expect(tx.refreshToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: row.id, revokedAt: null } }),
    );
    expect(tx.refreshToken.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ familyId: row.familyId }) }),
    );
  });

  // 先に入れ替えた要求が行を失効させた後の側は、失効させる行が 0 件になる。再利用として系列ごと失効させる。
  it('失効させる行が 0 件なら、新しいトークンを作らず、系列ごと失効させて 401', async () => {
    const { service, prisma, tx, row } = createService(0);

    await expect(service.rotate('token')).rejects.toBeInstanceOf(UnauthorizedException);
    expect(tx.refreshToken.create).not.toHaveBeenCalled();
    expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { familyId: row.familyId, revokedAt: null } }),
    );
  });
});
