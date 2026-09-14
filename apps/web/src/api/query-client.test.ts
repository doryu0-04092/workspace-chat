import { describe, expect, it } from 'vitest';
import { ApiError } from './client';
import { createQueryClient, shouldRetry } from './query-client';

describe('読み込みのやり直し', () => {
  it('本番の QueryClient は、読み込みのやり直しを shouldRetry で決める', () => {
    // 画面のテストは retry: false の別の QueryClient を使うため、本番の配線はここでしか通らない
    expect(createQueryClient().getDefaultOptions().queries?.retry).toBe(shouldRetry);
  });

  it('api が 4xx で断ったものはやり直さない（404 の表示を遅らせない）', () => {
    for (const status of [400, 403, 404, 409]) {
      expect(shouldRetry(0, new ApiError({ ok: false, status })), String(status)).toBe(false);
    }
  });

  it('通信の失敗と 5xx は、2回までやり直す', () => {
    for (const status of [0, 500, 503]) {
      const error = new ApiError({ ok: false, status });
      expect(shouldRetry(0, error), `${status} の1回目`).toBe(true);
      expect(shouldRetry(1, error), `${status} の2回目`).toBe(true);
      expect(shouldRetry(2, error), `${status} の3回目`).toBe(false);
    }
  });
});
