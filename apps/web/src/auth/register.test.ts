import type { components } from '@workspace-chat/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeFetch } from '../testing/fake-api';
import { register } from './register';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('新規登録の送り方（register）', () => {
  it('本体を JSON にできなければ、要求を送らずに失敗を返す（投げない。通信の失敗〔status 0〕にもしない）', async () => {
    const { calls } = fakeFetch({});
    const circular: Record<string, unknown> = { userId: 'alice', password: 'password-1' };
    circular.self = circular;

    const result = await register(circular as unknown as components['schemas']['RegisterRequest']);

    expect(result).toEqual({ ok: false, status: -1 });
    expect(calls).toHaveLength(0);
  });
});
