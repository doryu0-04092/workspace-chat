import { randomBytes } from 'node:crypto';
import * as argon2 from 'argon2';

/**
 * パスワードとリカバリーコードのハッシュ化と照合（F-03 / F-37）。**保存と照合は必ずこの2つの関数を通す。**
 *
 * **Argon2id を OWASP Password Storage Cheat Sheet の最小構成（m=19456 (19 MiB), t=2, p=1）で使う。**
 * `argon2` の既定値（m=65536, t=3, p=4）には寄りかからず、ここで明示する——
 * 既定値はライブラリの版で変わりうるためである。値を変えると、保存済みのハッシュは
 * 文字列に焼き込まれた旧パラメータのまま照合でき、新規の分だけが新しい値になる。
 *
 * **ハッシュ化も照合も、秘密を NFC に正規化してから行う**（NIST SP 800-63B-4 3.1.1.2 の SHOULD。機能一覧 1.1）。
 * 正規化をこの中に置くのは、呼び出す側（登録・ログイン・再設定）に任せると、片側だけ書き忘れたときに
 * 端末によって登録と違うコードポイント列で送られた利用者がログインできなくなるためである
 * （ログインは失敗の理由を返さないため、「パスワードが違う」と区別がつかない。機能一覧 1.2）。
 * **`argon2.hash` / `argon2.verify` をここ以外から直接呼ばないこと。**
 * リカバリーコードは正規形（recovery-code.ts）が ASCII に寄せるため、NFC は何も変えない。
 */
const ARGON2ID_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

export function hashSecret(secret: string): Promise<string> {
  return argon2.hash(secret.normalize('NFC'), ARGON2ID_OPTIONS);
}

export function verifySecret(hash: string, secret: string): Promise<boolean> {
  return argon2.verify(hash, secret.normalize('NFC'));
}

let dummyHash: Promise<string> | undefined;

/**
 * 照合する相手（利用者・コード）が見つからないときに照合する、捨てるためのハッシュ（同じパラメータの Argon2id）。
 * **見つからないときに照合を飛ばすと、応答までの時間で登録済みの ID を見分けられる。** 最初に要ったときに1回だけ作る。
 */
export function dummySecretHash(): Promise<string> {
  dummyHash ??= hashSecret(randomBytes(32).toString('base64url'));
  return dummyHash;
}
