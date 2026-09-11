import { Logger, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import type Redis from 'ioredis';
import { API_CONFIG, type ApiConfig } from '../config/api-config';
import {
  RateLimitModule,
  VALKEY_CLIENT,
  VALKEY_RETRY_INTERVAL_MS,
  ValkeyModule,
} from '../rate-limit/rate-limit.module';
import {
  MemoryLoginBackoffStore,
  ResilientLoginBackoffStore,
  ValkeyLoginBackoffStore,
} from './login-backoff';
import { AccessTokenGuard } from './access-token.guard';
import { LoginController } from './login.controller';
import { LOGIN_BACKOFF_STORE, LoginService } from './login.service';
import { RecoveryController } from './recovery.controller';
import { RecoveryService } from './recovery.service';
import { CsrfGuard } from './csrf.guard';
import { SessionController } from './session.controller';
import { SessionService } from './session.service';
import { REGISTRATION_ENABLED } from './registration-enabled';
import { RegisterController } from './register.controller';
import { RegisterService } from './register.service';
import { ACCESS_TOKEN_TTL_SECONDS } from './session-tokens';

@Module({
  imports: [
    RateLimitModule,
    ValkeyModule,
    JwtModule.registerAsync({
      inject: [API_CONFIG],
      // RFC 8725 3.1: 署名も検証も HS256 だけにする（alg: none や別のアルゴリズムを名乗るトークンを受け付けない）。
      useFactory: (config: ApiConfig) => ({
        secret: config.jwtSecret,
        signOptions: { algorithm: 'HS256', expiresIn: ACCESS_TOKEN_TTL_SECONDS },
        verifyOptions: { algorithms: ['HS256'] },
      }),
    }),
  ],
  controllers: [RegisterController, LoginController, SessionController, RecoveryController],
  providers: [
    RegisterService,
    LoginService,
    RecoveryService,
    SessionService,
    CsrfGuard,
    // すべてのルートに既定でアクセストークンを求める（外すのは @Public() のルートだけ。機能一覧 1.4）。
    { provide: APP_GUARD, useClass: AccessTokenGuard },
    {
      provide: REGISTRATION_ENABLED,
      inject: [API_CONFIG],
      useFactory: (config: ApiConfig) => config.registrationEnabled,
    },
    {
      provide: LOGIN_BACKOFF_STORE,
      inject: [VALKEY_CLIENT],
      useFactory: (client: Redis) =>
        new ResilientLoginBackoffStore(
          new ValkeyLoginBackoffStore(client),
          new MemoryLoginBackoffStore(),
          { retryIntervalMs: VALKEY_RETRY_INTERVAL_MS, logger: new Logger('LoginBackoff') },
        ),
    },
  ],
})
export class AuthModule {}
