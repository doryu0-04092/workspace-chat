import { Controller, Get } from '@nestjs/common';

/**
 * 死活確認（F-39）。ALB のヘルスチェックが叩く。
 *
 * **認証を要さない**——応答は稼働していることだけであり、アプリケーションの内容を返さないため、
 * 「非ログインでの閲覧」には当たらない（要件定義書 2）。
 * **DB・Redis 等に問い合わせない**（浅い死活確認。代償は機能一覧 14.1）——依存を注入しない。
 */
@Controller()
export class HealthController {
  @Get('health')
  health(): { status: 'ok' } {
    return { status: 'ok' };
  }
}
