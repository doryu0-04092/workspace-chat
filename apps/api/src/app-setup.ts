import type { INestApplication, NestApplicationOptions } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

/**
 * アプリを組み立てる入口を1つに置く。**main.ts とテストはどちらも createApp を通す**
 * （main.ts は読み込むと起動処理が走るため、テストからは呼べない）。
 * 設定をここの外で個別に当てると、本番の起動だけで当て忘れてもテストが落ちない。
 *
 * **踏むと壊れる: 全ルートの前置きは `/api` である**（#77 の決定）。
 * CloudFront は `/api/*` だけを ALB へ振り分け、それ以外は静的配信のバケットへ向かう。
 * `/api` の外にルートを置くと ALB に届かず、アプリ側のログには何も出ない。
 * 外すと health.test.ts が落ちる。
 */
export async function createApp(options?: NestApplicationOptions): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule, options);
  app.setGlobalPrefix('api');
  return app;
}
