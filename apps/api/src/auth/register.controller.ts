import { Body, Controller, ForbiddenException, Inject, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { ErrorResponse } from '../error-response';
import { RateLimitGuard } from '../rate-limit/rate-limit.module';
import { Public } from './access-token.guard';
import { REGISTRATION_ENABLED } from './registration-enabled';
import { RegisterService, type RegisterRequest, type RegisterResponse } from './register.service';

/**
 * 新規登録（F-01 / F-03 / F-37 の発行）。認証を要さない（要件定義書 2）。
 *
 * **入力の形はここでは確かめない。** REST の仕様（openapi.yaml の RegisterRequest）どおりであることは、
 * ハンドラより前に openapi-validation.ts の検証が確かめる。**ここに検証を書き足すと、仕様と2箇所になる。**
 */
@Public()
@Controller('auth')
export class RegisterController {
  constructor(
    private readonly registerService: RegisterService,
    @Inject(REGISTRATION_ENABLED) private readonly registrationEnabled: boolean,
  ) {}

  /**
   * **発信元単位で1時間に10回**（機能一覧 1.1）。ガードはハンドラより前に数えるため、409（重複）も 403（停止中）も
   * 1回として数える——409 はユーザーID の列挙に使えるため、数えないと抑えにならない。
   * 仕様の検証（400）はガードより前のミドルウェアで返るため、数えない（ハッシュ化に届かず、重い処理を起こさない）。
   */
  @Post('register')
  @UseGuards(RateLimitGuard)
  @Throttle({ default: { limit: 10, ttl: 60 * 60 * 1000 } })
  register(@Body() body: RegisterRequest): Promise<RegisterResponse> {
    // ハッシュ化（CPU とメモリを使う）より前に止める。
    if (!this.registrationEnabled) {
      throw new ForbiddenException({
        code: 'registration_disabled',
        message: '新規登録は停止しています',
      } satisfies ErrorResponse);
    }
    return this.registerService.register(body);
  }
}
