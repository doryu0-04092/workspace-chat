import * as argon2 from 'argon2';

/**
 * パスワードとリカバリーコードのハッシュ化（F-03 / F-37）。
 *
 * **Argon2id を OWASP Password Storage Cheat Sheet の最小構成（m=19456 (19 MiB), t=2, p=1）で使う。**
 * `argon2` の既定値（m=65536, t=3, p=4）には寄りかからず、ここで明示する——
 * 既定値はライブラリの版で変わりうるためである。値を変えると、保存済みのハッシュは
 * 文字列に焼き込まれた旧パラメータのまま照合でき、新規の分だけが新しい値になる。
 */
const ARGON2ID_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

export function hashSecret(secret: string): Promise<string> {
  return argon2.hash(secret, ARGON2ID_OPTIONS);
}
