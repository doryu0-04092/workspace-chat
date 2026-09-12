import 'reflect-metadata';
import { UnauthorizedException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { ProfileService } from './profile.service';

const USER_ID = '0190c1a2-0000-7000-8000-000000000001';

/** 退会済み（退会していない行が見つからない）の利用者を返す DB に差し替えた ProfileService。 */
function createServiceForDeletedUser() {
  const prisma = {
    user: {
      updateMany: vi.fn(async () => ({ count: 0 })),
      findFirst: vi.fn(async () => null),
    },
  };
  return { service: new ProfileService(prisma as never), prisma };
}

/** 入口（AccessTokenGuard）の 401 と同じ本体であること。退会済みを応答から区別させない（機能一覧 1.4）。 */
async function expectInvalidToken(result: Promise<unknown>): Promise<void> {
  await expect(result).rejects.toBeInstanceOf(UnauthorizedException);
  await expect(result).rejects.toMatchObject({
    response: { code: 'invalid_token', message: 'ログインし直してください' },
  });
}

// 入口の判定とは別に、問い合わせ側にも要求する側の deletedAt IS NULL を置く（機能一覧 1.4 の1段目）。
// 入口で確かめた後、読み書きするまでの間に退会した場合に当たる。
describe('ProfileService', () => {
  // 列は2つ（statusEmoji / statusText）だが、値は1セット（機能一覧 1.3。#283）。片方だけの行は DB を直接触らないと
  // できないが、その行を「ステータスあり」として返さない。
  it('片方の列だけが入っている行は、ステータス無し（null）として返す', async () => {
    const prisma = {
      user: {
        findFirst: vi.fn(async () => ({
          id: USER_ID,
          loginId: 'someone',
          displayName: '名前',
          avatarUrl: null,
          statusEmoji: '🍵',
          statusText: null,
        })),
      },
    };
    const service = new ProfileService(prisma as never);
    expect((await service.get(USER_ID)).status).toBeNull();
  });

  it('取得は退会済みの行を引かず、見つからなければ入口と同じ 401', async () => {
    const { service, prisma } = createServiceForDeletedUser();

    await expectInvalidToken(service.get(USER_ID));
    expect(prisma.user.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ deletedAt: null }) }),
    );
  });

  it('書き込みは退会済みの行に当てず、続く取得が入口と同じ 401 を返す', async () => {
    const { service, prisma } = createServiceForDeletedUser();

    await expectInvalidToken(service.update(USER_ID, { displayName: '変える' }));
    expect(prisma.user.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ deletedAt: null }) }),
    );
  });
});
