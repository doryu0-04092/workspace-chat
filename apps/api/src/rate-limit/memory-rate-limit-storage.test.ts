import { describe, expect, it } from 'vitest';
import { MemoryRateLimitStorage } from './memory-rate-limit-storage';

/** 時刻を手で進める。 */
function clock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

const TTL = 60_000;

// Valkey が止まっている間に各タスクのメモリで数える保存先。
// 数え方は Redis の保存先（@nest-lab/throttler-storage-redis の Lua）と同じ固定窓にする。
describe('メモリで数えるレート制限の保存先', () => {
  it('窓の中で上限までは通し、超えたら止める', async () => {
    const c = clock();
    const storage = new MemoryRateLimitStorage({ now: c.now });
    for (let i = 1; i <= 3; i++) {
      const r = await storage.increment('k', TTL, 3, TTL, 'default');
      expect(r.totalHits).toBe(i);
      expect(r.isBlocked).toBe(false);
    }
    const over = await storage.increment('k', TTL, 3, TTL, 'default');
    expect(over.isBlocked).toBe(true);
    expect(over.timeToBlockExpire).toBe(60);
  });

  // ガードは残り時間をそのまま Retry-After に入れる。HTTP の Retry-After は秒であり、
  // Redis の保存先（@nest-lab/throttler-storage-redis）も同梱の保存先も秒（切り上げ）で返す。
  it('残り時間は秒（切り上げ）で返す', async () => {
    const c = clock();
    const storage = new MemoryRateLimitStorage({ now: c.now });
    await storage.increment('k', TTL, 3, TTL, 'default');
    c.advance(10_500);
    const r = await storage.increment('k', TTL, 3, TTL, 'default');
    expect(r.timeToExpire).toBe(50);
  });

  it('止めている時間が過ぎたら、数え直す', async () => {
    const c = clock();
    const storage = new MemoryRateLimitStorage({ now: c.now });
    for (let i = 0; i < 4; i++) await storage.increment('k', TTL, 3, TTL, 'default');
    c.advance(TTL);
    const r = await storage.increment('k', TTL, 3, TTL, 'default');
    expect(r.isBlocked).toBe(false);
    expect(r.totalHits).toBe(1);
  });

  it('窓が過ぎたら、止めていなくても数え直す', async () => {
    const c = clock();
    const storage = new MemoryRateLimitStorage({ now: c.now });
    await storage.increment('k', TTL, 3, TTL, 'default');
    await storage.increment('k', TTL, 3, TTL, 'default');
    c.advance(TTL);
    expect((await storage.increment('k', TTL, 3, TTL, 'default')).totalHits).toBe(1);
  });

  it('キーと制限の名前ごとに別々に数える', async () => {
    const c = clock();
    const storage = new MemoryRateLimitStorage({ now: c.now });
    for (let i = 0; i < 4; i++) await storage.increment('a', TTL, 3, TTL, 'default');
    expect((await storage.increment('b', TTL, 3, TTL, 'default')).isBlocked).toBe(false);
    expect((await storage.increment('a', TTL, 3, TTL, 'other')).isBlocked).toBe(false);
  });

  // 止まっている間に発信元を変えながら叩かれても、メモリが増え続けないこと（0.5 GB のタスク。tech-stack.md）。
  it('期限の切れた記録は片づける', async () => {
    const c = clock();
    const storage = new MemoryRateLimitStorage({ now: c.now });
    for (let i = 0; i < 100; i++) await storage.increment(`ip-${i}`, TTL, 3, TTL, 'default');
    expect(storage.size).toBe(100);
    c.advance(TTL + 60_000);
    await storage.increment('later', TTL, 3, TTL, 'default');
    expect(storage.size).toBe(1);
  });

  // 片づけても入りきらないほど記録が増えたら、新しい発信元は止める（メモリを守る側に倒す）。
  // 既に数えている発信元は、そのまま数え続ける。
  it('記録の数が上限に達したら、新しいキーは止め、既にあるキーは数え続ける', async () => {
    const c = clock();
    const storage = new MemoryRateLimitStorage({ now: c.now, maxEntries: 2 });
    await storage.increment('a', TTL, 3, TTL, 'default');
    await storage.increment('b', TTL, 3, TTL, 'default');
    const fresh = await storage.increment('c', TTL, 3, TTL, 'default');
    expect(fresh.isBlocked).toBe(true);
    expect(storage.size).toBe(2);
    expect((await storage.increment('a', TTL, 3, TTL, 'default')).isBlocked).toBe(false);
  });
});
