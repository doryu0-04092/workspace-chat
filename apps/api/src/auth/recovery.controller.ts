import { Body, Controller, HttpCode, HttpStatus, Post, Res, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { RateLimitGuard } from '../rate-limit/rate-limit.module';
import { LoginBackoffException } from './login.service';
import { RecoveryService, type RecoveryRequest, type RecoveryResponse } from './recovery.service';

/**
 * リカバリーコードによるパスワードの再設定（F-37）。認証を要さない。
 *
 * **入力の形はここでは確かめない**（register.controller.ts と同じ。openapi-validation.ts が仕様で確かめる）。
 */
@Controller('auth')
export class RecoveryController {
  constructor(private readonly recoveryService: RecoveryService) {}

  /**
   * **発信元単位で1時間に10回**（数値は慣行。新規登録と同じ）。ガードはハンドラより前に数えるため、401 もアカウント単位の 429 も
   * 1回として数える。アカウント単位の制限は RecoveryService の中にある（コードの照合は総当たりの対象になる。機能一覧 1.1）。
   */
  @Post('recovery')
  @HttpCode(HttpStatus.OK)
  @UseGuards(RateLimitGuard)
  @Throttle({ default: { limit: 10, ttl: 60 * 60 * 1000 } })
  async recover(
    @Body() body: RecoveryRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<RecoveryResponse> {
    try {
      return await this.recoveryService.recover(body);
    } catch (error) {
      if (error instanceof LoginBackoffException) {
        res.setHeader('Retry-After', String(error.retryAfterSeconds));
      }
      throw error;
    }
  }
}
