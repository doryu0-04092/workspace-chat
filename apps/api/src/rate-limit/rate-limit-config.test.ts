import { describe, expect, it } from 'vitest';
import { resolveApiTaskCount, resolveRedisUrl, resolveTrustProxyHops } from './rate-limit-config';

describe('レート制限の設定', () => {
  describe('REDIS_URL（Valkey の接続先）', () => {
    it('設定されていれば、その値を使う', () => {
      expect(resolveRedisUrl('redis://127.0.0.1:6379')).toBe('redis://127.0.0.1:6379');
    });
    it.each([undefined, ''])('%j は起動時に落とす', (raw) => {
      expect(() => resolveRedisUrl(raw)).toThrow(/REDIS_URL/);
    });
  });

  // 発信元（req.ip）を X-Forwarded-For のどこから取るか。**多すぎると利用者が偽の発信元を名乗れ、
  // 少なすぎると全員が手前の中継（ALB）の IP で数えられて、1人の超過で全員が止まる。**
  describe('TRUST_PROXY_HOPS（信頼する中継の段数）', () => {
    it('設定していなければ 0（X-Forwarded-For を信じない）', () => {
      expect(resolveTrustProxyHops(undefined)).toBe(0);
    });
    it.each([
      ['0', 0],
      ['2', 2],
    ])('%j は %d', (raw, expected) => {
      expect(resolveTrustProxyHops(raw)).toBe(expected);
    });
    it.each(['', '-1', '1.5', 'true', ' 2', '0x2'])('%j は起動時に落とす', (raw) => {
      expect(() => resolveTrustProxyHops(raw)).toThrow(/TRUST_PROXY_HOPS/);
    });
  });

  // Valkey が止まっている間、各タスクのメモリで数えるときに上限を割る数。
  describe('API_TASK_COUNT（api のタスク数）', () => {
    it('設定していなければ 1', () => {
      expect(resolveApiTaskCount(undefined)).toBe(1);
    });
    it('2 なら 2', () => {
      expect(resolveApiTaskCount('2')).toBe(2);
    });
    it.each(['', '0', '-1', '1.5', 'two'])('%j は起動時に落とす', (raw) => {
      expect(() => resolveApiTaskCount(raw)).toThrow(/API_TASK_COUNT/);
    });
  });
});
