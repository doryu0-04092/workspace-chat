import { Body, Controller, HttpCode, HttpStatus, Param, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { type AuthenticatedUser, CurrentUser } from '../auth/access-token.guard';
import { UserRateLimitGuard } from '../rate-limit/user-rate-limit.guard';
import { UPLOAD_COMPLETE_LIMIT, UPLOAD_ISSUE_LIMIT } from '../file-uploads/upload-rate-limit';
import {
  AvatarUploadService,
  type UploadRequest,
  type UploadTicket,
} from './avatar-upload.service';
import type { Profile } from './profile.service';

/**
 * 自分のアバター画像のアップロード（F-04。機能一覧 1.3・11.1）。アクセストークンを求める（AccessTokenGuard の既定）。
 * **経路は `users/me` の下だけであり、他の利用者のアバターを指す経路を持たない**（本人のプロフィールについてだけ発行と確定を求められる）。
 * 発行と確定は、それぞれ利用者単位の上限を持つ（upload-rate-limit.ts）。入力の形は openapi-validation.ts が仕様で確かめる。
 */
@Controller('users/me/avatar/uploads')
export class AvatarUploadController {
  constructor(private readonly uploads: AvatarUploadService) {}

  @Post()
  @UseGuards(UserRateLimitGuard)
  @Throttle({ default: UPLOAD_ISSUE_LIMIT })
  issue(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: UploadRequest,
  ): Promise<UploadTicket> {
    return this.uploads.issue(user.id, body);
  }

  @Post(':uploadId/complete')
  @HttpCode(HttpStatus.OK)
  @UseGuards(UserRateLimitGuard)
  @Throttle({ default: UPLOAD_COMPLETE_LIMIT })
  complete(
    @CurrentUser() user: AuthenticatedUser,
    @Param('uploadId') uploadId: string,
  ): Promise<Profile> {
    return this.uploads.complete(user.id, uploadId);
  }
}
