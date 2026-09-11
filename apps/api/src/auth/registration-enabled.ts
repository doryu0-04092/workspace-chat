/** 新規登録を受け付けるかどうか（要件定義書 5.1「設定フラグで新規登録を停止できる」）を注入するトークン。 */
export const REGISTRATION_ENABLED = Symbol('REGISTRATION_ENABLED');

/**
 * 環境変数 `REGISTRATION_ENABLED` から決める。**未設定なら開放する**（5.1「通常どおり開放する」）。
 *
 * **`true` / `false` 以外は起動時に落とす。** 止めるつもりで書いた `FALSE` や `0` が
 * 「開放」に倒れると、止まっていないことに誰も気づけない。
 */
export function resolveRegistrationEnabled(raw: string | undefined): boolean {
  if (raw === undefined || raw === 'true') return true;
  if (raw === 'false') return false;
  throw new Error(
    `REGISTRATION_ENABLED の値が不正です（true か false を指定してください）: ${JSON.stringify(raw)}`,
  );
}
