import { describe, expect, it } from 'vitest';
import { resolveRegistrationEnabled } from './registration-enabled';

// 要件定義書 5.1「設定フラグで新規登録を停止できる作りにする」。既定は開放する。
describe('新規登録の停止のフラグ（REGISTRATION_ENABLED）', () => {
  it('設定していなければ開放する', () => {
    expect(resolveRegistrationEnabled(undefined)).toBe(true);
  });

  it('true なら開放し、false なら停止する', () => {
    expect(resolveRegistrationEnabled('true')).toBe(true);
    expect(resolveRegistrationEnabled('false')).toBe(false);
  });

  // 止めるつもりで書いた値が「開放」に倒れると、止まっていないことに気づけない。
  // true / false 以外は起動時に落とす。
  it.each(['', 'FALSE', '0', 'no', 'off', ' false'])('%j は起動時に落とす', (raw) => {
    expect(() => resolveRegistrationEnabled(raw)).toThrow(/REGISTRATION_ENABLED/);
  });
});
