import type { ThrottlerStorage } from '@nestjs/throttler';

type StorageRecord = Awaited<ReturnType<ThrottlerStorage['increment']>>;

export interface ResilientRateLimitStorageOptions {
  /** api のタスク数。メモリで数えるときに上限を割る（API_TASK_COUNT）。 */
  taskCount: number;
  /** Valkey が失敗した後、試し直すまでの間隔。 */
  retryIntervalMs: number;
  now?: () => number;
  logger: { warn(message: string): void; log(message: string): void };
}

/**
 * レート制限の状態を Valkey に置き、**Valkey が止まっている間は各タスクのメモリで数える**（決定・2026-09-11・依頼側）。
 *
 * - **止めない。** Valkey の障害をそのまま登録・ログインの停止にしない
 * - **メモリで数える間は、上限をタスク数で割る。** ALB が要求をタスクに振り分けるため、割らないと
 *   攻撃側から見た上限が「上限 × タスク数」になる
 * - **失敗した後 `retryIntervalMs` の間は Valkey を試さない。** 要求のたびに失敗を待たされないようにする
 * - **切り替えたときと戻ったときにだけログを出す。** 要求ごとに出すとあふれる。キー（発信元から作る）は出さない
 *
 * **代償**: 切り替えた時点で数はゼロから数え直しになる（Valkey の回数はメモリへ引き継がない）。
 */
export class ResilientRateLimitStorage implements ThrottlerStorage {
  private readonly now: () => number;
  private degradedUntil = 0;
  private degraded = false;

  constructor(
    private readonly primary: ThrottlerStorage,
    private readonly fallback: ThrottlerStorage,
    private readonly options: ResilientRateLimitStorageOptions,
  ) {
    this.now = options.now ?? Date.now;
  }

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<StorageRecord> {
    if (this.degraded && this.now() < this.degradedUntil) {
      return this.fromFallback(key, ttl, limit, blockDuration, throttlerName);
    }
    try {
      const record = await this.primary.increment(key, ttl, limit, blockDuration, throttlerName);
      if (this.degraded) {
        this.degraded = false;
        this.options.logger.log('Valkey に戻ったため、レート制限を Valkey で数える');
      }
      return record;
    } catch (error) {
      if (!this.degraded) {
        this.options.logger.warn(
          `Valkey に書けないため、レート制限を各タスクのメモリで数える（上限はタスク数 ${this.options.taskCount} で割る）: ${describe(error)}`,
        );
      }
      this.degraded = true;
      this.degradedUntil = this.now() + this.options.retryIntervalMs;
      return this.fromFallback(key, ttl, limit, blockDuration, throttlerName);
    }
  }

  private async fromFallback(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<StorageRecord> {
    const perTaskLimit = Math.max(1, Math.floor(limit / this.options.taskCount));
    return this.fallback.increment(key, ttl, perTaskLimit, blockDuration, throttlerName);
  }
}

/** 失敗の種類だけを書く。メッセージには接続先が入りうるため、code があればそれを使う。 */
function describe(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code ?? error.name;
  }
  return 'unknown';
}
