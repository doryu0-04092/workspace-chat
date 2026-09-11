import { describe, expect, it } from 'vitest';
import { canonicalRecoveryCode, generateRecoveryCode } from './recovery-code';

// Crockford の Base32（I・L・O・U を使わない）。
const DISPLAY_FORM = /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/;

describe('リカバリーコード（F-37）', () => {
  it('表示の形は、Crockford の Base32 で16文字（80ビット）を4文字ずつハイフンで区切ったもの', () => {
    for (let i = 0; i < 200; i++) {
      expect(generateRecoveryCode()).toMatch(DISPLAY_FORM);
    }
  });

  // 16文字 × 5ビットで 80 ビットになるのは、32 文字すべてが偏りなく出る場合だけである。
  // 使う文字が減ると、形は合ったまま強度だけが落ちる。
  it('32 文字すべてが使われる', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) {
      for (const ch of generateRecoveryCode().replaceAll('-', '')) seen.add(ch);
    }
    expect(seen.size).toBe(32);
  });

  it('毎回違う値になる', () => {
    const codes = new Set(Array.from({ length: 1000 }, () => generateRecoveryCode()));
    expect(codes.size).toBe(1000);
  });

  // ハッシュに掛けるのは正規形である。照合（⑤）で利用者が打つ形の揺れ
  // （小文字・ハイフンの有無・Crockford が読み替えを定める O/I/L）を同じ値に寄せる。
  it('正規形は、大文字にしてハイフンを除き、O を 0 に、I と L を 1 に読み替えたもの', () => {
    expect(canonicalRecoveryCode('abcd-efgh-jkmn-pqrs')).toBe('ABCDEFGHJKMNPQRS');
    expect(canonicalRecoveryCode('O1IL-0000-1111-2222')).toBe('0111000011112222');
  });

  it('表示の形の正規形は、ハイフンを除いただけのもの', () => {
    const code = generateRecoveryCode();
    expect(canonicalRecoveryCode(code)).toBe(code.replaceAll('-', ''));
  });
});
