import type { INestApplication, NestApplicationOptions } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { bodyReadErrorHandler } from './body-read-error';
import { resolveApiConfig } from './config/api-config';

/**
 * アプリを組み立てる入口を1つに置く。**main.ts とテストはどちらも createApp を通す**
 * （main.ts は読み込むと起動処理が走るため、テストからは呼べない）。
 * 設定をここの外で個別に当てると、本番の起動だけで当て忘れてもテストが落ちない。
 *
 * **踏むと壊れる: 全ルートの前置きは `/api` である**（#77 の決定）。
 * CloudFront は `/api/*` だけを ALB へ振り分け、それ以外は静的配信のバケットへ向かう。
 * `/api` の外にルートを置くと ALB に届かず、アプリ側のログには何も出ない。
 * 外すと health.test.ts が落ちる。
 *
 * **発信元（`req.ip`）は `trust proxy` で決まる**（段数は TRUST_PROXY_HOPS。rate-limit-config.ts）。
 * レート制限はこれで数えるため、段数を誤ると偽の発信元を名乗られるか、全員が1つの発信元として数えられる。
 *
 * **踏むと壊れる: 本体の読み取りは Nest の既定（`bodyParser`）を切り、JSON だけを読み、その直後に
 * body-read-error.ts を置く。** 既定に戻すと、壊れた JSON の失敗のメッセージ（入力の断片を含む）が応答に出る。
 * 受け付ける本体は仕様どおり JSON だけである（urlencoded は読まない）。
 */
export async function createApp(options?: NestApplicationOptions): Promise<INestApplication> {
  // 起動を止める設定の検証は、アプリを組み立てる前にすべて済ませる（main.ts の PORT と同じ。config/api-config.ts）。
  // 後に置くと、Prisma と Valkey への接続を一通り試してから落ちる。
  const config = resolveApiConfig(process.env);
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(config), {
    ...options,
    bodyParser: false,
  });
  app.useBodyParser('json');
  app.use(bodyReadErrorHandler);
  app.setGlobalPrefix('api');
  app.set('trust proxy', config.trustProxyHops);
  return app;
}
