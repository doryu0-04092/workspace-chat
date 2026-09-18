import { type ExecutionContext, Injectable } from '@nestjs/common';
import { UserRateLimitGuard } from './user-rate-limit.guard';

/**
 * チャンネルと DM の投稿・返信・編集・削除を**1つの枠**で数える利用者単位のレート制限
 * （チャンネルの投稿・編集・削除を1つの枠にするのは提案・承認済・2026-09-13・依頼側。#384。機能一覧 4.1・4.2。
 * 返信も同じ枠に入れるのは機能一覧 6 の実装時に決めた値。DM も同じ枠に入れるのは機能一覧 8 の実装時に決めた値）。
 *
 * `@nestjs/throttler` の既定のキーはクラス名とハンドラ名を含み、ルートごとに枠が分かれる。
 * ここではハンドラによらない同じキーにして、チャンネルと DM の投稿・返信・編集・削除を合わせて数える。
 * **このガードを付けたルートは、すべて同じ枠を分け合う**——別の枠にしたい書き込みには付けない。
 */
@Injectable()
export class MessageWriteRateLimitGuard extends UserRateLimitGuard {
  protected override generateKey(_context: ExecutionContext, suffix: string, name: string): string {
    return `message-write-${name}-${suffix}`;
  }
}
