import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeFetch, headerOf, json, PROFILE, token, USER } from '../testing/fake-api';
import { createSessionStore, type RefreshLocks } from './session-store';

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  sessionStorage.clear();
});

describe('起動時の復元', () => {
  it('リフレッシュが通れば、そのトークンで自分の情報を読み、ログインした状態になる', async () => {
    const { calls } = fakeFetch({
      'POST /api/auth/refresh': () => token('t1'),
      'GET /api/users/me': () => json(200, PROFILE),
    });
    const store = createSessionStore();
    expect(store.getState()).toEqual({ status: 'checking' });

    await store.restore();

    expect(store.getState()).toEqual({ status: 'signedIn', accessToken: 't1', user: USER });
    const me = calls.find((c) => c.key === 'GET /api/users/me');
    expect(headerOf(me!.init, 'Authorization')).toBe('Bearer t1');
  });

  it('リフレッシュは POST で本体を送らず、X-Requested-By: workspace-chat を付ける', async () => {
    const { calls } = fakeFetch({
      'POST /api/auth/refresh': () => json(401, { code: 'invalid_token', message: 'x' }),
    });
    await createSessionStore().restore();

    const refresh = calls.find((c) => c.key === 'POST /api/auth/refresh')!;
    expect(headerOf(refresh.init, 'X-Requested-By')).toBe('workspace-chat');
    expect(refresh.init.body).toBeUndefined();
  });

  it('リフレッシュが 401 なら、自分の情報を読まずにログインしていない状態になる', async () => {
    const { count } = fakeFetch({
      'POST /api/auth/refresh': () => json(401, { code: 'invalid_token', message: 'x' }),
    });
    const store = createSessionStore();
    await store.restore();

    expect(store.getState()).toEqual({ status: 'signedOut' });
    expect(count('GET /api/users/me')).toBe(0);
  });

  it('通信に失敗したとき・自分の情報を読めなかったときも、ログインしていない状態になる', async () => {
    fakeFetch({ 'POST /api/auth/refresh': () => Promise.reject(new TypeError('Failed to fetch')) });
    const offline = createSessionStore();
    await offline.restore();
    expect(offline.getState()).toEqual({ status: 'signedOut' });

    fakeFetch({
      'POST /api/auth/refresh': () => token('t1'),
      'GET /api/users/me': () => json(500, { code: 'internal_error', message: 'x' }),
    });
    const broken = createSessionStore();
    await broken.restore();
    expect(broken.getState()).toEqual({ status: 'signedOut' });
  });

  it('同時に2回呼んでも、リフレッシュの要求は1回だけ送る（系列ごとの失効を起こさない）', async () => {
    const { count } = fakeFetch({
      'POST /api/auth/refresh': () => token('t1'),
      'GET /api/users/me': () => json(200, PROFILE),
    });
    const store = createSessionStore();

    await Promise.all([store.restore(), store.restore()]);

    expect(count('POST /api/auth/refresh')).toBe(1);
    expect(count('GET /api/users/me')).toBe(1);
    expect(store.getState()).toMatchObject({ status: 'signedIn' });
  });

  it('navigator.locks があれば、リフレッシュを同じ名前のロックの中で送る（タブをまたいで直列にする）', async () => {
    const order: string[] = [];
    fakeFetch({
      'POST /api/auth/refresh': () => {
        order.push('refresh');
        return token('t1');
      },
      'GET /api/users/me': () => json(200, PROFILE),
    });
    const locks: RefreshLocks = {
      request: async (name, callback) => {
        order.push(`lock:${name}`);
        const result = await callback();
        order.push('unlock');
        return result;
      },
    };

    await createSessionStore({ locks }).restore();

    expect(order).toEqual(['lock:workspace-chat:refresh', 'refresh', 'unlock']);
  });

  it('ロックが取れず断られても（InvalidStateError など）、ロックの外でリフレッシュし、確かめる途中のまま止まらない', async () => {
    const { count } = fakeFetch({
      'POST /api/auth/refresh': () => token('t1'),
      'GET /api/users/me': () => json(200, PROFILE),
    });
    const locks: RefreshLocks = {
      request: () => Promise.reject(new DOMException('not fully active', 'InvalidStateError')),
    };
    const store = createSessionStore({ locks });

    await store.restore();

    expect(store.getState()).toEqual({ status: 'signedIn', accessToken: 't1', user: USER });
    expect(count('POST /api/auth/refresh')).toBe(1);
  });
});

describe('ログイン', () => {
  it('200 ならトークンと利用者を持ってログインした状態になり、ブラウザの保存領域には何も書かない', async () => {
    const { calls } = fakeFetch({
      'POST /api/auth/login': () =>
        json(200, { accessToken: 't1', tokenType: 'Bearer', expiresIn: 900, user: USER }),
    });
    const store = createSessionStore();

    const result = await store.login('alice', 'password-1');

    expect(result).toEqual({ ok: true });
    expect(store.getState()).toEqual({ status: 'signedIn', accessToken: 't1', user: USER });
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      userId: 'alice',
      password: 'password-1',
    });
    expect(headerOf(calls[0]!.init, 'Content-Type')).toBe('application/json');
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });

  it('401 ならエラーの種類を返し、ログインしていない状態のまま', async () => {
    fakeFetch({
      'POST /api/auth/login': () => json(401, { code: 'invalid_credentials', message: 'x' }),
    });
    const store = createSessionStore();
    await store.restore().catch(() => undefined);

    const result = await store.login('alice', 'wrong');

    expect(result).toEqual({ ok: false, status: 401, code: 'invalid_credentials' });
    expect(store.getState()).not.toMatchObject({ status: 'signedIn' });
  });

  it('200 でも本体が読めなければ（JSON でない）、失敗を返し、ログインしていない状態のまま', async () => {
    fakeFetch({
      'POST /api/auth/login': () =>
        new Response('<!doctype html>', { status: 200, headers: { 'Content-Type': 'text/html' } }),
    });
    const store = createSessionStore();

    const result = await store.login('alice', 'password-1');

    expect(result).toEqual({ ok: false, status: 200 });
    expect(store.getState()).not.toMatchObject({ status: 'signedIn' });
  });

  it('429 なら Retry-After の秒数を返す', async () => {
    fakeFetch({
      'POST /api/auth/login': () =>
        json(429, { code: 'too_many_requests', message: 'x' }, { 'Retry-After': '32' }),
    });

    const result = await createSessionStore().login('alice', 'wrong');

    expect(result).toEqual({
      ok: false,
      status: 429,
      code: 'too_many_requests',
      retryAfterSeconds: 32,
    });
  });
});

describe('ログアウト', () => {
  async function signedInStore() {
    const store = createSessionStore();
    fakeFetch({
      'POST /api/auth/login': () =>
        json(200, { accessToken: 't1', tokenType: 'Bearer', expiresIn: 900, user: USER }),
    });
    await store.login('alice', 'password-1');
    return store;
  }

  it('204 ならログインしていない状態になる。X-Requested-By を付ける', async () => {
    const store = await signedInStore();
    const { calls } = fakeFetch({
      'POST /api/auth/logout': () => new Response(null, { status: 204 }),
    });

    const result = await store.logout();

    expect(result).toEqual({ ok: true });
    expect(store.getState()).toEqual({ status: 'signedOut' });
    expect(headerOf(calls[0]!.init, 'X-Requested-By')).toBe('workspace-chat');
  });

  it('失敗したら、ログインした状態のまま失敗を返す（Cookie が残るため、消したふりをしない）', async () => {
    const store = await signedInStore();
    fakeFetch({
      'POST /api/auth/logout': [
        () => json(500, { code: 'internal_error', message: 'x' }),
        () => Promise.reject(new TypeError('Failed to fetch')),
      ],
    });

    expect(await store.logout()).toEqual({ ok: false });
    expect(await store.logout()).toEqual({ ok: false });
    expect(store.getState()).toMatchObject({ status: 'signedIn', accessToken: 't1' });
  });
});

describe('トークンを付けた要求', () => {
  async function signedInStore() {
    fakeFetch({
      'POST /api/auth/login': () =>
        json(200, { accessToken: 't1', tokenType: 'Bearer', expiresIn: 900, user: USER }),
    });
    const store = createSessionStore();
    await store.login('alice', 'password-1');
    return store;
  }

  it('Authorization を付けて送る', async () => {
    const store = await signedInStore();
    const { calls } = fakeFetch({ 'GET /api/workspaces': () => json(200, []) });

    const response = await store.authorizedFetch('/api/workspaces');

    expect(response.status).toBe(200);
    expect(headerOf(calls[0]!.init, 'Authorization')).toBe('Bearer t1');
  });

  it('401 なら1回だけリフレッシュし、新しいトークンでやり直す', async () => {
    const store = await signedInStore();
    const { calls } = fakeFetch({
      'GET /api/workspaces': [
        () => json(401, { code: 'invalid_token', message: 'x' }),
        () => json(200, []),
      ],
      'POST /api/auth/refresh': () => token('t2'),
    });

    const response = await store.authorizedFetch('/api/workspaces');

    expect(response.status).toBe(200);
    expect(calls.map((c) => c.key)).toEqual([
      'GET /api/workspaces',
      'POST /api/auth/refresh',
      'GET /api/workspaces',
    ]);
    expect(headerOf(calls[2]!.init, 'Authorization')).toBe('Bearer t2');
    expect(store.getState()).toMatchObject({ status: 'signedIn', accessToken: 't2', user: USER });
  });

  it('リフレッシュも 401 なら、ログインしていない状態になり、最初の 401 を返す', async () => {
    const store = await signedInStore();
    const { count } = fakeFetch({
      'GET /api/workspaces': () => json(401, { code: 'invalid_token', message: 'x' }),
      'POST /api/auth/refresh': () => json(401, { code: 'invalid_token', message: 'x' }),
    });

    const response = await store.authorizedFetch('/api/workspaces');

    expect(response.status).toBe(401);
    expect(count('GET /api/workspaces')).toBe(1);
    expect(store.getState()).toEqual({ status: 'signedOut' });
  });

  it('同時に2本が 401 になっても、リフレッシュは1回だけ送る', async () => {
    const store = await signedInStore();
    const { count } = fakeFetch({
      'GET /api/workspaces': [
        () => json(401, { code: 'invalid_token', message: 'x' }),
        () => json(401, { code: 'invalid_token', message: 'x' }),
        () => json(200, []),
        () => json(200, []),
      ],
      'POST /api/auth/refresh': () => token('t2'),
    });

    const [a, b] = await Promise.all([
      store.authorizedFetch('/api/workspaces'),
      store.authorizedFetch('/api/workspaces'),
    ]);

    expect([a.status, b.status]).toEqual([200, 200]);
    expect(count('POST /api/auth/refresh')).toBe(1);
  });
});
