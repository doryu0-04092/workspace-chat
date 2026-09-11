import {
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  Module,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import Redis from 'ioredis';
import { MemoryRateLimitStorage } from './memory-rate-limit-storage';
import { resolveApiTaskCount, resolveRedisUrl } from './rate-limit-config';
import { ResilientRateLimitStorage } from './resilient-rate-limit-storage';

/** Valkey（ElastiCache for Valkey / ローカルは compose の redis）への接続を注入するトークン。 */
export const VALKEY_CLIENT = Symbol('VALKEY_CLIENT');

/** Valkey が失敗した後、試し直すまでの間隔。 */
const VALKEY_RETRY_INTERVAL_MS = 30_000;
/** 起動時に Valkey の準備を待つ上限。応答の無い宛先で起動が止まらないようにする。 */
const VALKEY_READY_TIMEOUT_MS = 3_000;

/**
 * ioredis の接続。**止まっているときにすぐ失敗させる**——既定では接続が切れている間のコマンドを溜めて
 * 再接続を待つため、止まっている間の要求が詰まる。
 * - `enableOfflineQueue: false`: 繋がっていなければ、溜めずにすぐ失敗させる
 * - `commandTimeout`: 繋がっていても返らないときに打ち切る
 * - `maxRetriesPerRequest: 0`: 1つのコマンドを再送しない
 * 再接続そのものは ioredis が裏で続ける。**`error` を受ける処理を必ず付ける**（無いと未処理の error でプロセスが落ちる）。
 */
async function createValkeyClient(logger: Logger): Promise<Redis> {
  const client = new Redis(resolveRedisUrl(process.env.REDIS_URL), {
    enableOfflineQueue: false,
    commandTimeout: 500,
    maxRetriesPerRequest: 0,
  });
  // 切り替えのログは ResilientRateLimitStorage が出す。ここでは接続の失敗を黙って受けるだけにする
  // （再接続のたびに出るため、ここで出すとあふれる）。
  client.on('error', () => undefined);
  // **準備が済むまで待ってから受け付ける。** `enableOfflineQueue: false` のため、接続の途中（connecting）に来た要求は
  // 失敗し、そこから VALKEY_RETRY_INTERVAL_MS の間はメモリで数えることになる（起動直後の要求で実測した）。
  // 失敗（接続の拒否など）が先に来たら待たずに起動し、メモリへの迂回に任せる。
  const ready = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), VALKEY_READY_TIMEOUT_MS);
    timer.unref();
    client.once('ready', () => {
      clearTimeout(timer);
      resolve(true);
    });
    client.once('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
  if (ready) {
    logger.log('Valkey に接続した');
  } else {
    logger.warn('Valkey に接続できないまま起動する（レート制限は各タスクのメモリで数える）');
  }
  return client;
}

@Injectable()
class ValkeyClientCloser implements OnApplicationShutdown {
  constructor(private readonly client: Redis) {}
  onApplicationShutdown(): void {
    this.client.disconnect();
  }
}

/** 下の RateLimitModule が imports で参照するため、先に宣言する（クラスの宣言は巻き上げられない）。 */
@Module({
  providers: [
    {
      provide: VALKEY_CLIENT,
      useFactory: () => createValkeyClient(new Logger('Valkey')),
    },
    {
      provide: ValkeyClientCloser,
      inject: [VALKEY_CLIENT],
      useFactory: (client: Redis) => new ValkeyClientCloser(client),
    },
  ],
  exports: [VALKEY_CLIENT],
})
export class ValkeyModule {}

/**
 * 超過したときの応答を ErrorResponse の形（`code` / `message`）にする。
 * `Retry-After` はガードが先に付ける（名前が `default` の制限なので、ヘッダー名は `Retry-After` のまま）。
 */
@Injectable()
export class RateLimitGuard extends ThrottlerGuard {
  protected override async throwThrottlingException(): Promise<void> {
    throw new HttpException(
      {
        code: 'too_many_requests',
        message: '要求が多すぎます。しばらく待ってからやり直してください',
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}

/**
 * レート制限（要件定義書 4.3・機能一覧 1.1）。**ガードは全体には掛けない。** 使う側が `@UseGuards(RateLimitGuard)` と
 * `@Throttle({ default: … })` で、ルートごとに上限を決める（登録・ログイン・照合で数値が違うため）。
 * 発信元は `req.ip`（Express の `trust proxy`。app-setup.ts が TRUST_PROXY_HOPS から設定する）。
 */
@Module({
  imports: [
    ThrottlerModule.forRootAsync({
      imports: [ValkeyModule],
      inject: [VALKEY_CLIENT],
      useFactory: (client: Redis) => ({
        // ルートが @Throttle を付け忘れたときの値。付け忘れても無制限にはしない。
        throttlers: [{ name: 'default', ttl: 60_000, limit: 10 }],
        storage: new ResilientRateLimitStorage(
          new ThrottlerStorageRedisService(client),
          new MemoryRateLimitStorage(),
          {
            taskCount: resolveApiTaskCount(process.env.API_TASK_COUNT),
            retryIntervalMs: VALKEY_RETRY_INTERVAL_MS,
            logger: new Logger('RateLimit'),
          },
        ),
      }),
    }),
  ],
  providers: [RateLimitGuard],
  exports: [RateLimitGuard],
})
export class RateLimitModule {}
