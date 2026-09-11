import { describe, expect, it } from 'vitest';
import { dummySecretHash, hashSecret, verifySecret } from './secret-hash';

const DECOMPOSED = 'café-password'; // e + 結合用アキュート（NFD）
const COMPOSED = 'café-password'; // é（NFC）

// NIST SP 800-63B-4 3.1.1.2: Unicode を受け付けるなら NFC で正規化する（SHOULD）。
// **ハッシュ化と照合が同じ正規化を通ることを、この2つの関数の中で固定する。**
// 呼び出す側（登録・ログイン・再設定）に任せると、片側だけ書き忘れたときに、端末によってログインできなくなる。
describe('秘密のハッシュ化と照合（F-03）', () => {
  it('分解形で登録したパスワードを、合成形で照合できる', async () => {
    expect(await verifySecret(await hashSecret(DECOMPOSED), COMPOSED)).toBe(true);
  });

  it('合成形で登録したパスワードを、分解形で照合できる', async () => {
    expect(await verifySecret(await hashSecret(COMPOSED), DECOMPOSED)).toBe(true);
  });

  it('違う秘密は照合に通らない', async () => {
    expect(await verifySecret(await hashSecret(COMPOSED), 'cafe-password')).toBe(false);
  });
});

// 照合する相手が見つからないときに照合する捨てるためのハッシュ。要求のたびに作ると、見つからないときだけ Argon2id を2回走らせることになる。
describe('捨てるためのハッシュ（dummySecretHash）', () => {
  it('同じパラメータの Argon2id で、1回だけ作る', async () => {
    const first = await dummySecretHash();
    // パラメータの並び順はライブラリが決める（argon2 0.45.1 は m,p,t）。
    expect(first).toMatch(/^[$]argon2id[$]v=19[$]m=19456,p=1,t=2[$]/);
    expect(await dummySecretHash()).toBe(first);
  });
});
