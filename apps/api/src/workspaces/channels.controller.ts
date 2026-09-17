import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { type AuthenticatedUser, CurrentUser } from '../auth/access-token.guard';
import { UserRateLimitGuard } from '../rate-limit/user-rate-limit.guard';
import {
  type Channel,
  type ChannelMember,
  ChannelsService,
  type CreateChannelRequest,
  type ManagedChannel,
  type UpdateChannelReadRequest,
} from './channels.service';

/**
 * 既読位置の更新の上限（利用者ごとに1分 120 回。F-23。機能一覧 10.1。実装時に決めた値）。
 * **メッセージの書き込みの枠（`MessageWriteRateLimitGuard`）とは分ける**——読むための操作が、投稿・返信・編集・削除の枠を食ってはならない。
 * **上限を置くのは、1要求が未読の集計を起こすためである**（CWE-770。#505 第0巡の 🔴3）。
 * **踏むと壊れる: 変えるなら、スレッドの既読の更新（`MessagesController`）と機能一覧 10.1 も同じ値にする。**
 */
export const READ_UPDATE_LIMIT = { limit: 120, ttl: 60 * 1000 } as const;

/**
 * チャンネルの作成・一覧・オーナーの管理用の一覧・参加者一覧（F-10。機能一覧 3.1）。アクセストークンを求める（AccessTokenGuard の既定）。
 *
 * **入力の形（名前の長さ・種別・`id` の形）はここでは確かめない**（openapi-validation.ts が仕様で確かめる）。
 */
@Controller('workspaces/:id')
export class ChannelsController {
  constructor(private readonly channels: ChannelsService) {}

  @Post('channels')
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') workspaceId: string,
    @Body() body: CreateChannelRequest,
  ): Promise<Channel> {
    return this.channels.create(user.id, workspaceId, body);
  }

  @Get('channels')
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') workspaceId: string,
  ): Promise<Channel[]> {
    return this.channels.list(user.id, workspaceId);
  }

  @Get('archived-channels')
  archived(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') workspaceId: string,
  ): Promise<Channel[]> {
    return this.channels.archived(user.id, workspaceId);
  }

  @Get('managed-channels')
  managed(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') workspaceId: string,
  ): Promise<ManagedChannel[]> {
    return this.channels.managed(user.id, workspaceId);
  }

  @Get('channels/:channelId/members')
  members(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') workspaceId: string,
    @Param('channelId') channelId: string,
  ): Promise<ChannelMember[]> {
    return this.channels.members(user.id, workspaceId, channelId);
  }

  /**
   * 既読位置の更新（F-23。機能一覧 10.1）。**進めるだけで、戻さない**——古い id を渡しても 204 で、既読位置は変わらない。
   * 本体の形（`lastReadMessageId` が UUID であること）は仕様が確かめる。
   */
  @Put('channels/:channelId/read')
  @HttpCode(204)
  @UseGuards(UserRateLimitGuard)
  @Throttle({ default: READ_UPDATE_LIMIT })
  updateRead(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') workspaceId: string,
    @Param('channelId') channelId: string,
    @Body() body: UpdateChannelReadRequest,
  ): Promise<void> {
    return this.channels.updateRead(user.id, workspaceId, channelId, body.lastReadMessageId);
  }

  /** メンションの補完候補（F-20。機能一覧 9.1）。`prefix` の形と既定値（空）は仕様が持ち、openapi-validation.ts が要求に入れてから届く。 */
  @Get('channels/:channelId/mention-candidates')
  mentionCandidates(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') workspaceId: string,
    @Param('channelId') channelId: string,
    @Query('prefix') prefix: string,
  ): Promise<ChannelMember[]> {
    return this.channels.mentionCandidates(user.id, workspaceId, channelId, prefix);
  }
}
