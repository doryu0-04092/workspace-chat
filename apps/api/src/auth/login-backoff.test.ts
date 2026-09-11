import Redis from 'ioredis';
import type { StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startValkey } from '../testing/valkey';
import {
  LOGIN_BACKOFF_MAX_MS,
  LOGIN_BACKOFF_RESET_MS,
  type LoginBackoffStore,
  MemoryLoginBackoffStore,
  ResilientLoginBackoffStore,
  ValkeyLoginBackoffStore,
  backoffMs,
} from './login-backoff';

// アカウント単位のログインの制限: 失敗のたびに待ち時間を延ばす（決定・2026-09-11・依頼側）。
// OWASP Authentication Cheat Sheet「the lockout duration starts as a very short period (e.g., one second), but doubles after each failed login attempt」。
describe('待ち時間（backoffMs）', () => {
  it.each([
    [0, 0],
    [1, 1_000],
    [2, 2_000],
    [3, 4_000],
    [10, 512_000],
  ])('連続した失敗が %i 回なら %i ms', (failures, expected) => {
    expect(backoffMs(failures)).toBe(expected);
  });

  it.each([11, 100, 10_000])('%i 回でも上限（15 分）を超えない', (failures) => {
    expect(backoffMs(failures)).toBe(LOGIN_BACKOFF_MAX_MS);
    expect(LOGIN_BACKOFF_MAX_MS).toBe(15 * 60 * 1000);
  });
});

/** 保存先に共通の振る舞い。Valkey とメモリで、止める・通すの判定が変わらないことを同じ検査で見る。 */
function describeStore(name: string, create: () => LoginBackoffStore): void {
  describe(name, () => {
    let seq = 0;
    const key = () => `user_${name.length}_${Date.now()}_${++seq}`;
    const T = 1_800_000_000_000;

    it('失敗していなければ通す', async () => {
      const store = create();
      expect(await store.begin(key(), T)).toEqual({ allowed: true });
    });

    it('1回失敗したら、1秒の間は止め、残りの時間を返す', async () => {
      const store = create();
      const k = key();
      await store.recordFailure(k, T);
      expect(await store.begin(k, T + 1)).toEqual({ allowed: false, retryAfterMs: 999 });
      expect(await store.begin(k, T + 999)).toEqual({ allowed: false, retryAfterMs: 1 });
      expect(await store.begin(k, T + 1_000)).toEqual({ allowed: true });
    });

    it('失敗が重なると待ち時間が倍になる', async () => {
      const store = create();
      const k = key();
      await store.recordFailure(k, T);
      await store.recordFailure(k, T);
      expect(await store.begin(k, T + 1_999)).toEqual({ allowed: false, retryAfterMs: 1 });
      expect(await store.begin(k, T + 2_000)).toEqual({ allowed: true });
    });

    // 待ち時間が明けた瞬間に並べて送ると、照合を待ち時間1回あたり1回に抑えられない。
    it('待ち時間が明けた後に通すのは1回だけで、続く試行は次の待ち時間まで止める', async () => {
      const store = create();
      const k = key();
      await store.recordFailure(k, T);
      const results = await Promise.all([
        store.begin(k, T + 1_000),
        store.begin(k, T + 1_000),
        store.begin(k, T + 1_000),
      ]);
      expect(results.filter((r) => r.allowed)).toHaveLength(1);
    });

    it('成功（reset）で数え直す', async () => {
      const store = create();
      const k = key();
      await store.recordFailure(k, T);
      await store.recordFailure(k, T);
      await store.reset(k);
      expect(await store.begin(k, T + 1)).toEqual({ allowed: true });
      await store.recordFailure(k, T + 1);
      expect(await store.begin(k, T + 1_001)).toEqual({ allowed: true });
    });

    it('最後の失敗から 24 時間で数え直す', async () => {
      const store = create();
      const k = key();
      for (let i = 0; i < 12; i++) await store.recordFailure(k, T);
      const later = T + LOGIN_BACKOFF_RESET_MS;
      expect(await store.begin(k, later)).toEqual({ allowed: true });
      await store.recordFailure(k, later);
      expect(await store.begin(k, later + 1_000)).toEqual({ allowed: true });
    });

    it('キーごとに独立して数える', async () => {
      const store = create();
      const a = key();
      await store.recordFailure(a, T);
      expect(await store.begin(key(), T + 1)).toEqual({ allowed: true });
    });
  });
}

describeStore('メモリ', () => new MemoryLoginBackoffStore());

describe('メモリの保存先の上限', () => {
  it('上限に達したら、最も古く触れた記録から捨てる（メモリを守り、ログインは止めない）', async () => {
    const store = new MemoryLoginBackoffStore({ maxEntries: 2 });
    const T = 1_800_000_000_000;
    await store.recordFailure('a', T);
    await store.recordFailure('b', T);
    await store.recordFailure('a', T); // a を新しくする
    await store.recordFailure('c', T); // 上限を超え、最も古い b を捨てる
    expect(store.size).toBe(2);
    expect(await store.begin('b', T + 1)).toEqual({ allowed: true });
    expect((await store.begin('a', T + 1)).allowed).toBe(false);
    expect((await store.begin('c', T + 1)).allowed).toBe(false);
  });
});

describe('Valkey の保存先', () => {
  let container: StartedTestContainer;
  let valkeyUrl = '';
  const clients: Redis[] = [];

  beforeAll(async () => {
    const started = await startValkey();
    container = started.container;
    valkeyUrl = started.url;
  }, 120_000);

  afterAll(async () => {
    for (const client of clients) client.disconnect();
    await container?.stop();
  });

  describeStore('Valkey', () => {
    // 保存先は各 it の中で作る（beforeAll で Valkey が起動した後）。
    const client = new Redis(valkeyUrl);
    clients.push(client);
    return new ValkeyLoginBackoffStore(client);
  });
});

describe('Valkey が止まっているとき（ResilientLoginBackoffStore）', () => {
  function failing(): LoginBackoffStore {
    const error = Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:6379'), {
      code: 'ECONNREFUSED',
    });
    return {
      begin: vi.fn().mockRejectedValue(error),
      recordFailure: vi.fn().mockRejectedValue(error),
      reset: vi.fn().mockRejectedValue(error),
    };
  }

  it('Valkey に書けなければ、各タスクのメモリで数えて止めない', async () => {
    const logger = { warn: vi.fn(), log: vi.fn() };
    const store = new ResilientLoginBackoffStore(failing(), new MemoryLoginBackoffStore(), {
      retryIntervalMs: 30_000,
      logger,
    });
    const T = 1_800_000_000_000;
    expect(await store.begin('k', T)).toEqual({ allowed: true });
    await store.recordFailure('k', T);
    expect(await store.begin('k', T + 1)).toEqual({ allowed: false, retryAfterMs: 999 });
  });

  it('切り替えたときに1回だけ warn を出し、キー（ユーザーID）と接続先を載せない', async () => {
    const logger = { warn: vi.fn(), log: vi.fn() };
    const store = new ResilientLoginBackoffStore(failing(), new MemoryLoginBackoffStore(), {
      retryIntervalMs: 30_000,
      logger,
    });
    const T = 1_800_000_000_000;
    await store.begin('secret_user', T);
    await store.recordFailure('secret_user', T);
    await store.begin('secret_user', T + 1);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const message = String(logger.warn.mock.calls[0]?.[0]);
    expect(message).not.toContain('secret_user');
    expect(message).not.toContain('10.0.0.1');
  });

  it('試し直す間隔が過ぎたら Valkey を試し、戻ったらログを出す', async () => {
    const logger = { warn: vi.fn(), log: vi.fn() };
    let now = 1_800_000_000_000;
    const primary = failing();
    const store = new ResilientLoginBackoffStore(primary, new MemoryLoginBackoffStore(), {
      retryIntervalMs: 30_000,
      logger,
      now: () => now,
    });
    await store.begin('k', now);
    expect(primary.begin).toHaveBeenCalledTimes(1);
    await store.begin('k', now);
    expect(primary.begin).toHaveBeenCalledTimes(1);

    now += 30_000;
    vi.mocked(primary.begin).mockResolvedValue({ allowed: true });
    expect(await store.begin('k', now)).toEqual({ allowed: true });
    expect(primary.begin).toHaveBeenCalledTimes(2);
    expect(logger.log).toHaveBeenCalledTimes(1);
  });
});
