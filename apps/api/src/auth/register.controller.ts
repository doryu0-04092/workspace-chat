import { Body, Controller, ForbiddenException, Inject, Post } from '@nestjs/common';
import { REGISTRATION_ENABLED } from './registration-enabled';
import { RegisterService, type RegisterRequest, type RegisterResponse } from './register.service';

/**
 * 新規登録（F-01 / F-03 / F-37 の発行）。認証を要さない（要件定義書 2）。
 *
 * **入力の形はここでは確かめない。** REST の仕様（openapi.yaml の RegisterRequest）どおりであることは、
 * ハンドラより前に openapi-validation.ts の検証が確かめる。**ここに検証を書き足すと、仕様と2箇所になる。**
 */
@Controller('auth')
export class RegisterController {
  constructor(
    private readonly registerService: RegisterService,
    @Inject(REGISTRATION_ENABLED) private readonly registrationEnabled: boolean,
  ) {}

  @Post('register')
  register(@Body() body: RegisterRequest): Promise<RegisterResponse> {
    // ハッシュ化（CPU とメモリを使う）より前に止める。
    if (!this.registrationEnabled) {
      throw new ForbiddenException({
        code: 'registration_disabled',
        message: '新規登録は停止しています',
      });
    }
    return this.registerService.register(body);
  }
}
