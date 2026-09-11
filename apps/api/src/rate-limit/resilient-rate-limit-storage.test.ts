import type { ThrottlerStorage } from '@nestjs/throttler';
import { describe, expect, it } from 'vitest';
import { ResilientRateLimitStorage } from './resilient-rate-limit-storage';

type Record = Awaited<ReturnType<ThrottlerStorage['increment']>>;
type Call = { key: string; ttl: number; limit: number; blockDuration: number; name: string };

class FakeStorage implements ThrottlerStorage {
  readonly calls: Call[] = [];
  failing = false;
  constructor(private readonly result: Record) {}
  async increment(key: string, ttl: number, limit: number, blockDuration: number, name: string) {
    this.calls.push({ key, ttl, limit, blockDuration, name });
    if (this.failing)
      throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    return this.result;
  }
}

class Lines {
  readonly warn: string[] = [];
  readonly log: string[] = [];
}

function setup(options: { taskCount?: number } = {}) {
  let t = 0;
  const primary = new FakeStorage({
    totalHits: 1,
    timeToExpire: 59,
    isBlocked: false,
    timeToBlockExpire: 0,
  });
  const fallback = new FakeStorage({
    totalHits: 2,
    timeToExpire: 30,
    isBlocked: true,
    timeToBlockExpire: 2,
  });
  const lines = new Lines();
  const storage = new ResilientRateLimitStorage(primary, fallback, {
    taskCount: options.taskCount ?? 2,
    retryIntervalMs: 30_000,
    now: () => t,
    logger: { warn: (m: string) => lines.warn.push(m), log: (m: string) => lines.log.push(m) },
  });
  return { storage, primary, fallback, lines, advance: (ms: number) => (t += ms) };
}

describe('Valkey が止まったときにメモリへ迂回するレート制限の保存先', () => {
  it('平常時は Valkey の保存先で数え、メモリは使わない', async () => {
    const { storage, primary, fallback } = setup();
    await storage.increment('k', 60_000, 10, 60_000, 'default');
    expect(primary.calls).toHaveLength(1);
    expect(fallback.calls).toHaveLength(0);
  });

  it('Valkey の保存先の結果をそのまま返す', async () => {
    const { storage } = setup();
    const r = await storage.increment('k', 60_000, 10, 60_000, 'default');
    expect(r).toEqual({ totalHits: 1, timeToExpire: 59, isBlocked: false, timeToBlockExpire: 0 });
  });

  it('Valkey が失敗したら、メモリで数え、上限をタスク数で割る', async () => {
    const { storage, primary, fallback } = setup({ taskCount: 2 });
    primary.failing = true;
    const r = await storage.increment('k', 60_000, 10, 60_000, 'default');
    expect(fallback.calls[0]).toEqual({
      key: 'k',
      ttl: 60_000,
      limit: 5,
      blockDuration: 60_000,
      name: 'default',
    });
    expect(r.isBlocked).toBe(true);
    expect(r.timeToBlockExpire).toBe(2);
  });

  it('上限をタスク数で割っても、1 より小さくはしない', async () => {
    const { storage, primary, fallback } = setup({ taskCount: 4 });
    primary.failing = true;
    await storage.increment('k', 60_000, 2, 60_000, 'default');
    expect(fallback.calls[0]?.limit).toBe(1);
  });

  // 止まっている間、要求のたびに Valkey を試すと、そのたびに失敗を待たされる。
  it('失敗した後しばらくは Valkey を試さず、間隔が過ぎたら試し直す', async () => {
    const { storage, primary, fallback, advance } = setup();
    primary.failing = true;
    await storage.increment('k', 60_000, 10, 60_000, 'default');
    advance(29_999);
    await storage.increment('k', 60_000, 10, 60_000, 'default');
    expect(primary.calls).toHaveLength(1);
    expect(fallback.calls).toHaveLength(2);

    advance(1);
    primary.failing = false;
    await storage.increment('k', 60_000, 10, 60_000, 'default');
    expect(primary.calls).toHaveLength(2);
    expect(fallback.calls).toHaveLength(2);
  });

  // 止まった記録は残す。ただし要求ごとには出さない（ログがあふれる）。
  it('迂回に切り替えたときと、戻ったときにだけログを出す', async () => {
    const { storage, primary, lines, advance } = setup();
    primary.failing = true;
    for (let i = 0; i < 5; i++) {
      await storage.increment('k', 60_000, 10, 60_000, 'default');
      advance(31_000);
    }
    expect(lines.warn).toHaveLength(1);
    expect(lines.log).toHaveLength(0);

    primary.failing = false;
    await storage.increment('k', 60_000, 10, 60_000, 'default');
    await storage.increment('k', 60_000, 10, 60_000, 'default');
    expect(lines.log).toHaveLength(1);
  });

  // キーは発信元（IP）から作られる。ログにキーを出さない。
  it('ログにキーを出さない', async () => {
    const { storage, primary, lines } = setup();
    primary.failing = true;
    await storage.increment('secret-tracker-key', 60_000, 10, 60_000, 'default');
    expect(lines.warn.join('\n')).not.toContain('secret-tracker-key');
    expect(lines.warn.join('\n')).toContain('ECONNREFUSED');
  });
});
