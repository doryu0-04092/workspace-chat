import type { components } from '@workspace-chat/shared';

type Schemas = components['schemas'];

export type SessionUser = Schemas['UserSummary'];
export type ErrorCode = Schemas['ErrorResponse']['code'];

export type SessionState =
  | { status: 'checking' }
  | { status: 'signedOut' }
  | { status: 'signedIn'; accessToken: string; user: SessionUser };

/** 断られた要求。`status` が 0 のときは通信そのものに失敗した。 */
export type Failure = { ok: false; status: number; code?: ErrorCode; retryAfterSeconds?: number };
export type LoginResult = { ok: true } | Failure;
export type LogoutResult = { ok: true } | { ok: false };

/** `navigator.locks` のうち、ここで使う部分。 */
export interface RefreshLocks {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>;
}

/** Cookie を使う要求（リフレッシュ・ログアウト）に付ける独自のヘッダーの値。綴りは REST の仕様の列挙を型が見る。 */
const REQUESTED_BY: components['parameters']['RequestedBy'] = 'workspace-chat';
const REFRESH_LOCK = 'workspace-chat:refresh';

/** 断られた応答から、エラーの種類と（429 なら）待つ秒数を読む。 */
export async function readFailure(response: Response): Promise<Failure> {
  const failure: Failure = { ok: false, status: response.status };
  const body = (await response.json().catch(() => null)) as { code?: unknown } | null;
  if (typeof body?.code === 'string') failure.code = body.code as ErrorCode;
  const retryAfter = response.headers.get('Retry-After');
  if (response.status === 429 && retryAfter !== null && /^[0-9]+$/.test(retryAfter)) {
    failure.retryAfterSeconds = Number(retryAfter);
  }
  return failure;
}

function browserLocks(): RefreshLocks | undefined {
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
  if (!locks) return undefined;
  // lib.dom の型は、コールバックが返す Promise を解いた値で決着することを表せない（Promise<Promise<T>> になる）。await で解く
  return { request: async (name, callback) => await locks.request(name, () => callback()) };
}

/**
 * ログインの状態を持つ（アクセストークンはメモリだけに置く。決定・2026-09-13・依頼側。機能一覧 1.2）。
 * ブラウザの保存領域には、トークンもリフレッシュの結果も書かない。再読み込みでは `restore` がリフレッシュで取り直す。
 *
 * **踏むと壊れる: リフレッシュは1つの store で同時に1本だけ送り、`navigator.locks` があればタブをまたいでも直列にする。**
 * 発行から1日を過ぎたリフレッシュトークンを同時に2回送ると、後の側が再利用とみなされ、そのログインの系列ごと失効する
 * （機能一覧 1.2）。開発時の StrictMode は effect を2回走らせるため、ここで1本に束ねないと再読み込みのたびに起こりうる。
 * 直列にすれば、後の側は入れ替え後の Cookie を送る。
 */
export function createSessionStore(options: { locks?: RefreshLocks } = {}) {
  const locks = 'locks' in options ? options.locks : browserLocks();
  let state: SessionState = { status: 'checking' };
  const listeners = new Set<() => void>();
  let refreshing: Promise<string | null> | null = null;
  let restoring: Promise<void> | null = null;

  function set(next: SessionState): void {
    state = next;
    for (const listener of listeners) listener();
  }

  function withLock<T>(task: () => Promise<T>): Promise<T> {
    return locks ? locks.request(REFRESH_LOCK, task) : task();
  }

  /** 新しいアクセストークン。使えなければ null。 */
  function refreshToken(): Promise<string | null> {
    refreshing ??= withLock(async () => {
      try {
        const response = await fetch('/api/auth/refresh', {
          method: 'POST',
          headers: { 'X-Requested-By': REQUESTED_BY },
        });
        if (!response.ok) return null;
        return ((await response.json()) as Schemas['RefreshResponse']).accessToken;
      } catch {
        return null;
      }
    }).finally(() => {
      refreshing = null;
    });
    return refreshing;
  }

  async function readMe(accessToken: string): Promise<SessionUser | null> {
    try {
      const response = await fetch('/api/users/me', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!response.ok) return null;
      const { id, userId, displayName } = (await response.json()) as Schemas['Profile'];
      return { id, userId, displayName };
    } catch {
      return null;
    }
  }

  function send(path: string, init: RequestInit, accessToken: string): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${accessToken}`);
    return fetch(path, { ...init, headers });
  }

  return {
    getState: (): SessionState => state,

    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    /** 起動時に1回だけ、リフレッシュで状態を取り直す。何度呼んでも同じ1回を待つ。 */
    restore(): Promise<void> {
      restoring ??= (async () => {
        const accessToken = await refreshToken();
        const user = accessToken === null ? null : await readMe(accessToken);
        set(
          accessToken !== null && user !== null
            ? { status: 'signedIn', accessToken, user }
            : { status: 'signedOut' },
        );
      })();
      return restoring;
    },

    async login(userId: string, password: string): Promise<LoginResult> {
      let response: Response;
      try {
        response = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId, password } satisfies Schemas['LoginRequest']),
        });
      } catch {
        return { ok: false, status: 0 };
      }
      if (!response.ok) return readFailure(response);
      const body = (await response.json()) as Schemas['LoginResponse'];
      set({ status: 'signedIn', accessToken: body.accessToken, user: body.user });
      return { ok: true };
    },

    /** 失敗したらログインした状態のまま返す。Cookie が残っているのに消したふりをすると、再読み込みで戻る。 */
    async logout(): Promise<LogoutResult> {
      try {
        const response = await fetch('/api/auth/logout', {
          method: 'POST',
          headers: { 'X-Requested-By': REQUESTED_BY },
        });
        if (response.status !== 204) return { ok: false };
      } catch {
        return { ok: false };
      }
      set({ status: 'signedOut' });
      return { ok: true };
    },

    /** アクセストークンを付けて送る。401 なら1回だけリフレッシュしてやり直し、それも駄目ならログインしていない状態にする。 */
    async authorizedFetch(path: string, init: RequestInit = {}): Promise<Response> {
      if (state.status !== 'signedIn')
        throw new Error('ログインしていない状態では authorizedFetch を呼ばない');
      const used = state.accessToken;
      const response = await send(path, init, used);
      if (response.status !== 401) return response;
      const renewed = await refreshToken();
      if (renewed === null) {
        set({ status: 'signedOut' });
        return response;
      }
      if (state.status === 'signedIn' && state.accessToken !== renewed)
        set({ ...state, accessToken: renewed });
      return send(path, init, renewed);
    },
  };
}

export type SessionStore = ReturnType<typeof createSessionStore>;
