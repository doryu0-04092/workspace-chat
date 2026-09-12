import type Redis from 'ioredis';

/**
 * アカウント単位の制限: **連続して失敗した回数 n に対し、2^(n-1) 秒（上限 15 分）の間は照合しない**
 * （機能一覧 1.2。決定・2026-09-11・依頼側。1.1 のリカバリーコードの照合にも当てる）。OWASP Authentication Cheat Sheet の
 * 「the lockout duration starts as a very short period (e.g., one second), but doubles after each failed login attempt」。
 *
 * 締め出し（一定回数でアカウントを止める）を採らないのは、他人がパスワードを誤り続けるだけで本人を締め出せるため。
 * **代償**: 他人が失敗を送り続けると、本人も待たされる（最大 15 分）。上限に達した後は 15 分に1回、1日およそ 96 回まで試せる。
 *
 * キーは accountBackoffKey で作る。**存在しない ID も同じに数える**
 * ——存在する ID だけを止めると、止まるかどうかで登録済みの ID を調べられる。
 */

/** アカウント単位の制限を掛ける用途（ログイン・リカバリーコードの照合。機能一覧 1.1・1.2）。 */
export type AccountBackoffPurpose = 'login' | 'recovery';

/**
 * アカウント単位の制限のキー。**用途ごとに前置きを分ける**——同じキーで数えると、一方の失敗で他方も待たされる。
 * **例外は一方向に1つだけ**: リカバリーコードによる再設定の成功は、`login` の回数も数え直す（機能一覧 1.1・1.2。#280）。
 * ユーザーID は小文字にする（大文字小文字を区別しない照合に合わせる）。
 */
export function accountBackoffKey(purpose: AccountBackoffPurpose, userId: string): string {
  return `${purpose}:${userId.toLowerCase()}`;
}

/** 待ち時間の上限（15 分）。 */
export const LOGIN_BACKOFF_MAX_MS = 15 * 60 * 1000;
/** 最後の失敗からこの時間が経ったら数え直す（24 時間）。 */
export const LOGIN_BACKOFF_RESET_MS = 24 * 60 * 60 * 1000;

/** 連続した失敗の回数に対する待ち時間（ms）。 */
export function backoffMs(failures: number): number {
  if (failures <= 0) return 0;
  // 2 ** (failures - 1) は failures が大きいと Infinity になるが、min で上限に収まる。
  return Math.min(2 ** (failures - 1) * 1000, LOGIN_BACKOFF_MAX_MS);
}

export type BeginResult = { allowed: true } | { allowed: false; retryAfterMs: number };

export interface LoginBackoffStore {
  /**
   * 照合を始めてよいか。**待ち時間が明けていれば、次の待ち時間まで他の試行を止める**（同時に送られた試行のうち
   * 照合に進むのは1つだけにする）。失敗が無い（または数え直した）ときは止めない。
   */
  begin(key: string, nowMs: number): Promise<BeginResult>;
  /** 照合に失敗した。 */
  recordFailure(key: string, nowMs: number): Promise<void>;
  /** 照合に成功した。数え直す。 */
  reset(key: string): Promise<void>;
}

/** `lastFailureMs` は数え直しの起点、`lastMs` は待ち時間の起点（最後の失敗か、照合へ通した時刻の遅い方）。 */
type Entry = { failures: number; lastFailureMs: number; lastMs: number };

/** 記録の数の上限。memory-rate-limit-storage.ts と同じ見積もり（1件あたり数百バイト）。 */
const DEFAULT_MAX_ENTRIES = 50_000;

/**
 * 各タスクのメモリの保存先。**Valkey が止まっている間だけ使う**（ResilientLoginBackoffStore）。
 *
 * **上限に達したら、最も古く触れた記録から捨てる。** 新しいキーを止める（memory-rate-limit-storage.ts の形）と、
 * 多数の ID を失敗させるだけで、止まっている間のすべての利用者のログインを止められる。
 * **代償**: 捨てられた ID は数え直しになる（止まっている間に 5 万を超える ID を失敗させる必要がある）。
 */
export class MemoryLoginBackoffStore implements LoginBackoffStore {
  private readonly entries = new Map<string, Entry>();
  private readonly maxEntries: number;

  constructor(options: { maxEntries?: number } = {}) {
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  /** 保持している記録の数（テストで上限を確かめるため）。 */
  get size(): number {
    return this.entries.size;
  }

  async begin(key: string, nowMs: number): Promise<BeginResult> {
    const entry = this.entries.get(key);
    if (!entry) return { allowed: true };
    if (nowMs - entry.lastFailureMs >= LOGIN_BACKOFF_RESET_MS) {
      this.entries.delete(key);
      return { allowed: true };
    }
    const until = entry.lastMs + backoffMs(entry.failures);
    if (nowMs < until) return { allowed: false, retryAfterMs: until - nowMs };
    entry.lastMs = nowMs;
    return { allowed: true };
  }

  async recordFailure(key: string, nowMs: number): Promise<void> {
    const entry = this.entries.get(key);
    const failures =
      entry && nowMs - entry.lastFailureMs < LOGIN_BACKOFF_RESET_MS ? entry.failures + 1 : 1;
    // Map は挿入順を保つ。消してから入れ直し、最も新しく触れたものを末尾に置く。
    this.entries.delete(key);
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
    this.entries.set(key, { failures, lastFailureMs: nowMs, lastMs: nowMs });
  }

  async reset(key: string): Promise<void> {
    this.entries.delete(key);
  }
}

/**
 * 待ち時間が明けているかを見て、明けていれば次の試行を止める（予約する）。**1つの Lua で行う**——読んでから書くまでの間に
 * 別のタスクの試行が割り込むと、同時に送られた試行がすべて照合に進む。
 * 戻り値は待つ残りの ms（0 なら通す）。
 */
const BEGIN_SCRIPT = `
local failures = tonumber(redis.call('HGET', KEYS[1], 'failures') or '0')
if failures == 0 then return 0 end
local now = tonumber(ARGV[1])
local lastFailure = tonumber(redis.call('HGET', KEYS[1], 'lastFailure') or '0')
if now - lastFailure >= tonumber(ARGV[3]) then
  redis.call('DEL', KEYS[1])
  return 0
end
local last = tonumber(redis.call('HGET', KEYS[1], 'last') or '0')
local wait = math.min(2 ^ (failures - 1) * 1000, tonumber(ARGV[2]))
if now < last + wait then return last + wait - now end
redis.call('HSET', KEYS[1], 'last', ARGV[1])
return 0
`;

const FAILURE_SCRIPT = `
local now = tonumber(ARGV[1])
local lastFailure = tonumber(redis.call('HGET', KEYS[1], 'lastFailure') or '0')
if now - lastFailure >= tonumber(ARGV[2]) then redis.call('HDEL', KEYS[1], 'failures') end
redis.call('HINCRBY', KEYS[1], 'failures', 1)
redis.call('HSET', KEYS[1], 'last', ARGV[1], 'lastFailure', ARGV[1])
redis.call('PEXPIRE', KEYS[1], ARGV[2])
return 0
`;

/** キーの前置き。Valkey の他の用途（レート制限・配信）と混ざらないようにする。 */
const KEY_PREFIX = 'login-backoff:';

/** Valkey の保存先。**全タスクで同じ回数を数える**（本番の既定）。時刻は呼ぶ側が渡す（タスクの時計は NTP で揃う前提）。 */
export class ValkeyLoginBackoffStore implements LoginBackoffStore {
  constructor(private readonly client: Redis) {}

  async begin(key: string, nowMs: number): Promise<BeginResult> {
    const wait = Number(
      await this.client.eval(
        BEGIN_SCRIPT,
        1,
        KEY_PREFIX + key,
        nowMs,
        LOGIN_BACKOFF_MAX_MS,
        LOGIN_BACKOFF_RESET_MS,
      ),
    );
    return wait > 0 ? { allowed: false, retryAfterMs: wait } : { allowed: true };
  }

  async recordFailure(key: string, nowMs: number): Promise<void> {
    await this.client.eval(FAILURE_SCRIPT, 1, KEY_PREFIX + key, nowMs, LOGIN_BACKOFF_RESET_MS);
  }

  async reset(key: string): Promise<void> {
    await this.client.del(KEY_PREFIX + key);
  }
}

export interface ResilientLoginBackoffStoreOptions {
  /** Valkey が失敗した後、試し直すまでの間隔。 */
  retryIntervalMs: number;
  now?: () => number;
  logger: { warn(message: string): void; log(message: string): void };
}

/**
 * 回数を Valkey に置き、**Valkey が止まっている間は各タスクのメモリで数える**（レート制限と同じ決定・2026-09-11・依頼側。
 * resilient-rate-limit-storage.ts）。切り替えたときと戻ったときにだけログを出し、キー（ユーザーID）は出さない。
 *
 * **代償**: 切り替えた時点で回数はゼロから数え直しになる。メモリで数える間は、ALB がタスクに振り分けるため、
 * 同じ待ち時間の間に照合へ進める回数がタスク数まで増える。
 */
export class ResilientLoginBackoffStore implements LoginBackoffStore {
  private readonly now: () => number;
  private degradedUntil = 0;
  private degraded = false;

  constructor(
    private readonly primary: LoginBackoffStore,
    private readonly fallback: LoginBackoffStore,
    private readonly options: ResilientLoginBackoffStoreOptions,
  ) {
    this.now = options.now ?? Date.now;
  }

  begin(key: string, nowMs: number): Promise<BeginResult> {
    return this.run((store) => store.begin(key, nowMs));
  }

  recordFailure(key: string, nowMs: number): Promise<void> {
    return this.run((store) => store.recordFailure(key, nowMs));
  }

  reset(key: string): Promise<void> {
    return this.run((store) => store.reset(key));
  }

  private async run<T>(operation: (store: LoginBackoffStore) => Promise<T>): Promise<T> {
    if (this.degraded && this.now() < this.degradedUntil) {
      return operation(this.fallback);
    }
    try {
      const result = await operation(this.primary);
      if (this.degraded) {
        this.degraded = false;
        this.options.logger.log(
          'Valkey に戻ったため、アカウント単位の失敗の回数を Valkey で数える',
        );
      }
      return result;
    } catch (error) {
      if (!this.degraded) {
        this.options.logger.warn(
          `Valkey に書けないため、アカウント単位の失敗の回数を各タスクのメモリで数える: ${describe(error)}`,
        );
      }
      this.degraded = true;
      this.degradedUntil = this.now() + this.options.retryIntervalMs;
      return operation(this.fallback);
    }
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
