import { describe, expect, it } from 'vitest';
import { resolvePort } from './port';

describe('resolvePort', () => {
  it('未設定なら 3000', () => {
    expect(resolvePort(undefined)).toBe(3000);
    expect(resolvePort('')).toBe(3000);
  });

  it('整数の文字列はその値', () => {
    expect(resolvePort('8080')).toBe(8080);
  });

  // Number() は不正な文字列に NaN を返し、listen(NaN) は任意の空きポートで
  // 待ち受ける。設定ミスに気づけないため、ここで落とす必要がある。
  it.each(['abc', '0', '65536', '-1', '80.5', 'NaN', ' '])('不正な値「%s」は落とす', (raw) => {
    expect(() => resolvePort(raw)).toThrowError(/PORT の値が不正です/);
  });
});
