import { describe, expect, it } from 'vitest';
import type { SessionStore } from '../auth/session-store';
import { ApiError, requestJson } from './client';

function storeReturning(response: Response): SessionStore {
  return { authorizedFetch: async () => response } as unknown as SessionStore;
}

function storeRejecting(error: unknown): SessionStore {
  return {
    authorizedFetch: async () => {
      throw error;
    },
  } as unknown as SessionStore;
}

describe('要求の送り方（requestJson）', () => {
  // #449: 断られた応答と 204 は、通信の失敗（status 0）に畳まない（try の外に置く）。
  it('断られた応答は、状態と code を持った ApiError にする（通信の失敗に畳まない）', async () => {
    const response = new Response(JSON.stringify({ code: 'owner_only', message: 'オーナーだけ' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });

    const failure = await requestJson(storeReturning(response), '/api/workspaces/x/members').catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).failure).toMatchObject({
      ok: false,
      status: 403,
      code: 'owner_only',
    });
  });

  it('204 の応答は、本体を読まずに undefined を返す', async () => {
    const result = await requestJson<void>(
      storeReturning(new Response(null, { status: 204 })),
      '/api/workspaces/x/channels/y/join',
      { method: 'POST' },
    );

    expect(result).toBeUndefined();
  });

  it('通信の失敗（fetch は TypeError で断る）は、status 0 の ApiError にする', async () => {
    const failure = await requestJson(
      storeRejecting(new TypeError('Failed to fetch')),
      '/api/workspaces',
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).failure).toEqual({ ok: false, status: 0 });
  });

  it('通信の失敗でない例外（実装の誤り）は、通信の失敗に畳まずにそのまま投げる', async () => {
    const misuse = new Error('ログインしていない状態では authorizedFetch を呼ばない');

    const failure = await requestJson(storeRejecting(misuse), '/api/workspaces').catch(
      (error: unknown) => error,
    );

    expect(failure).toBe(misuse);
  });

  it('本体を JSON にできなければ、要求を送らずにそのまま投げる（通信の失敗にしない）', async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    let sent = false;
    const store = {
      authorizedFetch: async () => {
        sent = true;
        return new Response(null, { status: 204 });
      },
    } as unknown as SessionStore;

    const failure = await requestJson(store, '/api/workspaces', {
      method: 'POST',
      body: circular,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(TypeError);
    expect(failure).not.toBeInstanceOf(ApiError);
    expect(sent).toBe(false);
  });

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
