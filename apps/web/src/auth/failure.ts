import type { components } from '@workspace-chat/shared';

export type ErrorCode = components['schemas']['ErrorResponse']['code'];

/**
 * 成功しなかった要求。`status` の意味:
 * - HTTP の状態（4xx・5xx）: api が断った。`code` はエラーの種類（`readFailure`）
 * - 2xx: 応答は成功だったが、本体を読めなかった（JSON でない・JSON の null）
 * - 0: 通信そのものに失敗した（`fetch` が `TypeError` で断った）
 * - -1: HTTP の応答が無い失敗——要求を送っていない実装の誤り（本体を JSON にできないなど）・`fetch` が `TypeError` でない例外で断った・
 *   `ApiError` でない例外（`errorMessage`）・WebSocket のハンドシェイクの拒否（`realtime-context.tsx`）
 *
 * 画面の文は `failureMessage` が作る（0 と 429 と `code` のほかは既定の文）。
 */
export type Failure = { ok: false; status: number; code?: ErrorCode; retryAfterSeconds?: number };

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
