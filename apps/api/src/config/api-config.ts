import { type DynamicModule, Module } from '@nestjs/common';
import { resolveRegistrationEnabled } from '../auth/registration-enabled';
import {
  resolveApiTaskCount,
  resolveRedisUrl,
  resolveTrustProxyHops,
} from '../rate-limit/rate-limit-config';
import { resolveDatabaseUrl } from './database-url';

/**
 * アプリの組み立てに要る設定。createApp が環境変数から resolveApiConfig で作り、組み立ての前にすべて検証する。
 * モジュールは `process.env` を読まず、`API_CONFIG` を注入して使う。
 * **組み立てに要る設定を足すときは、この型と resolveApiConfig に足す。** PORT は組み立てに要らず（listen だけが使う）、
 * bootstrap.ts が組み立ての前に別に検証する——**PORT と他の設定が同時に不正なら、PORT だけを先に知らせる。**
 */
export interface ApiConfig {
  readonly databaseUrl: string;
  readonly redisUrl: string;
  readonly trustProxyHops: number;
  readonly apiTaskCount: number;
  readonly registrationEnabled: boolean;
}

/** ApiConfig を注入するトークン。 */
export const API_CONFIG = Symbol('API_CONFIG');

/**
 * **値に秘密（資格情報・鍵）が入る設定と、不正なときに代わりに示す手がかり。** 起動の失敗はログに出るため、
 * 値が空でないのに不正なときは、resolve 関数のメッセージを使わずこの手がかりだけを出す——resolve 関数が値を
 * メッセージに埋めても（`… の値が不正です: ${raw}` はこのコードベースの他の設定の書き方である）漏れないようにする。
 */
const SECRET_SETTING_HINTS: Readonly<Record<string, string>> = {
  DATABASE_URL: '接続 URL を渡す',
  REDIS_URL: 'Valkey の接続 URL を渡す',
};

/**
 * 環境変数から ApiConfig を組み立てる。**不正な設定が複数あれば、すべてを1つの例外で知らせる**
 * （1つ直して起動し直すたびに次が見つかる形にしない）。
 */
export function resolveApiConfig(env: Readonly<Record<string, string | undefined>>): ApiConfig {
  const problems: string[] = [];
  const read = <T>(name: string, resolve: (raw: string | undefined) => T): T => {
    const raw = env[name];
    try {
      return resolve(raw);
    } catch (error) {
      const hint = SECRET_SETTING_HINTS[name];
      problems.push(
        hint !== undefined && raw !== undefined && raw !== ''
          ? `${name} の値が不正です（${hint}。値は秘密を含むため載せない）`
          : error instanceof Error
            ? error.message
            : String(error),
      );
      return undefined as T;
    }
  };
  const config: ApiConfig = {
    databaseUrl: read('DATABASE_URL', resolveDatabaseUrl),
    redisUrl: read('REDIS_URL', resolveRedisUrl),
    trustProxyHops: read('TRUST_PROXY_HOPS', resolveTrustProxyHops),
    apiTaskCount: read('API_TASK_COUNT', resolveApiTaskCount),
    registrationEnabled: read('REGISTRATION_ENABLED', resolveRegistrationEnabled),
  };
  if (problems.length > 0) {
    throw new Error(`起動の設定が不正です:\n${problems.join('\n')}`);
  }
  return config;
}

/** ApiConfig を全モジュールへ渡す（AppModule.forRoot が読み込む）。 */
@Module({})
export class ApiConfigModule {
  static forRoot(config: ApiConfig): DynamicModule {
    return {
      module: ApiConfigModule,
      global: true,
      providers: [{ provide: API_CONFIG, useValue: config }],
      exports: [API_CONFIG],
    };
  }
}
