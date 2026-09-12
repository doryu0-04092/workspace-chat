import { Controller, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { type AuthenticatedUser, CurrentUser } from '../auth/access-token.guard';
import { ChannelArchiveService } from './channel-archive.service';
import type { ManagedChannel } from './managed-channel';

/**
 * チャンネルのアーカイブと復元（F-35。機能一覧 3.2）。アクセストークンを求める（AccessTokenGuard の既定）。
 *
 * **`id` の形はここでは確かめない**（openapi-validation.ts が仕様で確かめる）。
 */
@Controller('workspaces/:id/channels/:channelId')
export class ChannelArchiveController {
  constructor(private readonly archives: ChannelArchiveService) {}

  @Post('archive')
  @HttpCode(HttpStatus.OK)
  archive(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') workspaceId: string,
    @Param('channelId') channelId: string,
  ): Promise<ManagedChannel> {
    return this.archives.archive(user.id, workspaceId, channelId);
  }

  @Post('restore')
  @HttpCode(HttpStatus.OK)
  restore(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') workspaceId: string,
    @Param('channelId') channelId: string,
  ): Promise<ManagedChannel> {
    return this.archives.restore(user.id, workspaceId, channelId);
  }
}
