import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { type AuthenticatedUser, CurrentUser } from '../auth/access-token.guard';
import { MessageWriteRateLimitGuard } from '../rate-limit/message-write-rate-limit.guard';
import { UserRateLimitGuard } from '../rate-limit/user-rate-limit.guard';
import { READ_UPDATE_LIMIT } from './channels.controller';
import {
  type Dm,
  type DmMessage,
  type DmMessagePage,
  DmsService,
  type PostDmMessageRequest,
  type StartDmRequest,
  type UpdateDmReadRequest,
} from './dms.service';
import { MESSAGE_POST_LIMIT } from './messages.controller';

/**
 * ダイレクトメッセージ（F-19。機能一覧 8）の開始・一覧・メッセージの投稿・一覧・編集・削除と、DM の既読位置の更新（F-23）。
 * アクセストークンを求める（AccessTokenGuard の既定）。**入力の形はここでは確かめない**（openapi-validation.ts が仕様で確かめる）。
 *
 * - **DM の投稿・編集・削除は、チャンネルのメッセージの書き込みと同じ枠で数える**（`MessageWriteRateLimitGuard`。利用者単位で合わせて1分に60回。機能一覧 4.1・4.2）——
 *   DM もメッセージの書き込みであり、枠を分けるとチャンネルと DM を交互に書いて上限の倍を書ける（実装時に決めた値）
 * - **DM の既読の更新は、チャンネル・スレッドの既読の更新と同じ値（1分 120 回）で、ルートごとの枠**（`UserRateLimitGuard`。機能一覧 10.1「枠はルートごとに分ける」）
 * - **始める（`POST /dms`）には上限を置かない**——作る行は同じ2人につき1つで、ワークスペースのメンバーの数で頭打ちになる
 */
@Controller('workspaces/:id/dms')
export class DmsController {
  constructor(private readonly dms: DmsService) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser, @Param('id') workspaceId: string): Promise<Dm[]> {
    return this.dms.list(user.id, workspaceId);
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  start(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') workspaceId: string,
    @Body() body: StartDmRequest,
  ): Promise<Dm> {
    return this.dms.start(user.id, workspaceId, body);
  }

  @Get(':dmId/messages')
  listMessages(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') workspaceId: string,
    @Param('dmId') dmId: string,
    @Query() query: { before?: string; limit?: string },
  ): Promise<DmMessagePage> {
    return this.dms.listMessages(user.id, workspaceId, dmId, query);
  }

  @Post(':dmId/messages')
  @UseGuards(MessageWriteRateLimitGuard)
  @Throttle({ default: MESSAGE_POST_LIMIT })
  post(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') workspaceId: string,
    @Param('dmId') dmId: string,
    @Body() body: PostDmMessageRequest,
  ): Promise<DmMessage> {
    return this.dms.post(user.id, workspaceId, dmId, body);
  }

  @Patch(':dmId/messages/:messageId')
  @UseGuards(MessageWriteRateLimitGuard)
  @Throttle({ default: MESSAGE_POST_LIMIT })
  edit(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') workspaceId: string,
    @Param('dmId') dmId: string,
    @Param('messageId') messageId: string,
    @Body() body: PostDmMessageRequest,
  ): Promise<DmMessage> {
    return this.dms.edit(user.id, workspaceId, dmId, messageId, body);
  }

  @Delete(':dmId/messages/:messageId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(MessageWriteRateLimitGuard)
  @Throttle({ default: MESSAGE_POST_LIMIT })
  remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') workspaceId: string,
    @Param('dmId') dmId: string,
    @Param('messageId') messageId: string,
  ): Promise<void> {
    return this.dms.remove(user.id, workspaceId, dmId, messageId);
  }

  @Put(':dmId/read')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(UserRateLimitGuard)
  @Throttle({ default: READ_UPDATE_LIMIT })
  updateRead(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') workspaceId: string,
    @Param('dmId') dmId: string,
    @Body() body: UpdateDmReadRequest,
  ): Promise<void> {
    return this.dms.updateRead(user.id, workspaceId, dmId, body.lastReadMessageId);
  }
}
