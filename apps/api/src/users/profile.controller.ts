import { Body, Controller, Get, Patch } from '@nestjs/common';
import { type AuthenticatedUser, CurrentUser } from '../auth/access-token.guard';
import { type Profile, ProfileService, type UpdateProfileRequest } from './profile.service';

/**
 * 自分のプロフィールの取得と編集（F-04。アバターを除く）。アクセストークンを求める（AccessTokenGuard の既定）。
 *
 * **入力の形はここでは確かめない**（register.controller.ts と同じ。openapi-validation.ts が仕様で確かめる）。
 * 仕様で書けない「絵文字1つ」だけを ProfileService が確かめる。
 */
@Controller('users')
export class ProfileController {
  constructor(private readonly profiles: ProfileService) {}

  @Get('me')
  me(@CurrentUser() user: AuthenticatedUser): Promise<Profile> {
    return this.profiles.get(user.id);
  }

  @Patch('me')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: UpdateProfileRequest,
  ): Promise<Profile> {
    return this.profiles.update(user.id, body);
  }
}
