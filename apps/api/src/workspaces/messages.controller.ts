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
import type { UpdateChannelReadRequest } from './channels.service';
import {
  type Message,
  type MessagePage,
  MessagesService,
  type PostMessageRequest,
} from './messages.service';

/**
 * 投稿・返信・編集・削除の上限（利用者単位で1分に60回。機能一覧 4.1・4.2・6）。
 * **チャンネルと DM の投稿・返信・編集・削除で1つの枠を分け合う**（`MessageWriteRateLimitGuard`。
 * チャンネルの投稿・編集・削除を1つの枠にするのは提案・承認済・2026-09-13・依頼側〔#384〕、
 * 返信も同じ枠に入れるのは機能一覧 6 の実装時に決めた値、DM も同じ枠に入れるのは機能一覧 8 の実装時に決めた値）。
 */
export const MESSAGE_POST_LIMIT = { limit: 60, ttl: 60 * 1000 } as const;

/**
 * チャンネルのメッセージの投稿・一覧・編集・削除と、スレッドの返信（F-11・F-12・F-13・F-17。機能一覧 4.1・4.2・6）。アクセストークンを求める（AccessTokenGuard の既定）。
 *
 * **入力の形（本文の長さと空白だけか・`before` と `messageId` の形・`limit` の範囲）はここでは確かめない**（openapi-validation.ts が仕様で確かめる）。
 */
@Controller('workspaces/:id/channels/:channelId/messages')
export class MessagesController {
  constructor(private readonly messages: MessagesService) {}

  @Post()
  @UseGuards(MessageWriteRateLimitGuard)
  @Throttle({ default: MESSAGE_POST_LIMIT })
  post(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') workspaceId: string,
    @Param('channelId') channelId: string,
    @Body() body: PostMessageRequest,
  ): Promise<Message> {
    return this.messages.post(user.id, workspaceId, channelId, body);
  }

  @Post(':messageId/replies')
  @UseGuards(MessageWriteRateLimitGuard)
  @Throttle({ default: MESSAGE_POST_LIMIT })
  postReply(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') workspaceId: string,
    @Param('channelId') channelId: string,
    @Param('messageId') messageId: string,
    @Body() body: PostMessageRequest,
  ): Promise<Message> {
    return this.messages.postReply(user.id, workspaceId, channelId, messageId, body);
  }

  @Get(':messageId/replies')
  listReplies(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') workspaceId: string,
    @Param('channelId') channelId: string,
    @Param('messageId') messageId: string,
    @Query() query: { before?: string; limit?: string },
  ): Promise<MessagePage> {
    return this.messages.listReplies(user.id, workspaceId, channelId, messageId, query);
  }

  /** スレッドの既読位置の更新（F-23。機能一覧 10.1）。本体の形は仕様が確かめる。 */
  @Put(':messageId/read')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(UserRateLimitGuard)
  @Throttle({ default: READ_UPDATE_LIMIT })
  updateThreadRead(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') workspaceId: string,
    @Param('channelId') channelId: string,
    @Param('messageId') messageId: string,
    @Body() body: UpdateChannelReadRequest,
  ): Promise<void> {
    return this.messages.updateThreadRead(
      user.id,
      workspaceId,
      channelId,
      messageId,
      body.lastReadMessageId,
    );
  }

  @Patch(':messageId')
  @UseGuards(MessageWriteRateLimitGuard)
  @Throttle({ default: MESSAGE_POST_LIMIT })
  edit(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') workspaceId: string,
    @Param('channelId') channelId: string,
    @Param('messageId') messageId: string,
    @Body() body: PostMessageRequest,
  ): Promise<Message> {
    return this.messages.edit(user.id, workspaceId, channelId, messageId, body);
  }

  @Delete(':messageId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(MessageWriteRateLimitGuard)
  @Throttle({ default: MESSAGE_POST_LIMIT })
  remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') workspaceId: string,
    @Param('channelId') channelId: string,
    @Param('messageId') messageId: string,
  ): Promise<void> {
    return this.messages.remove(user.id, workspaceId, channelId, messageId);
  }

  @Get()
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') workspaceId: string,
    @Param('channelId') channelId: string,
    @Query() query: { before?: string; limit?: string },
  ): Promise<MessagePage> {
    return this.messages.list(user.id, workspaceId, channelId, query);
  }
}
