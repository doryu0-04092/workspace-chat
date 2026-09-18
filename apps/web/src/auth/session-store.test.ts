import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeFetch, headerOf, json, loggedIn, PROFILE, token, USER } from '../testing/fake-api';
import { hang, manualTimeouts } from '../testing/manual-timeouts';
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

  describe('401 のほかの失敗（機能一覧 1.2。#420）', () => {
    const offline = () => Promise.reject(new TypeError('Failed to fetch'));
    const internalError = () => json(500, { code: 'internal_error', message: 'x' });
    const tooMany = (retryAfter?: string) => () =>
      json(
        429,
        { code: 'too_many_requests', message: 'x' },
        retryAfter === undefined ? {} : { 'Retry-After': retryAfter },
      );

    /** 待った時間を記録し、実際には待たない。 */
    function recordingWait() {
      const waited: number[] = [];
      return {
        waited,
        wait: (ms: number) => {
          waited.push(ms);
          return Promise.resolve();
        },
      };
    }

    it('通信に失敗したら1秒待って1回だけやり直し、通ればログインした状態になる', async () => {
      const { count } = fakeFetch({
        'POST /api/auth/refresh': [offline, () => token('t1')],
        'GET /api/users/me': () => json(200, PROFILE),
      });
      const { waited, wait } = recordingWait();
      const store = createSessionStore({ wait });

      await store.restore();

      expect(store.getState()).toEqual({ status: 'signedIn', accessToken: 't1', user: USER });
      expect(waited).toEqual([1000]);
      expect(count('POST /api/auth/refresh')).toBe(2);
    });

    it('やり直しても 5xx・通信の失敗が続けば、ログインしていない状態にせず、確かめられなかった状態になる（やり直しは1回だけ）', async () => {
      const { count } = fakeFetch({ 'POST /api/auth/refresh': [internalError, offline] });
      const { waited, wait } = recordingWait();
      const store = createSessionStore({ wait });

      await store.restore();

      expect(store.getState()).toEqual({ status: 'unavailable' });
      expect(waited).toEqual([1000]);
      expect(count('POST /api/auth/refresh')).toBe(2);
      expect(count('GET /api/users/me')).toBe(0);
    });

    it('429 で Retry-After が 10 秒以下なら、その秒数待って1回だけやり直す', async () => {
      fakeFetch({
        'POST /api/auth/refresh': [tooMany('3'), () => token('t1')],
        'GET /api/users/me': () => json(200, PROFILE),
      });
      const { waited, wait } = recordingWait();
      const store = createSessionStore({ wait });

      await store.restore();

      expect(store.getState()).toEqual({ status: 'signedIn', accessToken: 't1', user: USER });
      expect(waited).toEqual([3000]);
    });

    it('429 で Retry-After が 10 秒を超える・無いなら、やり直さずに確かめられなかった状態になる', async () => {
      for (const retryAfter of ['11', undefined]) {
        const { count } = fakeFetch({ 'POST /api/auth/refresh': tooMany(retryAfter) });
        const { waited, wait } = recordingWait();
        const store = createSessionStore({ wait });

        await store.restore();

        expect(store.getState(), String(retryAfter)).toEqual({ status: 'unavailable' });
        expect(waited, String(retryAfter)).toEqual([]);
        expect(count('POST /api/auth/refresh'), String(retryAfter)).toBe(1);
      }
    });

    it('リフレッシュが通って自分の情報の読み込みだけが失敗したら、リフレッシュを送り直さず、読み込みだけを1回やり直す', async () => {
      const { calls, count } = fakeFetch({
        'POST /api/auth/refresh': () => token('t1'),
        'GET /api/users/me': [internalError, () => json(200, PROFILE)],
      });
      const { waited, wait } = recordingWait();
      const store = createSessionStore({ wait });

      await store.restore();

      expect(store.getState()).toEqual({ status: 'signedIn', accessToken: 't1', user: USER });
      expect(count('POST /api/auth/refresh')).toBe(1);
      expect(waited).toEqual([1000]);
      const retried = calls.filter((c) => c.key === 'GET /api/users/me').at(-1)!;
      expect(headerOf(retried.init, 'Authorization')).toBe('Bearer t1');
    });

    it('自分の情報の読み込みがやり直しても失敗すれば、確かめられなかった状態になる', async () => {
      fakeFetch({
        'POST /api/auth/refresh': () => token('t1'),
        'GET /api/users/me': [internalError, offline],
      });
      const store = createSessionStore({ wait: recordingWait().wait });

      await store.restore();

      expect(store.getState()).toEqual({ status: 'unavailable' });
    });

    it('やり直した結果が 401 なら、ログインしていない状態になる', async () => {
      fakeFetch({
        'POST /api/auth/refresh': [
          internalError,
          () => json(401, { code: 'invalid_token', message: 'x' }),
        ],
      });
      const store = createSessionStore({ wait: recordingWait().wait });

      await store.restore();

      expect(store.getState()).toEqual({ status: 'signedOut' });
    });

    it('401・429・5xx・通信の失敗のほかの断り（400 など）は、やり直さずに確かめられなかった状態になる', async () => {
      const { count } = fakeFetch({
        'POST /api/auth/refresh': () => json(400, { code: 'validation_failed', message: 'x' }),
      });
      const { waited, wait } = recordingWait();
      const store = createSessionStore({ wait });

      await store.restore();

      expect(store.getState()).toEqual({ status: 'unavailable' });
      expect(waited).toEqual([]);
      expect(count('POST /api/auth/refresh')).toBe(1);
    });

    describe('応答が返らないとき（#530）', () => {
      it('リフレッシュが返らなければ、10 秒の時限で打ち切って通信の失敗として1回だけやり直し、やり直しも返らなければ確かめられなかった状態になる', async () => {
        const { count } = fakeFetch({ 'POST /api/auth/refresh': [hang, hang] });
        const { waited, wait } = recordingWait();
        const timeouts = manualTimeouts();
        const store = createSessionStore({ wait, timeoutSignal: timeouts.timeoutSignal });

        const restoring = store.restore();
        await vi.waitFor(() => expect(timeouts.requested).toHaveLength(1));
        expect(timeouts.requested).toEqual([10_000]);
        expect(store.getState()).toEqual({ status: 'checking' });
        timeouts.fire(0);
        await vi.waitFor(() => expect(timeouts.requested).toHaveLength(2));
        timeouts.fire(1);
        await restoring;

        expect(store.getState()).toEqual({ status: 'unavailable' });
        expect(waited).toEqual([1000]);
        expect(count('POST /api/auth/refresh')).toBe(2);
        expect(count('GET /api/users/me')).toBe(0);
      });

      it('自分の情報の読み込みが返らなければ、打ち切って読み込みだけを1回やり直し、やり直しも返らなければ確かめられなかった状態になる', async () => {
        const { count } = fakeFetch({
          'POST /api/auth/refresh': () => token('t1'),
          'GET /api/users/me': [hang, hang],
        });
        const timeouts = manualTimeouts();
        const store = createSessionStore({
          wait: recordingWait().wait,
          timeoutSignal: timeouts.timeoutSignal,
        });

        const restoring = store.restore();
        // 0 番目はリフレッシュの時限（応答が返ったので切らない）
        await vi.waitFor(() => expect(timeouts.requested).toHaveLength(2));
        timeouts.fire(1);
        await vi.waitFor(() => expect(timeouts.requested).toHaveLength(3));
        timeouts.fire(2);
        await restoring;

        expect(store.getState()).toEqual({ status: 'unavailable' });
        expect(timeouts.requested).toEqual([10_000, 10_000, 10_000]);
        expect(count('POST /api/auth/refresh')).toBe(1);
        expect(count('GET /api/users/me')).toBe(2);
      });

      it('打ち切ったリフレッシュの応答が後から届いても、そのトークンを使わず、状態を書き換えない', async () => {
        let deliverLate: ((response: Response) => void) | undefined;
        // 打ち切りを無視して後から応答を返す要求（打ち切りが fetch に届かなかった場合）
        const late = () =>
          new Promise<Response>((resolve) => {
            deliverLate = resolve;
          });
        const { count } = fakeFetch({
          'POST /api/auth/refresh': [late, hang],
          'GET /api/users/me': () => json(200, PROFILE),
        });
        const timeouts = manualTimeouts();
        const store = createSessionStore({
          wait: recordingWait().wait,
          timeoutSignal: timeouts.timeoutSignal,
        });

        const restoring = store.restore();
        await vi.waitFor(() => expect(deliverLate).toBeDefined());
        timeouts.fire(0);
        deliverLate!(token('t-late'));
        await vi.waitFor(() => expect(timeouts.requested).toHaveLength(2));
        timeouts.fire(1);
        await restoring;
        await new Promise((resolve) => setTimeout(resolve, 20));

        expect(store.getState()).toEqual({ status: 'unavailable' });
        expect(count('GET /api/users/me')).toBe(0);
      });
    });
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

  // #425: 製品の経路（引数なしの createSessionStore()）は navigator.locks を自分で見に行く。jsdom には locks が無いため、差し替えて通す。
  it('ロックを渡さなければ navigator.locks を使い、リフレッシュを同じ名前のロックの中で送る', async () => {
    const order: string[] = [];
    fakeFetch({
      'POST /api/auth/refresh': () => {
        order.push('refresh');
        return token('t1');
      },
      'GET /api/users/me': () => json(200, PROFILE),
    });
    vi.stubGlobal('navigator', {
      ...navigator,
      locks: {
        request: async (name: string, callback: () => Promise<unknown>) => {
          order.push(`lock:${name}`);
          const result = await callback();
          order.push('unlock');
          return result;
        },
      },
    });

    await createSessionStore().restore();

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

  it('200 でも本体が JSON の null なら、投げずに失敗を返し、ログインしていない状態のまま', async () => {
    fakeFetch({ 'POST /api/auth/login': () => json(200, null) });
    const store = createSessionStore();

    const result = await store.login('alice', 'password-1').catch((error: unknown) => error);

    expect(result).toEqual({ ok: false, status: 200 });
    expect(store.getState()).not.toMatchObject({ status: 'signedIn' });
  });

  it('通信に失敗したら（fetch が TypeError で断る）、投げずに status 0 の失敗を返し、ログインしていない状態のまま', async () => {
    fakeFetch({ 'POST /api/auth/login': () => Promise.reject(new TypeError('Failed to fetch')) });
    const store = createSessionStore();

    const result = await store.login('alice', 'password-1').catch((error: unknown) => error);

    expect(result).toEqual({ ok: false, status: 0 });
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

  it('リフレッシュを待つ間にログアウトしたら、リフレッシュが後から通っても送り直さず、最初の 401 を返す', async () => {
    const store = await signedInStore();
    let finishRefresh: ((response: Response) => void) | undefined;
    const { count } = fakeFetch({
      'GET /api/workspaces': [
        () => json(401, { code: 'invalid_token', message: 'x' }),
        () => json(200, []),
      ],
      'POST /api/auth/refresh': () =>
        new Promise<Response>((resolve) => {
          finishRefresh = resolve;
        }),
      'POST /api/auth/logout': () => new Response(null, { status: 204 }),
    });

    const pending = store.authorizedFetch('/api/workspaces');
    await vi.waitFor(() => expect(finishRefresh).toBeDefined());
    await store.logout();
    finishRefresh!(token('t2'));
    const response = await pending;

    expect(response.status).toBe(401);
    expect(count('GET /api/workspaces')).toBe(1);
    expect(store.getState()).toEqual({ status: 'signedOut' });
  });

  describe('リフレッシュを待つ間に、ログアウトして別の利用者がログインし直したとき', () => {
    /** テストで使うもう1人の利用者（実在の人物ではない）。 */
    const BOB = { id: '01920000-0000-7000-8000-000000000002', userId: 'bob', displayName: 'ボブ' };
    const unauthorized = () => json(401, { code: 'invalid_token', message: 'x' });
    const bobLogin = () =>
      json(200, { accessToken: 't-bob', tokenType: 'Bearer', expiresIn: 900, user: BOB });

    it('前の利用者のリフレッシュが後から通っても、そのトークンを入れず、前の要求も送り直さない', async () => {
      const store = await signedInStore();
      let finishRefresh: ((response: Response) => void) | undefined;
      const { count } = fakeFetch({
        'GET /api/workspaces': [unauthorized, () => json(200, [])],
        'POST /api/auth/refresh': () =>
          new Promise<Response>((resolve) => {
            finishRefresh = resolve;
          }),
        'POST /api/auth/logout': () => new Response(null, { status: 204 }),
        'POST /api/auth/login': bobLogin,
      });

      const pending = store.authorizedFetch('/api/workspaces');
      await vi.waitFor(() => expect(finishRefresh).toBeDefined());
      await store.logout();
      await store.login('bob', 'password-2');
      finishRefresh!(token('t2'));
      const response = await pending;

      expect(response.status).toBe(401);
      expect(count('GET /api/workspaces')).toBe(1);
      expect(store.getState()).toEqual({ status: 'signedIn', accessToken: 't-bob', user: BOB });
    });

    it('前の利用者のリフレッシュが後から失敗しても、ログインし直した利用者をログアウトさせない', async () => {
      const store = await signedInStore();
      let finishRefresh: ((response: Response) => void) | undefined;
      fakeFetch({
        'GET /api/workspaces': unauthorized,
        'POST /api/auth/refresh': () =>
          new Promise<Response>((resolve) => {
            finishRefresh = resolve;
          }),
        'POST /api/auth/logout': () => new Response(null, { status: 204 }),
        'POST /api/auth/login': bobLogin,
      });

      const pending = store.authorizedFetch('/api/workspaces');
      await vi.waitFor(() => expect(finishRefresh).toBeDefined());
      await store.logout();
      await store.login('bob', 'password-2');
      finishRefresh!(unauthorized());
      await pending;

      expect(store.getState()).toEqual({ status: 'signedIn', accessToken: 't-bob', user: BOB });
    });

    it('ログインし直した利用者の 401 は、前の利用者の待っているリフレッシュを使い回さず、新しく送る', async () => {
      const store = await signedInStore();
      let finishAliceRefresh: ((response: Response) => void) | undefined;
      const { calls, count } = fakeFetch({
        'GET /api/workspaces': [unauthorized, unauthorized, () => json(200, [])],
        'POST /api/auth/refresh': [
          () =>
            new Promise<Response>((resolve) => {
              finishAliceRefresh = resolve;
            }),
          () => token('t-bob2'),
        ],
        'POST /api/auth/logout': () => new Response(null, { status: 204 }),
        'POST /api/auth/login': bobLogin,
      });

      const alice = store.authorizedFetch('/api/workspaces');
      await vi.waitFor(() => expect(finishAliceRefresh).toBeDefined());
      await store.logout();
      await store.login('bob', 'password-2');
      const bob = store.authorizedFetch('/api/workspaces');

      await vi.waitFor(() => expect(count('POST /api/auth/refresh')).toBe(2));
      expect((await bob).status).toBe(200);
      const retried = calls.filter((c) => c.key === 'GET /api/workspaces').at(-1)!;
      expect(headerOf(retried.init, 'Authorization')).toBe('Bearer t-bob2');

      finishAliceRefresh!(token('t2'));
      await alice;
      expect(store.getState()).toEqual({ status: 'signedIn', accessToken: 't-bob2', user: BOB });
    });

    it('前の利用者のリフレッシュが終わっても、ログインし直した利用者の待っているリフレッシュは束ねたままにする', async () => {
      const store = await signedInStore();
      let finishAliceRefresh: ((response: Response) => void) | undefined;
      let finishBobRefresh: ((response: Response) => void) | undefined;
      const { count } = fakeFetch({
        'GET /api/workspaces': [
          unauthorized,
          unauthorized,
          unauthorized,
          () => json(200, []),
          () => json(200, []),
        ],
        'POST /api/auth/refresh': [
          () =>
            new Promise<Response>((resolve) => {
              finishAliceRefresh = resolve;
            }),
          () =>
            new Promise<Response>((resolve) => {
              finishBobRefresh = resolve;
            }),
          () => token('t-extra'),
        ],
        'POST /api/auth/logout': () => new Response(null, { status: 204 }),
        'POST /api/auth/login': bobLogin,
      });

      const alice = store.authorizedFetch('/api/workspaces');
      await vi.waitFor(() => expect(finishAliceRefresh).toBeDefined());
      await store.logout();
      await store.login('bob', 'password-2');
      const bobFirst = store.authorizedFetch('/api/workspaces');
      await vi.waitFor(() => expect(finishBobRefresh).toBeDefined());
      finishAliceRefresh!(token('t2'));
      await alice;

      const bobSecond = store.authorizedFetch('/api/workspaces');
      await vi.waitFor(() => expect(count('GET /api/workspaces')).toBe(3));
      await new Promise((resolve) => setTimeout(resolve, 20));
      finishBobRefresh!(token('t-bob2'));

      expect([(await bobFirst).status, (await bobSecond).status]).toEqual([200, 200]);
      expect(count('POST /api/auth/refresh')).toBe(2);
    });
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

// 機能一覧 1.3（F-04）: プロフィールを変えたら、画面の枠の表示名に使う情報を差し替える。#551。
describe('利用者の情報の差し替え', () => {
  async function signedInStore() {
    fakeFetch({ 'POST /api/auth/login': () => loggedIn('t1') });
    const store = createSessionStore();
    await store.login('alice', 'password-1');
    return store;
  }

  it('ログインしている利用者と同じ id なら差し替え、トークンは変えない', async () => {
    const store = await signedInStore();

    store.updateUser({ ...USER, displayName: 'ありす' });

    expect(store.getState()).toEqual({
      status: 'signedIn',
      accessToken: 't1',
      user: { ...USER, displayName: 'ありす' },
    });
  });

  it('別の利用者の情報では差し替えない（待つ間にログインが替わっていたとき）', async () => {
    const store = await signedInStore();

    store.updateUser({
      id: '01920000-0000-7000-8000-000000000002',
      userId: 'bob',
      displayName: 'ボブ',
      avatarUrl: null,
    });

    expect(store.getState()).toEqual({ status: 'signedIn', accessToken: 't1', user: USER });
  });
});
