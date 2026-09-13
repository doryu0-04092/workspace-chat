import { failureMessage } from '../auth/failure-message';
import { type Failure, readFailure, type SessionStore } from '../auth/session-store';

/** api が断った要求（通信の失敗は status 0）。画面は `failure` から文を作る。 */
export class ApiError extends Error {
  constructor(readonly failure: Failure) {
    super(`api が要求を断った（${failure.status}${failure.code ? ` ${failure.code}` : ''}）`);
  }
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
  let response: Response;
  try {
    response = await store.authorizedFetch(path, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    });
  } catch {
    throw new ApiError({ ok: false, status: 0 });
  }
  if (!response.ok) throw new ApiError(await readFailure(response));
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

/** 画面に出す文。api が断ったものは種類ごとの文、それ以外は一般の文。 */
export function errorMessage(error: unknown): string {
  return failureMessage(error instanceof ApiError ? error.failure : { ok: false, status: -1 });
}
