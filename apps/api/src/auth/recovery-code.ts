import { randomInt } from 'node:crypto';

/**
 * リカバリーコード（F-37）の形。
 *
 * **Crockford の Base32（32 文字。I・L・O・U を使わない）で16文字＝80ビット**を、4文字ずつハイフンで区切って表示する。
 * 紙に控えて打ち直すものであるため、読み違えやすい文字を含まない字母を使う。
 * **1文字ごとに `randomInt`（暗号論的に安全な乱数・偏りなし）で選ぶ。** 文字が偏ると、形は同じまま強度だけが落ちる。
 */
const CROCKFORD_BASE32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LENGTH = 16;
const GROUP_LENGTH = 4;

export function generateRecoveryCode(): string {
  const groups: string[] = [];
  for (let start = 0; start < CODE_LENGTH; start += GROUP_LENGTH) {
    let group = '';
    for (let i = 0; i < GROUP_LENGTH; i++) {
      group += CROCKFORD_BASE32[randomInt(CROCKFORD_BASE32.length)];
    }
    groups.push(group);
  }
  return groups.join('-');
}

/**
 * ハッシュに掛ける正規形。**発行時も照合時も、必ずこれを通してからハッシュ化・照合する。**
 * 大文字にしてハイフンを除き、Crockford の読み替え（O → 0、I・L → 1）を当てる。
 */
export function canonicalRecoveryCode(code: string): string {
  return code.toUpperCase().replaceAll('-', '').replaceAll('O', '0').replace(/[IL]/g, '1');
}
