import { Module } from '@nestjs/common';
import { API_CONFIG, type ApiConfig } from '../config/api-config';
import { RateLimitModule } from '../rate-limit/rate-limit.module';
import { REGISTRATION_ENABLED } from './registration-enabled';
import { RegisterController } from './register.controller';
import { RegisterService } from './register.service';

@Module({
  imports: [RateLimitModule],
  controllers: [RegisterController],
  providers: [
    RegisterService,
    {
      provide: REGISTRATION_ENABLED,
      inject: [API_CONFIG],
      useFactory: (config: ApiConfig) => config.registrationEnabled,
    },
  ],
})
export class AuthModule {}
