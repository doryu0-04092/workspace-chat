import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';

/**
 * **公開するエンドポイントを、要件に記録しないまま足さない**（CLAUDE.md 1）。
 * 死活確認（`GET /api/health`）の区分と根拠は、機能一覧の F-39 の行と要件定義書 3.2 の派-10 にある。
 *
 * **全ルートの前置き `/api` は app-setup.ts の createApp が付ける**（#77 の決定。理由はそちら）。
 * **WebSocket も同じで、Socket.IO の `path` は `/api/socket.io/` である**
 * （サーバー・クライアントの両方で設定する。機能一覧 5.2）。
 */
@Module({
  controllers: [HealthController],
})
export class AppModule {}
