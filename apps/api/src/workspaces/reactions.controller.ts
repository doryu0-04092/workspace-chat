import { Controller, Delete, Param, Put, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { type AuthenticatedUser, CurrentUser } from '../auth/access-token.guard';
import { UserRateLimitGuard } from '../rate-limit/user-rate-limit.guard';
import { type MessageReactions, ReactionsService } from './reactions.service';

/**
 * リアクションの付け外しの上限（利用者単位で1分に60回。**付けると外すで枠は別**——`UserRateLimitGuard` の枠はルートごとに分かれる。実装時に決めた値）。
 * **上限を置くのは、1要求が行の書き込みと部屋の全員への配信を起こすためである**（CWE-770）。値はメッセージの書き込み（`MESSAGE_POST_LIMIT`）と同じにした。
 */
export const REACTION_LIMIT = { limit: 60, ttl: 60 * 1000 } as const;

/**
 * メッセージの絵文字リアクションの付け外し（F-18。機能一覧 7）。アクセストークンを求める（AccessTokenGuard の既定）。
 * **絵文字の長さはここでは確かめない**（openapi-validation.ts が仕様で確かめる）。絵文字1つかは `ReactionsService` が確かめる。
 */
@Controller('workspaces/:id/channels/:channelId/messages/:messageId/reactions/:emoji')
export class ReactionsController {
  constructor(private readonly reactions: ReactionsService) {}

  @Put()
  @UseGuards(UserRateLimitGuard)
  @Throttle({ default: REACTION_LIMIT })
  add(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') workspaceId: string,
    @Param('channelId') channelId: string,
    @Param('messageId') messageId: string,
    @Param('emoji') emoji: string,
  ): Promise<MessageReactions> {
    return this.reactions.add(user.id, workspaceId, channelId, messageId, emoji);
  }

  @Delete()
  @UseGuards(UserRateLimitGuard)
  @Throttle({ default: REACTION_LIMIT })
  remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') workspaceId: string,
    @Param('channelId') channelId: string,
    @Param('messageId') messageId: string,
    @Param('emoji') emoji: string,
  ): Promise<MessageReactions> {
    return this.reactions.remove(user.id, workspaceId, channelId, messageId, emoji);
  }
}
