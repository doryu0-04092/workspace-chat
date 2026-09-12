import {
  type DynamicModule,
  type MiddlewareConsumer,
  Module,
  type NestModule,
} from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AuthModule } from './auth/auth.module';
import { type ApiConfig, ApiConfigModule } from './config/api-config';
import { HealthController } from './health.controller';
import { ErrorResponseFilter } from './error-response';
import { OpenApiValidationMiddleware } from './openapi-validation';
import { PrismaModule } from './prisma.service';
import { RealtimeModule } from './realtime/realtime.module';
import { UsersModule } from './users/users.module';
import { WorkspacesModule } from './workspaces/workspaces.module';

/**
 * **公開するエンドポイントを、要件に記録しないまま足さない**（CLAUDE.md 1）。
 * 死活確認（`GET /api/health`）の区分と根拠は、機能一覧の F-39 の行と要件定義書 3.2 の派-10 にある。
 * **REST の仕様（packages/shared/openapi/openapi.yaml）にも載せる。** 載っていないパスは、
 * openapi-validation.ts の検証が 404 で落とす。
 *
 * **全ルートの前置き `/api` は app-setup.ts の createApp が付ける**（#77 の決定。理由はそちら）。
 * **WebSocket も同じで、Socket.IO の `path` は `/api/socket.io/` である**
 * （サーバー・クライアントの両方で設定する。機能一覧 5.2）。
 */
@Module({
  controllers: [HealthController],
  providers: [{ provide: APP_FILTER, useClass: ErrorResponseFilter }],
})
export class AppModule implements NestModule {
  /** 起動の設定（検証済み）を受け取って組み立てる。設定の検証は createApp が組み立ての前に行う。 */
  static forRoot(config: ApiConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ApiConfigModule.forRoot(config),
        PrismaModule,
        AuthModule,
        UsersModule,
        WorkspacesModule,
        RealtimeModule,
      ],
    };
  }

  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(OpenApiValidationMiddleware).forRoutes('{*splat}');
  }
}
