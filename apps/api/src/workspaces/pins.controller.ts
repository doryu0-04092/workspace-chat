import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Put,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { type AuthenticatedUser, CurrentUser } from '../auth/access-token.guard';
import { UserRateLimitGuard } from '../rate-limit/user-rate-limit.guard';
import { type PinList, type PinnedMessage, PinsService } from './pins.service';

/**
 * ピン留めの付け外しの上限（利用者単位で1分に60回。**付けると外すで枠は別**——`UserRateLimitGuard` の枠はルートごとに分かれる。実装時に決めた値）。
 * 上限を置くのは、1要求がチャンネルの行を掴む書き込みを起こすためである（CWE-770）。値はメッセージの書き込み（`MESSAGE_POST_LIMIT`）と同じにした。
 */
export const PIN_WRITE_LIMIT = { limit: 60, ttl: 60 * 1000 } as const;

/** ピン留めの付け外しと、チャンネルのピン留めの一覧（F-33。機能一覧 13.2）。アクセストークンを求める（AccessTokenGuard の既定）。 */
@Controller('workspaces/:id/channels/:channelId')
export class PinsController {
  constructor(private readonly pins: PinsService) {}

  @Get('pins')
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') workspaceId: string,
    @Param('channelId') channelId: string,
  ): Promise<PinList> {
    return this.pins.list(user.id, workspaceId, channelId);
  }

  @Put('messages/:messageId/pin')
  @UseGuards(UserRateLimitGuard)
  @Throttle({ default: PIN_WRITE_LIMIT })
  pin(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') workspaceId: string,
    @Param('channelId') channelId: string,
    @Param('messageId') messageId: string,
  ): Promise<PinnedMessage> {
    return this.pins.pin(user.id, workspaceId, channelId, messageId);
  }

  @Delete('messages/:messageId/pin')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(UserRateLimitGuard)
  @Throttle({ default: PIN_WRITE_LIMIT })
  unpin(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') workspaceId: string,
    @Param('channelId') channelId: string,
    @Param('messageId') messageId: string,
  ): Promise<void> {
    return this.pins.unpin(user.id, workspaceId, channelId, messageId);
  }
}
