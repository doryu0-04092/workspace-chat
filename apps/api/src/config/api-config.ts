import { type DynamicModule, Module } from '@nestjs/common';
import { resolveRegistrationEnabled } from '../auth/registration-enabled';
import {
  resolveApiTaskCount,
  resolveRedisUrl,
  resolveTrustProxyHops,
} from '../rate-limit/rate-limit-config';

/**
 * api の起動に要る設定。**環境変数はここで1回だけ読み、組み立ての前にすべて検証する**（createApp）。
 * モジュールは `process.env` を読まず、`API_CONFIG` を注入して使う。
 * 起動を止める設定を足すときは、この型と resolveApiConfig に足す（PORT は listen にしか使わず、bootstrap が読む）。
 */
export interface ApiConfig {
  readonly databaseUrl: string;
  readonly redisUrl: string;
  readonly trustProxyHops: number;
  readonly apiTaskCount: number;
  readonly registrationEnabled: boolean;
  readonly jwtSecret: string;
}

/** ApiConfig を注入するトークン。 */
export const API_CONFIG = Symbol('API_CONFIG');

/**
 * DB の接続先を決める。**未設定・空は起動時に落とす。**
 * 見逃すと最初の問い合わせで原因の分かりにくいエラーになる。
 * **例外のメッセージに値を載せない**——接続先には資格情報が入り、起動の失敗はログに出る。
 */
export function resolveDatabaseUrl(raw: string | undefined): string {
  if (raw === undefined || raw === '') {
    throw new Error(
      'DATABASE_URL が設定されていません（開発用データベースの接続 URL を環境変数で渡す）',
    );
  }
  return raw;
}

/** JWT_SECRET の下限（バイト）。RFC 7518 3.2: HS256 の鍵はハッシュの出力（256 ビット）以上でなければならない（MUST）。 */
const JWT_SECRET_MIN_BYTES = 32;

/**
 * アクセストークン（HS256）の署名の鍵。**必須。32 バイト未満は起動時に落とす。**
 * 文字数ではなく UTF-8 のバイト数で数える。**例外のメッセージに値を載せない**（鍵そのものである）。
 */
export function resolveJwtSecret(raw: string | undefined): string {
  if (raw === undefined || raw === '') {
    throw new Error(
      `JWT_SECRET が設定されていません（アクセストークンの署名の鍵。${JWT_SECRET_MIN_BYTES} バイト以上の乱数を渡す）`,
    );
  }
  if (Buffer.byteLength(raw, 'utf8') < JWT_SECRET_MIN_BYTES) {
    throw new Error(`JWT_SECRET が短すぎます（${JWT_SECRET_MIN_BYTES} バイト以上を渡す）`);
  }
  return raw;
}

/**
 * 環境変数から ApiConfig を組み立てる。**不正な設定が複数あれば、すべてを1つの例外で知らせる**
 * （1つ直して起動し直すたびに次が見つかる形にしない）。
 * メッセージは各 resolve 関数のものをそのまま並べる（接続先の値を載せないのは各関数が守る）。
 */
export function resolveApiConfig(env: Readonly<Record<string, string | undefined>>): ApiConfig {
  const problems: string[] = [];
  const read = <T>(resolve: () => T): T => {
    try {
      return resolve();
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
      return undefined as T;
    }
  };
  const config: ApiConfig = {
    databaseUrl: read(() => resolveDatabaseUrl(env.DATABASE_URL)),
    redisUrl: read(() => resolveRedisUrl(env.REDIS_URL)),
    trustProxyHops: read(() => resolveTrustProxyHops(env.TRUST_PROXY_HOPS)),
    apiTaskCount: read(() => resolveApiTaskCount(env.API_TASK_COUNT)),
    registrationEnabled: read(() => resolveRegistrationEnabled(env.REGISTRATION_ENABLED)),
    jwtSecret: read(() => resolveJwtSecret(env.JWT_SECRET)),
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
