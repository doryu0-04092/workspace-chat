import { type Failure, readFailure } from './session-store';

/**
 * 認証の前の api（新規登録・ログイン）へ JSON を POST し、成功の応答の本体を返す。**失敗は投げずに戻り値で表す。**
 * - 本体を JSON にできない（実装の誤り）: 要求を送らずに status -1（通信の失敗〔status 0〕にしない）
 * - `fetch` の失敗: status 0
 * - 断られた応答: `readFailure`
 * - 成功の応答でも本体が JSON でない（`/api/*` が静的配信に落ちて index.html が返るなど）: 応答の状態
 */
export async function postJson<T>(
  path: string,
  input: unknown,
): Promise<{ ok: true; status: number; body: T | null } | Failure> {
  let request: string;
  try {
    request = JSON.stringify(input);
  } catch {
    return { ok: false, status: -1 };
  }
  let response: Response;
  try {
    response = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: request,
    });
  } catch {
    return { ok: false, status: 0 };
  }
  if (!response.ok) return readFailure(response);
  try {
    return { ok: true, status: response.status, body: (await response.json()) as T | null };
  } catch {
    return { ok: false, status: response.status };
  }
}
