import type { INestApplication } from '@nestjs/common';

/**
 * 起動時にアプリへ当てる設定を1箇所に置く。main.ts とテストの両方がこれを通す
 * （main.ts は読み込むと起動処理が走るため、テストからは呼べない）。
 *
 * **踏むと壊れる: 全ルートの前置きは `/api` である**（#77 の決定）。
 * CloudFront は `/api/*` だけを ALB へ振り分け、それ以外は静的配信のバケットへ向かう。
 * `/api` の外にルートを置くと ALB に届かず、アプリ側のログには何も出ない。
 * 外すと health.test.ts の「前置きの無いパスでは届かない」が落ちる。
 */
export function configureApp(app: INestApplication): void {
  app.setGlobalPrefix('api');
}
