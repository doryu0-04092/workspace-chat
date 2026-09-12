import type { ExecutionContext } from '@nestjs/common';
import { ForbiddenException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { ApiConfig } from '../config/api-config';
import { CsrfGuard } from './csrf.guard';

const WEB = 'https://chat.example.com';

function contextWith(headers: Record<string, string>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ headers }) }),
  } as unknown as ExecutionContext;
}

// 独自のヘッダーは仕様（openapi-validation.ts）が先に 400 で止めるが、仕様から宣言が外れてもガードが止めることを確かめる。
describe('CsrfGuard', () => {
  const guard = new CsrfGuard({ webOrigin: WEB } as ApiConfig);

  it('独自のヘッダーがあり、同じ origin からなら通す', () => {
    expect(
      guard.canActivate(
        contextWith({ 'x-requested-by': 'workspace-chat', 'sec-fetch-site': 'same-origin' }),
      ),
    ).toBe(true);
  });

  it.each([
    ['独自のヘッダーが無い', { 'sec-fetch-site': 'same-origin' }],
    ['独自のヘッダーの値が違う', { 'x-requested-by': 'other', 'sec-fetch-site': 'same-origin' }],
    [
      '同じ origin からでない',
      { 'x-requested-by': 'workspace-chat', origin: 'https://evil.example.com' },
    ],
  ])('%s なら 403（csrf_rejected）', (_label, headers) => {
    try {
      guard.canActivate(contextWith(headers));
      expect.unreachable('通してしまった');
    } catch (error) {
      expect(error).toBeInstanceOf(ForbiddenException);
      expect((error as ForbiddenException).getResponse()).toMatchObject({ code: 'csrf_rejected' });
    }
  });
});
