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
 * **組み立てに要る設定を足すときは、この型と下の API_SETTINGS に足す**（API_SETTINGS に行が無いと型検査で落ちる）。
 * PORT は組み立てに要らず（listen だけが使う）、bootstrap.ts が組み立ての前に別に検証する——
 * **PORT と他の設定が同時に不正なら、PORT だけを先に知らせる。**
 */
export interface ApiConfig {
  readonly databaseUrl: string;
  readonly redisUrl: string;
  readonly trustProxyHops: number;
  readonly apiTaskCount: number;
  readonly registrationEnabled: boolean;
  readonly jwtSecret: string;
  readonly webOrigin: string;
}

/** ApiConfig を注入するトークン。 */
export const API_CONFIG = Symbol('API_CONFIG');

/** JWT_SECRET の下限（バイト）。RFC 7518 3.2: HS256 の鍵はハッシュの出力（256 ビット）以上でなければならない（MUST）。 */
const JWT_SECRET_MIN_BYTES = 32;

/**
 * アクセストークン（HS256）の署名の鍵。**必須。32 バイト未満は起動時に落とす。** 文字数ではなく UTF-8 のバイト数で数える。
 * **値は鍵そのものである**（API_SETTINGS で `secret: true`。不正なときのメッセージは集約が伏せる）。
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
 * web の origin（環境変数 `WEB_ORIGIN`。例: `https://chat.example.com`）。**必須。**
 * Cookie を使う要求の CSRF の対処で、Origin / Referer と突き合わせる（要件定義書 4.3。auth/same-origin.ts）。
 * **origin の形（スキーム://ホスト[:ポート]）でなければ起動時に落とす**——末尾の / やパスが付くと、ブラウザが送る Origin と
 * 一致せず、正規の要求がすべて 403 になる。
 */
export function resolveWebOrigin(raw: string | undefined): string {
  if (raw === undefined || raw === '') {
    throw new Error(
      'WEB_ORIGIN が設定されていません（web の origin。例: https://chat.example.com）',
    );
  }
  let url: URL | undefined;
  try {
    url = new URL(raw);
  } catch {
    url = undefined;
  }
  if (
    url === undefined ||
    (url.protocol !== 'https:' && url.protocol !== 'http:') ||
    url.origin !== raw
  ) {
    throw new Error(
      `WEB_ORIGIN の値が不正です（スキーム://ホスト[:ポート] の形で、末尾の / やパスを付けない）: ${JSON.stringify(raw)}`,
    );
  }
  return raw;
}

/**
 * 設定1つの読み方。**`secret` はすべての行に必ず書く**（書かないと型検査で落ちる）——値に秘密（資格情報・鍵）が入るなら
 * `secret: true` と、不正なときに代わりに示す `hint` を書く。
 */
type Setting<T> = {
  readonly env: string;
  readonly resolve: (raw: string | undefined) => T;
} & ({ readonly secret: false } | { readonly secret: true; readonly hint: string });

export type ApiSettings = { readonly [K in keyof ApiConfig]: Setting<ApiConfig[K]> };

export const API_SETTINGS: ApiSettings = {
  databaseUrl: {
    env: 'DATABASE_URL',
    resolve: resolveDatabaseUrl,
    secret: true,
    hint: '接続 URL を渡す',
  },
  redisUrl: {
    env: 'REDIS_URL',
    resolve: resolveRedisUrl,
    secret: true,
    hint: 'Valkey の接続 URL を渡す',
  },
  trustProxyHops: { env: 'TRUST_PROXY_HOPS', resolve: resolveTrustProxyHops, secret: false },
  apiTaskCount: { env: 'API_TASK_COUNT', resolve: resolveApiTaskCount, secret: false },
  registrationEnabled: {
    env: 'REGISTRATION_ENABLED',
    resolve: resolveRegistrationEnabled,
    secret: false,
  },
  jwtSecret: {
    env: 'JWT_SECRET',
    resolve: resolveJwtSecret,
    secret: true,
    hint: `${JWT_SECRET_MIN_BYTES} バイト以上の乱数を渡す`,
  },
  webOrigin: { env: 'WEB_ORIGIN', resolve: resolveWebOrigin, secret: false },
};

/**
 * 環境変数から ApiConfig を組み立てる。**不正な設定が複数あれば、すべてを1つの例外で知らせる**
 * （1つ直して起動し直すたびに次が見つかる形にしない）。
 *
 * **`secret: true` の設定は、値が空でないのに不正なら resolve 関数のメッセージを使わず、名前と hint だけを出す。**
 * 起動の失敗はログに出る。resolve 関数が値をメッセージに埋めても（`… の値が不正です: ${raw}` はこのコードベースの
 * 他の設定の書き方である）漏れないよう、伏せるのは集約の側で行う。`settings` はテストで差し替えるためにある。
 */
export function resolveApiConfig(
  env: Readonly<Record<string, string | undefined>>,
  settings: ApiSettings = API_SETTINGS,
): ApiConfig {
  const problems: string[] = [];
  const config: Record<string, unknown> = {};
  for (const [key, setting] of Object.entries(settings) as [string, Setting<unknown>][]) {
    const raw = env[setting.env];
    try {
      config[key] = setting.resolve(raw);
    } catch (error) {
      problems.push(
        setting.secret && raw !== undefined && raw !== ''
          ? `${setting.env} の値が不正です（${setting.hint}。値は秘密を含むため載せない）`
          : error instanceof Error
            ? error.message
            : String(error),
      );
    }
  }
  if (problems.length > 0) {
    throw new Error(`起動の設定が不正です:\n${problems.join('\n')}`);
  }
  return config as unknown as ApiConfig;
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
