import type { components } from '@workspace-chat/shared';
import { postJson } from './post-json';
import type { Failure } from './failure';

export type RecoverResult = { ok: true; recoveryCode: string } | Failure;

/**
 * リカバリーコードでパスワードを再設定する（REST の仕様の /auth/recovery。F-37）。再設定してもログインした状態にはならない。
 * 使ったコードは無効になり、新しいコードはこの応答でだけ返る。失敗は投げずに戻り値で表す（`postJson`）。
 */
export async function recover(
  input: components['schemas']['RecoveryRequest'],
): Promise<RecoverResult> {
  const result = await postJson<components['schemas']['RecoveryResponse']>(
    '/api/auth/recovery',
    input,
  );
  if (!result.ok) return result;
  // 成功の応答でも本体が JSON の null なら、投げずに失敗として返す
  if (result.body === null) return { ok: false, status: result.status };
  return { ok: true, recoveryCode: result.body.recoveryCode };
}
