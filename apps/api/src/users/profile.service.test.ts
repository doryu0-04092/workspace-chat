import 'reflect-metadata';
import { UnauthorizedException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { ProfileService } from './profile.service';

/** DB の応答を差し替えた ProfileService。`updatedCount` は書き込みが当たった行の数。 */
function createService(updatedCount: number) {
  const prisma = {
    user: {
      updateMany: vi.fn(async () => ({ count: updatedCount })),
      findFirst: vi.fn(async () => null),
    },
  };
  return { service: new ProfileService(prisma as never), prisma };
}

describe('ProfileService', () => {
  // 入口の判定とは別に、問い合わせ側にも要求する側の deletedAt IS NULL を置く（機能一覧 1.4 の1段目）。
  it('取得も退会済みの行を引かず、見つからなければ invalid_token の 401', async () => {
    const { service, prisma } = createService(1);

    const result = service.get('0190c1a2-0000-7000-8000-000000000001');
    await expect(result).rejects.toMatchObject({ response: { code: 'invalid_token' } });
    expect(prisma.user.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ deletedAt: null }) }),
    );
  });

  // 入口（AccessTokenGuard）で確かめた後、書き込むまでの間に退会した場合。
  it('書き込みが当たる行が無ければ（退会済み）、invalid_token の 401', async () => {
    const { service, prisma } = createService(0);

    const result = service.update('0190c1a2-0000-7000-8000-000000000001', {
      displayName: '変える',
    });
    await expect(result).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(result).rejects.toMatchObject({ response: { code: 'invalid_token' } });
    expect(prisma.user.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ deletedAt: null }) }),
    );
  });
});
