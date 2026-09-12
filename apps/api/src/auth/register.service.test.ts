import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { uniqueViolation } from '../testing/prisma-violations';
import { RegisterService } from './register.service';

// 規則は testing/prisma-violations.ts。
describe('RegisterService.register（一意制約違反。#355）', () => {
  it('利用者の作成で一意制約違反（P2002）を捕まえたら 409（user_id_taken）', async () => {
    const prisma = { user: { create: vi.fn(async () => Promise.reject(uniqueViolation())) } };
    const service = new RegisterService(prisma as never);

    await expect(
      service.register({ userId: 'taken', displayName: '重複', password: 'password-123' }),
    ).rejects.toMatchObject({
      status: 409,
      response: { code: 'user_id_taken', message: 'このユーザーID は使えません' },
    });
  });
});
