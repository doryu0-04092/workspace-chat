import { Controller, Get } from '@nestjs/common';
import type { paths } from '@workspace-chat/shared';
import { Public } from './auth/access-token.guard';

/**
 * 死活確認（F-39）。ALB のヘルスチェックが叩く。
 *
 * **認証を要さない**——応答は稼働していることだけであり、アプリケーションの内容を返さないため、
 * 「非ログインでの閲覧」には当たらない（要件定義書 2）。
 * **DB・Redis 等に問い合わせない**（浅い死活確認。代償は機能一覧 14.1）——依存を注入しない。
 *
 * 応答の型は REST の仕様（packages/shared/openapi/openapi.yaml）から生成したものを使う（要件定義書 4.7）。
 * **型は `paths` から、パス・メソッド・状態コード・メディア型を辿って引く。** スキーマ（`components`）を
 * 直接指すと、仕様側で応答の参照先を替えても型検査が落ちない。
 * **型では縛れないもの**（生成物は `servers` を持たず、`paths` のキーは前置きを含まない）:
 * - デコレーター（`@Get('health')`）が実際にそのパス・メソッドで登録されることと、実際に返す状態コード
 *   → health.test.ts が実際に叩いて見る
 * - 仕様の `servers`（前置き `/api`）と createApp の前置きが一致すること
 *   → 要求の検証（openapi-validation.ts）が `servers` を読んでパスを突き合わせるため、ずれると
 *   `/api` の下の要求が検証を通らなくなり、openapi-validation.test.ts と auth/register.test.ts が落ちる
 */
@Public()
@Controller()
export class HealthController {
  @Get('health')
  health(): paths['/health']['get']['responses'][200]['content']['application/json'] {
    return { status: 'ok' };
  }
}
