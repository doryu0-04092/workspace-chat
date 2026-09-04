import { describe, expect, it } from 'vitest';
import { resolvePort } from './port';

describe('resolvePort', () => {
  it('未設定なら 3000', () => {
    expect(resolvePort(undefined)).toBe(3000);
  });

  // PORT= と空のまま渡すのは設定の書きかけであり、既定値に落とすと
  // 意図と違うポートで黙って動く。未設定とは区別して落とす。
  it('空文字列は未設定と区別して落とす', () => {
    expect(() => resolvePort('')).toThrowError(/10進の整数/);
  });

  it('10進の整数はその値', () => {
    expect(resolvePort('8080')).toBe(8080);
    expect(resolvePort('1')).toBe(1);
    expect(resolvePort('65535')).toBe(65535);
  });

  // Number() は不正な文字列に NaN を返し、listen(NaN) は任意の空きポートで
  // 待ち受ける。設定ミスに気づけないため、ここで落とす必要がある。
  it.each(['abc', 'NaN', ' ', 'null'])('数字でない値「%s」は落とす', (raw) => {
    expect(() => resolvePort(raw)).toThrowError(/10進の整数/);
  });

  // Number() は10進以外も受理する。結果だけを見ていると取り逃がす。
  it.each([
    ['0x1F8', 504],
    ['0b101', 5],
    ['1e3', 1000],
    [' 80 ', 80],
    ['+80', 80],
    ['80.0', 80],
  ])('Number() が %s を %d と解釈しても受け付けない', (raw) => {
    expect(() => resolvePort(raw as string)).toThrowError(/10進の整数/);
  });

  it.each(['0', '65536', '99999'])('範囲外の値「%s」は落とす', (raw) => {
    expect(() => resolvePort(raw)).toThrowError(/範囲外/);
  });
});
