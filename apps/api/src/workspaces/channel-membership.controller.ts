import { Body, Controller, Delete, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { type AuthenticatedUser, CurrentUser } from '../auth/access-token.guard';
import {
  ChannelMembershipService,
  type InviteChannelMemberRequest,
} from './channel-membership.service';

/**
 * チャンネルへの参加・退出・招待・キック（機能一覧 2.2・3.1。#335）。アクセストークンを求める（AccessTokenGuard の既定）。
 *
 * **入力の形（`id` の形・招待の宛先の形）はここでは確かめない**（openapi-validation.ts が仕様で確かめる）。
 */
@Controller('workspaces/:id/channels/:channelId')
export class ChannelMembershipController {
  constructor(private readonly membership: ChannelMembershipService) {}

  @Post('join')
  @HttpCode(HttpStatus.NO_CONTENT)
  join(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') workspaceId: string,
    @Param('channelId') channelId: string,
  ): Promise<void> {
    return this.membership.join(user.id, workspaceId, channelId);
  }

  @Post('leave')
  @HttpCode(HttpStatus.NO_CONTENT)
  leave(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') workspaceId: string,
    @Param('channelId') channelId: string,
  ): Promise<void> {
    return this.membership.leave(user.id, workspaceId, channelId);
  }

  @Post('members')
  @HttpCode(HttpStatus.NO_CONTENT)
  invite(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') workspaceId: string,
    @Param('channelId') channelId: string,
    @Body() body: InviteChannelMemberRequest,
  ): Promise<void> {
    return this.membership.invite(user.id, workspaceId, channelId, body.memberId);
  }

  @Delete('members/:memberId')
  @HttpCode(HttpStatus.NO_CONTENT)
  kick(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') workspaceId: string,
    @Param('channelId') channelId: string,
    @Param('memberId') memberId: string,
  ): Promise<void> {
    return this.membership.kick(user.id, workspaceId, channelId, memberId);
  }
}
