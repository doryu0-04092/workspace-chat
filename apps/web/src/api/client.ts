import { failureMessage } from '../auth/failure-message';
import { type Failure, readFailure, type SessionStore } from '../auth/session-store';

/** api が断った要求（通信の失敗は status 0）。画面は `failure` から文を作る。 */
export class ApiError extends Error {
  constructor(readonly failure: Failure) {
    super(`api が要求を断った（${failure.status}${failure.code ? ` ${failure.code}` : ''}）`);
  }
}

/**
 * api のパスの1区切りに埋める値を符号化する。
 * **踏むと壊れる: URL のパラメータ（`useParams`）は、react-router が `%2F` などを復号して返す**（8.3.1 で確かめた。`..%2F..%2Fauth%2Flogout` は `../../auth/logout` になる）。
 * そのまま埋めると `..` や `/` がパスの区切りとして読まれ、別の api へアクセストークン付きで要求が向く。
 */
export function segment(value: string): string {
  return encodeURIComponent(value);
}

/**
 * アクセストークンを付けて JSON の要求を送り、本体を返す（204 は undefined）。
 * 401 のやり直しとログインの状態の切り替えは `authorizedFetch` が持つ。
 */
export async function requestJson<T>(
  store: SessionStore,
  path: string,
  { method, body }: { method?: string; body?: unknown } = {},
): Promise<T> {
  const init: RequestInit = {
    method,
    ...(body === undefined
      ? {}
      : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  };
  let response: Response;
  try {
    response = await store.authorizedFetch(path, init);
  } catch (cause) {
    // fetch が断った TypeError だけを status 0 にし、authorizedFetch が投げる Error（ログインしていない状態での呼び出しなど）は畳まない。
    // fetch は要求の組み立ての誤り（GET に本体を渡す・不正なヘッダーなど）でも TypeError を投げるため、そちらは通信の失敗と分けられない
    if (cause instanceof TypeError) throw new ApiError({ ok: false, status: 0 });
    throw cause;
  }
  if (!response.ok) throw new ApiError(await readFailure(response));
  if (response.status === 204) return undefined as T;
  try {
    return (await response.json()) as T;
  } catch {
    // 成功の応答でも本体が JSON でなければ（`/api/*` が静的配信に落ちて index.html が返るなど）、応答の状態を持った ApiError にする
    throw new ApiError({ ok: false, status: response.status });
  }
}

/** 画面に出す文。api が断ったものは種類ごとの文、それ以外は一般の文。 */
export function errorMessage(error: unknown): string {
  return failureMessage(error instanceof ApiError ? error.failure : { ok: false, status: -1 });
}
