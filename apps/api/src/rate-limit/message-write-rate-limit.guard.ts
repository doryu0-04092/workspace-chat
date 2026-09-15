import { type ExecutionContext, Injectable } from '@nestjs/common';
import { UserRateLimitGuard } from './user-rate-limit.guard';

/**
 * メッセージの書き込み（投稿・返信・編集・削除）を、**4つのルートで1つの枠**で数える利用者単位のレート制限
 * （提案・承認済・2026-09-13・依頼側。機能一覧 4.1・4.2。返信は投稿として数える。機能一覧 6）。
 *
 * `@nestjs/throttler` の既定のキーはクラス名とハンドラ名を含み、ルートごとに枠が分かれる。
 * ここではハンドラによらない同じキーにして、投稿・返信・編集・削除を合わせて数える。
 * **このガードを付けたルートは、すべて同じ枠を分け合う**——別の枠にしたい書き込みには付けない。
 */
@Injectable()
export class MessageWriteRateLimitGuard extends UserRateLimitGuard {
  protected override generateKey(_context: ExecutionContext, suffix: string, name: string): string {
    return `message-write-${name}-${suffix}`;
  }
}
