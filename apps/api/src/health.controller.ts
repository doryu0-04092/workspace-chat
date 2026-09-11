import { Controller, Get } from '@nestjs/common';
import type { components } from '@workspace-chat/shared';

/**
 * 死活確認（F-39）。ALB のヘルスチェックが叩く。
 *
 * **認証を要さない**——応答は稼働していることだけであり、アプリケーションの内容を返さないため、
 * 「非ログインでの閲覧」には当たらない（要件定義書 2）。
 * **DB・Redis 等に問い合わせない**（浅い死活確認。代償は機能一覧 14.1）——依存を注入しない。
 *
 * 応答の型は REST の仕様（packages/shared/openapi/openapi.yaml）から生成したものを使う。
 * 仕様と食い違うと型検査で落ちる（要件定義書 4.7）。
 */
@Controller()
export class HealthController {
  @Get('health')
  health(): components['schemas']['HealthResponse'] {
    return { status: 'ok' };
  }
}
