import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { resolveCloudFrontKeyPairId, resolveCloudFrontPrivateKey } from './cloudfront-config';

/** テストのたびに作る鍵（ソースに鍵の形の文字列を置かない）。 */
function pem(type: 'rsa' | 'ec'): string {
  const { privateKey } =
    type === 'rsa'
      ? generateKeyPairSync('rsa', { modulusLength: 2048 })
      : generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
}

describe('CloudFront の署名付き Cookie の設定', () => {
  describe('CLOUDFRONT_KEY_PAIR_ID（キーグループに登録した公開鍵の ID）', () => {
    // 未設定は手元（CloudFront が無い）。Cookie を発行しない。
    it('設定していなければ undefined', () => {
      expect(resolveCloudFrontKeyPairId(undefined)).toBeUndefined();
    });
    it.each(['K2JCJMDEHXQW5F', 'APKAEIBAERJR2EXAMPLE'])('%j を使う', (raw) => {
      expect(resolveCloudFrontKeyPairId(raw)).toBe(raw);
    });
    // 空文字を「設定していない」に倒さない（書き忘れが、本番で Cookie を黙って発行しない形で動いてしまう）。
    // Cookie の値にそのまま載るため、英大文字と数字のほかを受け付けない。
    it.each(['', 'k2jcjmdehxqw5f', 'K2JC JMDE', 'K2JC;JMDE', ' K2JCJMDEHXQW5F', 'K'.repeat(65)])(
      '%j は起動時に落とす',
      (raw) => {
        expect(() => resolveCloudFrontKeyPairId(raw)).toThrow(/CLOUDFRONT_KEY_PAIR_ID/);
      },
    );
  });

  describe('CLOUDFRONT_PRIVATE_KEY（署名の秘密鍵）', () => {
    it('設定していなければ undefined', () => {
      expect(resolveCloudFrontPrivateKey(undefined)).toBeUndefined();
    });
    it('PEM の RSA 秘密鍵を使う', () => {
      const key = pem('rsa');
      expect(resolveCloudFrontPrivateKey(key)).toBe(key);
    });
    // 読めない鍵で起動すると、Cookie の発行のたびに落ちる。起動時に落とす。CloudFront の署名は RSA だけである。
    it.each([
      ['空', ''],
      ['PEM でない', 'not-a-key'],
      ['RSA でない', pem('ec')],
    ])('%s鍵は起動時に落とす', (_label, raw) => {
      expect(() => resolveCloudFrontPrivateKey(raw)).toThrow(/CLOUDFRONT_PRIVATE_KEY/);
    });
    // 値は鍵そのもの。resolve 関数のメッセージにも載せない（集約の側でも伏せるが、二重にする）。
    it('不正なときのメッセージに値を載せない', () => {
      const raw = 'secret-material-9x';
      expect(() => resolveCloudFrontPrivateKey(raw)).toThrow(
        expect.objectContaining({ message: expect.not.stringContaining(raw) as unknown }),
      );
    });
  });
});
