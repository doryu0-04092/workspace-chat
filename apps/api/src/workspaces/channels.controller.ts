import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { type AuthenticatedUser, CurrentUser } from '../auth/access-token.guard';
import {
  type Channel,
  type ChannelMember,
  ChannelsService,
  type CreateChannelRequest,
  type ManagedChannel,
} from './channels.service';

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
}
