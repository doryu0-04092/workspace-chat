import { Body, Controller, HttpCode, HttpStatus, Param, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { type AuthenticatedUser, CurrentUser } from '../auth/access-token.guard';
import { UPLOAD_COMPLETE_LIMIT, UPLOAD_ISSUE_LIMIT } from '../file-uploads/upload-rate-limit';
import { UserRateLimitGuard } from '../rate-limit/user-rate-limit.guard';
import type { Attachment } from './attachment-view';
import { AttachmentsService, type UploadRequest, type UploadTicket } from './attachments.service';

/**
 * チャンネルの添付ファイルのアップロードの発行と確定（F-27・F-28。機能一覧 11.1）。アクセストークンを求める（AccessTokenGuard の既定）。
 * 発行と確定は、それぞれ利用者単位の上限を持つ（upload-rate-limit.ts）。入力の形は openapi-validation.ts が仕様で確かめる。
 */
@Controller('workspaces/:id/channels/:channelId/attachments/uploads')
export class AttachmentsController {
  constructor(private readonly attachments: AttachmentsService) {}

  @Post()
  @UseGuards(UserRateLimitGuard)
  @Throttle({ default: UPLOAD_ISSUE_LIMIT })
  issue(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') workspaceId: string,
    @Param('channelId') channelId: string,
    @Body() body: UploadRequest,
  ): Promise<UploadTicket> {
    return this.attachments.issue(user.id, workspaceId, channelId, body);
  }

  @Post(':uploadId/complete')
  @HttpCode(HttpStatus.OK)
  @UseGuards(UserRateLimitGuard)
  @Throttle({ default: UPLOAD_COMPLETE_LIMIT })
  complete(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') workspaceId: string,
    @Param('channelId') channelId: string,
    @Param('uploadId') uploadId: string,
  ): Promise<Attachment> {
    return this.attachments.complete(user.id, workspaceId, channelId, uploadId);
  }
}
