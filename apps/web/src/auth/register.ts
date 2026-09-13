import type { components } from '@workspace-chat/shared';
import { type Failure, readFailure } from './session-store';

export type RegisterResult = { ok: true; recoveryCode: string } | Failure;

/** 新規登録。登録してもログインした状態にはならない（REST の仕様の /auth/register）。 */
export async function register(
  input: components['schemas']['RegisterRequest'],
): Promise<RegisterResult> {
  let response: Response;
  try {
    response = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
  } catch {
    return { ok: false, status: 0 };
  }
  if (!response.ok) return readFailure(response);
  const body = (await response.json()) as components['schemas']['RegisterResponse'];
  return { ok: true, recoveryCode: body.recoveryCode };
}
