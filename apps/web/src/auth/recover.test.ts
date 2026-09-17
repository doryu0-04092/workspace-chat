import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeFetch, json } from '../testing/fake-api';
import { recover } from './recover';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('パスワードの再設定の送り方（recover）', () => {
  it('200 でも本体が JSON の null なら、投げずに失敗を返す', async () => {
    fakeFetch({ 'POST /api/auth/recovery': () => json(200, null) });

    const result = await recover({
      userId: 'alice',
      recoveryCode: '0123-4567-89AB-CDEF',
      newPassword: 'password-2',
    });

    expect(result).toEqual({ ok: false, status: 200 });
  });
});
