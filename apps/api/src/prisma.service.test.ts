import { describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from './prisma.service';

describe('DB の接続先（DATABASE_URL）', () => {
  it('設定されていれば、その値を使う', () => {
    expect(resolveDatabaseUrl('postgresql://u@127.0.0.1:5432/d')).toBe(
      'postgresql://u@127.0.0.1:5432/d',
    );
  });

  // 未設定のまま起動すると、最初の問い合わせで原因の分かりにくいエラーになる。起動時に落とす。
  it.each([undefined, ''])('%j は起動時に落とす', (raw) => {
    expect(() => resolveDatabaseUrl(raw)).toThrow(/DATABASE_URL/);
  });
});
