import type { components } from '@workspace-chat/shared';
import { createStore } from 'zustand/vanilla';
import { type Failure, readFailure } from './failure';
import { postJson } from './post-json';

type Schemas = components['schemas'];

export type SessionUser = Schemas['UserSummary'];

/**
 * `unavailable`: 起動時の復元で、ログインの状態を確かめられなかった（401 のほかの失敗が、やり直しても続いた。機能一覧 1.2。#420）。
 */
export type SessionState =
  | { status: 'checking' }
  | { status: 'signedOut' }
  | { status: 'unavailable' }
  | { status: 'signedIn'; accessToken: string; user: SessionUser };

export type LoginResult = { ok: true } | Failure;
export type LogoutResult = { ok: true } | { ok: false };

/** `navigator.locks` のうち、ここで使う部分。 */
export interface RefreshLocks {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>;
}

/** 1回の要求の結果。失敗は `Failure`（`status` の意味は failure.ts）。 */
type Attempt<T> = { ok: true; value: T } | Failure;

/** Cookie を使う要求（リフレッシュ・ログアウト）に付ける独自のヘッダーの値。綴りは REST の仕様の列挙を型が見る。 */
const REQUESTED_BY: components['parameters']['RequestedBy'] = 'workspace-chat';
const REFRESH_LOCK = 'workspace-chat:refresh';

/**
 * 起動時の復元のやり直し（機能一覧 1.2。#420。1 秒と 10 秒は実装時に決めた値）。
 * 通信の失敗・5xx は 1 秒後に、429 は `Retry-After` が 10 秒以下ならその秒数の後に、1回だけやり直す。
 */
const RESTORE_RETRY_DELAY_MS = 1000;
const RESTORE_RETRY_AFTER_LIMIT_SECONDS = 10;

/**
 * 起動時の復元の1つの要求（リフレッシュ・自分の情報の読み込み）の時限（#530。10 秒は実装時に決めた値）。
 * 超えたら打ち切り、通信の失敗（status 0）として扱う——やり直し、それでも返らなければ `unavailable` になる。
 * 時限が無いと、応答が返らない間 `checking` のままで、利用者が自分で開いたログイン・登録の画面も出ない。
 * 10 秒は、小さな2つの要求の通常の応答より十分に長く遅い回線の応答を切らない一方、読み込み中のまま待たせる時間を抑える値である
 * （返らない要求がやり直しでも続くと、1つの要求で 10 秒 + 1 秒 + 10 秒待つ）。
 */
const RESTORE_REQUEST_TIMEOUT_MS = 10_000;

/** 時限で打ち切った要求の失敗。通信の失敗と同じく扱う。 */
const TIMED_OUT: Failure = { ok: false, status: 0 };

/**
 * 要求の結果を、時限が切れたら待たずに `TIMED_OUT` で決着させる。
 * **踏むと壊れる: 打ち切った後に届いた結果は捨てる。** `fetch` が打ち切りを受け取らずに後から応答を返しても、
 * 決着した後なので状態に当たらない（当てると、やり直しと並んで状態を書き換える）。
 */
function withDeadline<T>(request: Promise<Attempt<T>>, signal?: AbortSignal): Promise<Attempt<T>> {
  if (!signal) return request;
  const timedOut = new Promise<Failure>((resolve) => {
    if (signal.aborted) resolve(TIMED_OUT);
    else signal.addEventListener('abort', () => resolve(TIMED_OUT), { once: true });
  });
  return Promise.race([request, timedOut]);
}

/** やり直すまでに待つミリ秒。やり直さない失敗なら null。 */
function retryDelayOf(failure: Failure): number | null {
  if (failure.status === 0 || failure.status >= 500) return RESTORE_RETRY_DELAY_MS;
  if (
    failure.status === 429 &&
    failure.retryAfterSeconds !== undefined &&
    failure.retryAfterSeconds <= RESTORE_RETRY_AFTER_LIMIT_SECONDS
  ) {
    return failure.retryAfterSeconds * 1000;
  }
  return null;
}

/** 復元が失敗で終わったときの状態。**ログインしていない状態にするのは 401 のときだけ**である。 */
function stateAfterFailure(failure: Failure): SessionState {
  return failure.status === 401 ? { status: 'signedOut' } : { status: 'unavailable' };
}

/** `fetch` が断ったときの失敗。通信そのものの失敗（`TypeError`）は status 0、ほかの例外は -1（failure.ts）。 */
function thrownFailure(error: unknown): Failure {
  return { ok: false, status: error instanceof TypeError ? 0 : -1 };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
 *
 * 状態は Zustand の store（`zustand/vanilla`）に置き、画面は `useStore(store.state)` で読む
 * （技術スタックの「一時状態」。ログインの状態もその射程に含める。決定・2026-09-14・依頼側）。
 * `wait` は復元のやり直しの待ち方（既定は `setTimeout`。テストは待った時間を記録して実際には待たない）。
 * `timeoutSignal` は復元の要求の時限の作り方（既定は `AbortSignal.timeout`。テストは手で打ち切る）。
 */
export function createSessionStore(
  options: {
    locks?: RefreshLocks;
    wait?: (ms: number) => Promise<void>;
    timeoutSignal?: (ms: number) => AbortSignal;
  } = {},
) {
  const locks = 'locks' in options ? options.locks : browserLocks();
  const wait = options.wait ?? sleep;
  const timeoutSignal = options.timeoutSignal ?? ((ms: number) => AbortSignal.timeout(ms));
  const state = createStore<SessionState>()(() => ({ status: 'checking' }));
  /**
   * ログインの世代。ログイン・ログアウト・起動時の復元・リフレッシュの失敗でログインが替わるたびに進む（アクセストークンの取り直しでは進まない）。
   * **踏むと壊れる: 非同期の待ち（リフレッシュ）の後は、状態ではなく世代で「同じログインか」を確かめる。** 状態だけを見ると、待つ間に
   * ログアウトして別の利用者がログインし終えたとき、前の利用者のアクセストークンがその利用者のセッションに入る（認可の破れ）。
   */
  let generation = 0;
  let refreshing: { generation: number; promise: Promise<Attempt<string>> } | null = null;
  let restoring: Promise<void> | null = null;

  function set(next: SessionState): void {
    state.setState(next, true);
  }

  /** ログインを替える（世代を進める）。 */
  function changeLogin(next: SessionState): void {
    generation += 1;
    set(next);
  }

  function withLock<T>(task: () => Promise<T>): Promise<T> {
    return locks ? locks.request(REFRESH_LOCK, task) : task();
  }

  /** `signal` が打ち切られていたら送らない（ロックを待つ間に時限が切れた要求を、やり直しと並べて送らない）。 */
  async function sendRefresh(signal?: AbortSignal): Promise<Attempt<string>> {
    if (signal?.aborted) return TIMED_OUT;
    try {
      const response = await fetch('/api/auth/refresh', {
        method: 'POST',
        headers: { 'X-Requested-By': REQUESTED_BY },
        signal,
      });
      if (!response.ok) return await readFailure(response);
      const body = (await response.json().catch(() => null)) as Schemas['RefreshResponse'] | null;
      return body === null
        ? { ok: false, status: response.status }
        : { ok: true, value: body.accessToken };
    } catch (error) {
      return signal?.aborted ? TIMED_OUT : thrownFailure(error);
    }
  }

  /**
   * 新しいアクセストークン。使えなければ失敗の種類。`signal` を渡すと、ロックを待つ間も含めて時限で打ち切る（`withDeadline`）。
   * **ロックそのものが断られたら（文書が fully active でない `InvalidStateError` など）、ロックの外で送る**——
   * 断られたまま投げると `restore` が状態を決めずに終わり、確かめる途中のまま戻れない。ロックの外で送る代償は、ロックの無いブラウザと同じである。
   */
  function refreshToken(signal?: AbortSignal): Promise<Attempt<string>> {
    // 同時の呼び出しは1本に束ねるが、束ねるのは同じログインの間だけ（前のログインの待っている分を使い回さない）
    if (refreshing?.generation !== generation) {
      const entry = {
        generation,
        promise: withDeadline(
          withLock(() => sendRefresh(signal)).catch(() => sendRefresh(signal)),
          signal,
        ).finally(() => {
          if (refreshing === entry) refreshing = null;
        }),
      };
      refreshing = entry;
    }
    return refreshing.promise;
  }

  function readMe(accessToken: string, signal: AbortSignal): Promise<Attempt<SessionUser>> {
    return withDeadline(
      (async (): Promise<Attempt<SessionUser>> => {
        try {
          const response = await fetch('/api/users/me', {
            headers: { Authorization: `Bearer ${accessToken}` },
            signal,
          });
          if (!response.ok) return await readFailure(response);
          const profile = (await response.json().catch(() => null)) as Schemas['Profile'] | null;
          if (profile === null) return { ok: false, status: response.status };
          const { id, userId, displayName } = profile;
          return { ok: true, value: { id, userId, displayName } };
        } catch (error) {
          return signal.aborted ? TIMED_OUT : thrownFailure(error);
        }
      })(),
      signal,
    );
  }

  /** 起動時の復元の1つの要求を、失敗の種類によって1回だけやり直す（`retryDelayOf`）。 */
  async function withRetry<T>(attempt: () => Promise<Attempt<T>>): Promise<Attempt<T>> {
    const first = await attempt();
    if (first.ok) return first;
    const delay = retryDelayOf(first);
    if (delay === null) return first;
    await wait(delay);
    return attempt();
  }

  /**
   * アクセストークンを取り直す。取り直せなければログインしていない状態にし、null を返す。
   * 待つ間にログインが替わったら（ログアウト・別の利用者のログイン）、結果をいまのログインに当てず、null を返す。
   */
  async function renew(): Promise<string | null> {
    const started = generation;
    const renewed = await refreshToken();
    if (generation !== started) return null;
    if (!renewed.ok) {
      changeLogin({ status: 'signedOut' });
      return null;
    }
    const latest = state.getState();
    if (latest.status === 'signedIn' && latest.accessToken !== renewed.value)
      set({ ...latest, accessToken: renewed.value });
    return renewed.value;
  }

  function send(path: string, init: RequestInit, accessToken: string): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${accessToken}`);
    return fetch(path, { ...init, headers });
  }

  return {
    /** 画面が `useStore` で読む Zustand の store。 */
    state,

    getState: (): SessionState => state.getState(),

    /**
     * 起動時に1回だけ、リフレッシュで状態を取り直す。何度呼んでも同じ1回を待つ。
     * **ログインしていない状態にするのは 401 のときだけ**。ほかの失敗は1回だけやり直し、それでも通らなければ `unavailable` にする
     * （機能一覧 1.2。#420）。**自分の情報の読み込みだけが失敗したときは、リフレッシュを送り直さない**——入れ替えの時点のリフレッシュを
     * 2回送ると、後の側が再利用とみなされる。
     * 1つ1つの要求（やり直しを含む）に時限を置く（`RESTORE_REQUEST_TIMEOUT_MS`。#530）。
     */
    restore(): Promise<void> {
      restoring ??= (async () => {
        const deadline = () => timeoutSignal(RESTORE_REQUEST_TIMEOUT_MS);
        const refreshed = await withRetry(() => refreshToken(deadline()));
        if (!refreshed.ok) {
          changeLogin(stateAfterFailure(refreshed));
          return;
        }
        const me = await withRetry(() => readMe(refreshed.value, deadline()));
        changeLogin(
          me.ok
            ? { status: 'signedIn', accessToken: refreshed.value, user: me.value }
            : stateAfterFailure(me),
        );
      })();
      return restoring;
    },

    /** 失敗は投げずに戻り値で表す（`postJson`）。 */
    async login(userId: string, password: string): Promise<LoginResult> {
      const result = await postJson<Schemas['LoginResponse']>('/api/auth/login', {
        userId,
        password,
      } satisfies Schemas['LoginRequest']);
      if (!result.ok) return result;
      // 成功の応答でも本体が JSON の null なら、投げずに失敗として返す
      if (result.body === null) return { ok: false, status: result.status };
      changeLogin({
        status: 'signedIn',
        accessToken: result.body.accessToken,
        user: result.body.user,
      });
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
      changeLogin({ status: 'signedOut' });
      return { ok: true };
    },

    /** アクセストークンを付けて送る。401 なら1回だけリフレッシュしてやり直し、それも駄目ならログインしていない状態にする。 */
    async authorizedFetch(path: string, init: RequestInit = {}): Promise<Response> {
      const current = state.getState();
      if (current.status !== 'signedIn')
        throw new Error('ログインしていない状態では authorizedFetch を呼ばない');
      const response = await send(path, init, current.accessToken);
      if (response.status !== 401) return response;
      const renewed = await renew();
      // null には、待つ間にログインが替わった場合を含む（ログアウトの後・別の利用者のログインの後に、前の要求を送り直さない）
      if (renewed === null) return response;
      return send(path, init, renewed);
    },

    renew,
  };
}

export type SessionStore = ReturnType<typeof createSessionStore>;
