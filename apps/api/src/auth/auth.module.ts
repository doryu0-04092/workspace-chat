import { Module } from '@nestjs/common';
import { RateLimitModule } from '../rate-limit/rate-limit.module';
import { REGISTRATION_ENABLED, resolveRegistrationEnabled } from './registration-enabled';
import { RegisterController } from './register.controller';
import { RegisterService } from './register.service';

@Module({
  imports: [RateLimitModule],
  controllers: [RegisterController],
  providers: [
    RegisterService,
    {
      provide: REGISTRATION_ENABLED,
      // 起動時に1回だけ読む。不正な値ならここで落ち、アプリが起動しない。
      useFactory: () => resolveRegistrationEnabled(process.env.REGISTRATION_ENABLED),
    },
  ],
})
export class AuthModule {}
