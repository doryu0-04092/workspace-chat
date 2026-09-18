import { Controller, Get, HttpCode, HttpStatus, Param, Put, Query } from '@nestjs/common';
import { type AuthenticatedUser, CurrentUser } from '../auth/access-token.guard';
import { type NotificationPage, NotificationsService } from './notifications.service';

/**
 * 自分の通知の一覧と既読化（F-26。機能一覧 10.3）。アクセストークンを求める（AccessTokenGuard の既定）。
 * **`me` だけを受け、他の利用者の id は受けない**——本人以外の通知は読めも既読にもできない。
 *
 * **上限（レート制限）は置かない**——一覧は読むだけで、既読化は1要求で1行を書き換えるだけであり、未読の集計や配信へ増幅しない
 * （既読位置の更新〔機能一覧 10.1〕が上限を置く理由の「1要求が未読の集計を起こす」に当たらない）。
 *
 * **入力の形（`before` と `notificationId` の形・`limit` の範囲）はここでは確かめない**（openapi-validation.ts が仕様で確かめる）。
 */
@Controller('users/me/notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: { before?: string; limit?: string },
  ): Promise<NotificationPage> {
    return this.notifications.list(user.id, query);
  }

  @Put(':notificationId/read')
  @HttpCode(HttpStatus.NO_CONTENT)
  markRead(
    @CurrentUser() user: AuthenticatedUser,
    @Param('notificationId') notificationId: string,
  ): Promise<void> {
    return this.notifications.markRead(user.id, notificationId);
  }
}
