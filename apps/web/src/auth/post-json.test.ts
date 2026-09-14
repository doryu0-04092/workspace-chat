import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeFetch } from '../testing/fake-api';
import { postJson } from './post-json';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('認証の前の POST（postJson）', () => {
  it('fetch が通信の失敗（TypeError）で断ったら、status 0 の失敗を返す', async () => {
    fakeFetch({ 'POST /api/auth/login': () => Promise.reject(new TypeError('Failed to fetch')) });

    const result = await postJson('/api/auth/login', { userId: 'alice' });

    expect(result).toEqual({ ok: false, status: 0 });
  });

  it('fetch が TypeError でない例外で断ったら、通信の失敗（status 0）に畳まず、投げずに status -1 の失敗を返す', async () => {
    fakeFetch({
      'POST /api/auth/login': () => Promise.reject(new DOMException('aborted', 'AbortError')),
    });

    const result = await postJson('/api/auth/login', { userId: 'alice' }).catch(
      (error: unknown) => error,
    );

    expect(result).toEqual({ ok: false, status: -1 });
  });
});
