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
  Query,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { type AuthenticatedUser, CurrentUser } from '../auth/access-token.guard';
import { UserRateLimitGuard } from '../rate-limit/user-rate-limit.guard';
import {
  type Message,
  type MessagePage,
  MessagesService,
  type PostMessageRequest,
} from './messages.service';

/** 投稿の上限（利用者単位で1分に60回。実装時に決めた値。機能一覧 4.1）。 */
export const MESSAGE_POST_LIMIT = { limit: 60, ttl: 60 * 1000 } as const;

/**
 * チャンネルのメッセージの投稿と一覧（F-11・F-12。機能一覧 4.1）。アクセストークンを求める（AccessTokenGuard の既定）。
 *
 * **入力の形（本文の長さと空白だけか・`before` の形・`limit` の範囲）はここでは確かめない**（openapi-validation.ts が仕様で確かめる）。
 */
@Controller('workspaces/:id/channels/:channelId/messages')
export class MessagesController {
  constructor(private readonly messages: MessagesService) {}

  @Post()
  @UseGuards(UserRateLimitGuard)
  @Throttle({ default: MESSAGE_POST_LIMIT })
  post(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') workspaceId: string,
    @Param('channelId') channelId: string,
    @Body() body: PostMessageRequest,
  ): Promise<Message> {
    return this.messages.post(user.id, workspaceId, channelId, body);
  }

  @Patch(':messageId')
  @UseGuards(UserRateLimitGuard)
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
  @UseGuards(UserRateLimitGuard)
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
