import { describe, expect, it } from 'vitest';
import type { SessionStore } from '../auth/session-store';
import { ApiError, requestJson } from './client';

function storeReturning(response: Response): SessionStore {
  return { authorizedFetch: async () => response } as unknown as SessionStore;
}

describe('要求の送り方（requestJson）', () => {
  it('成功の応答でも本体が JSON でなければ、投げずに応答の状態を持った ApiError にする（/api/* が静的配信に落ちたときなど）', async () => {
    const response = new Response('<!doctype html>', {
      status: 200,
      headers: { 'Content-Type': 'text/html' },
    });

    const failure = await requestJson(storeReturning(response), '/api/workspaces').catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).failure).toEqual({ ok: false, status: 200 });
  });
});
