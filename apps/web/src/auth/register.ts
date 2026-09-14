import type { components } from '@workspace-chat/shared';
import { postJson } from './post-json';
import type { Failure } from './session-store';

export type RegisterResult = { ok: true; recoveryCode: string } | Failure;

/** 新規登録。登録してもログインした状態にはならない（REST の仕様の /auth/register）。失敗は投げずに戻り値で表す（`postJson`）。 */
export async function register(
  input: components['schemas']['RegisterRequest'],
): Promise<RegisterResult> {
  const result = await postJson<components['schemas']['RegisterResponse']>(
    '/api/auth/register',
    input,
  );
  if (!result.ok) return result;
  // 成功の応答でも本体が JSON の null なら、投げずに失敗として返す
  if (result.body === null) return { ok: false, status: result.status };
  return { ok: true, recoveryCode: result.body.recoveryCode };
}
