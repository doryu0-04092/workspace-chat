import { Body, Controller, Get, Patch } from '@nestjs/common';
import { type AuthenticatedUser, CurrentUser } from '../auth/access-token.guard';
import {
  SettingsService,
  type UpdateUserSettingsRequest,
  type UserSettings,
} from './settings.service';

/**
 * 自分の設定の取得と変更（F-23。機能一覧 10.1）。アクセストークンを求める（AccessTokenGuard の既定）。
 * **`me` だけを受け、他の利用者の id は受けない**——本人以外の設定は読めも書けもしない。
 *
 * **入力の形はここでは確かめない**（profile.controller.ts と同じ。openapi-validation.ts が仕様で確かめる）。
 */
@Controller('users')
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get('me/settings')
  get(@CurrentUser() user: AuthenticatedUser): Promise<UserSettings> {
    return this.settings.get(user.id);
  }

  @Patch('me/settings')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: UpdateUserSettingsRequest,
  ): Promise<UserSettings> {
    return this.settings.update(user.id, body);
  }
}
