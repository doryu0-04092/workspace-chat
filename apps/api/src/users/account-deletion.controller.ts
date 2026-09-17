import { Body, Controller, HttpCode, HttpStatus, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { type AuthenticatedUser, CurrentUser } from '../auth/access-token.guard';
import { REFRESH_TOKEN_CLEAR_COOKIE_OPTIONS, REFRESH_TOKEN_COOKIE } from '../auth/session-tokens';
import { AccountDeletionService, type DeleteAccountRequest } from './account-deletion.service';

/**
 * 自分のアカウントの削除（退会。F-36）。アクセストークンを求める（AccessTokenGuard の既定）。
 * **入力の形はここでは確かめない**（openapi-validation.ts が仕様で確かめる）。
 *
 * 削除したら refresh_token の Cookie を消す（トークンは削除の中で失効させてある。ログアウトと同じく、使えないものを持ち続けさせない）。
 */
@Controller('users')
export class AccountDeletionController {
  constructor(private readonly accounts: AccountDeletionService) {}

  @Post('me/delete')
  @HttpCode(HttpStatus.NO_CONTENT)
  async delete(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: DeleteAccountRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    await this.accounts.delete(user.id, body);
    res.clearCookie(REFRESH_TOKEN_COOKIE, REFRESH_TOKEN_CLEAR_COOKIE_OPTIONS);
  }
}
