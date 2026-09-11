import type { ThrottlerStorage } from '@nestjs/throttler';

type StorageRecord = Awaited<ReturnType<ThrottlerStorage['increment']>>;
type Entry = { hits: number; expiresAt: number; blockedUntil: number };

function seconds(ms: number): number {
  return Math.ceil(ms / 1000);
}

/** 期限の切れた記録を片づける間隔。要求のついでに行い、タイマーは持たない。 */
const SWEEP_INTERVAL_MS = 60_000;
/** 記録の数の上限。1件あたり数百バイトとして、0.5 GB のタスク（tech-stack.md）で数十 MB に収める。 */
const DEFAULT_MAX_ENTRIES = 50_000;

/**
 * 各タスクのメモリで数えるレート制限の保存先。**Valkey が止まっている間だけ使う**（resilient-rate-limit-storage.ts）。
 *
 * **数え方は Redis の保存先（@nest-lab/throttler-storage-redis の Lua）と同じ固定窓にし、残り時間は秒（切り上げ）で返す**
 * （Redis の保存先も同梱の保存先も秒で返す。ガードはこの値をそのまま Retry-After に入れる）。
 * 切り替えの前後で、止める・通すの判定と単位が変わらないようにするため。
 *
 * **@nestjs/throttler に同梱のメモリの保存先（ThrottlerStorageService）は使わない。** 記録を Map から消さず、
 * 要求1回ごとにタイマーを1つ作るため、止まっている間に発信元を変えながら叩かれるとメモリが増え続ける。
 * ここでは期限の切れた記録を片づけ、それでも上限に達したら新しい発信元を止める（メモリを守る側に倒す）。
 */
export class MemoryRateLimitStorage implements ThrottlerStorage {
  private readonly entries = new Map<string, Entry>();
  private readonly now: () => number;
  private readonly maxEntries: number;
  private lastSweep: number;

  constructor(options: { now?: () => number; maxEntries?: number } = {}) {
    this.now = options.now ?? Date.now;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.lastSweep = this.now();
  }

  /** 保持している記録の数（テストで片づけを確かめるため）。 */
  get size(): number {
    return this.entries.size;
  }

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<StorageRecord> {
    const t = this.now();
    this.sweep(t);
    const id = `${key}:${throttlerName}`;
    let entry = this.entries.get(id);

    if (!entry) {
      if (this.entries.size >= this.maxEntries) {
        return {
          totalHits: limit + 1,
          timeToExpire: seconds(ttl),
          isBlocked: true,
          timeToBlockExpire: seconds(blockDuration),
        };
      }
      entry = { hits: 0, expiresAt: t + ttl, blockedUntil: 0 };
      this.entries.set(id, entry);
    }

    // 止めている時間が過ぎたら数え直す（Lua の「isBlocked and timeToBlockExpire <= 0」と同じ）。
    if (entry.blockedUntil !== 0 && entry.blockedUntil <= t) {
      entry.hits = 0;
      entry.expiresAt = t + ttl;
      entry.blockedUntil = 0;
    }
    if (entry.expiresAt <= t) {
      entry.hits = 0;
      entry.expiresAt = t + ttl;
    }

    entry.hits += 1;
    if (entry.blockedUntil === 0 && entry.hits > limit) {
      entry.blockedUntil = t + blockDuration;
    }
    const isBlocked = entry.blockedUntil > t;
    return {
      totalHits: entry.hits,
      timeToExpire: seconds(entry.expiresAt - t),
      isBlocked,
      timeToBlockExpire: isBlocked ? seconds(entry.blockedUntil - t) : 0,
    };
  }

  private sweep(t: number): void {
    if (t - this.lastSweep < SWEEP_INTERVAL_MS) return;
    this.lastSweep = t;
    for (const [id, entry] of this.entries) {
      if (entry.expiresAt <= t && entry.blockedUntil <= t) this.entries.delete(id);
    }
  }
}
