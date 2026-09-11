import { Body, Controller, HttpCode, HttpStatus, Post, Res, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { RateLimitGuard } from '../rate-limit/rate-limit.module';
import { LoginService, type LoginRequest, type LoginResponse } from './login.service';
import { REFRESH_TOKEN_COOKIE, REFRESH_TOKEN_COOKIE_OPTIONS } from './session-tokens';

/**
 * ログイン（F-02）。認証を要さない（要件定義書 2）。
 *
 * **入力の形はここでは確かめない**（register.controller.ts と同じ。openapi-validation.ts が仕様で確かめる）。
 */
@Controller('auth')
export class LoginController {
  constructor(private readonly loginService: LoginService) {}

  /**
   * **発信元単位で15分に20回**（数値は慣行。一次情報に推奨は無い）。ガードはハンドラより前に数えるため、
   * 401 も アカウント単位の 429 も1回として数える。アカウント単位の制限は LoginService の中にある。
   */
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @UseGuards(RateLimitGuard)
  @Throttle({ default: { limit: 20, ttl: 15 * 60 * 1000 } })
  async login(
    @Body() body: LoginRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<LoginResponse> {
    const result = await this.loginService.login(body);
    res.cookie(REFRESH_TOKEN_COOKIE, result.refreshToken, REFRESH_TOKEN_COOKIE_OPTIONS);
    return result.body;
  }
}
