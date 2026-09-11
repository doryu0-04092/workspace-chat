import type { INestApplicationContext } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { REALTIME_PATH } from '@workspace-chat/shared';
import type { IncomingMessage } from 'node:http';
import type { Server, ServerOptions } from 'socket.io';
import type { RealtimeValkeyClients } from './realtime-valkey';

/**
 * Socket.IO のサーバーの設定を1箇所に置く（createApp が `useWebSocketAdapter` で当てる）。
 *
 * - **`path` は `/api/socket.io/`**（#77。`REALTIME_PATH`。クライアントも同じ定数を読む）
 * - **`allowRequest` で `Origin` を web の origin（`WEB_ORIGIN`）と照合し、一致しないもの・`Origin` を持たないものを断る**
 *   （要件定義書 4.3 の CSWSH の対処。WebSocket は同一オリジンポリシーの対象外で、`cors` が効くのは long-polling だけである）。
 *   allowRequest はハンドシェイクの要求と WebSocket への切り替えの要求の両方に掛かる。
 *   web と api は同じ origin から配信する（#77）ため、許可するのは `WEB_ORIGIN` の1つだけである
 * - **タスクをまたぐ配信は `@socket.io/redis-adapter` が Valkey の Pub/Sub で行う**（技術スタック 難-2）
 */
export class RealtimeIoAdapter extends IoAdapter {
  constructor(
    app: INestApplicationContext,
    private readonly settings: { webOrigin: string; valkey: RealtimeValkeyClients },
  ) {
    super(app);
  }

  override createIOServer(port: number, options?: ServerOptions): Server {
    const server = super.createIOServer(port, {
      ...options,
      path: REALTIME_PATH,
      serveClient: false,
      allowRequest: (
        request: IncomingMessage,
        callback: (error: string | null | undefined, success: boolean) => void,
      ) => callback(null, request.headers.origin === this.settings.webOrigin),
    }) as Server;
    server.adapter(createAdapter(this.settings.valkey.publisher, this.settings.valkey.subscriber));
    return server;
  }

  /**
   * **購読の接続は、サーバー（とアダプタの購読の解除）を閉じた後に閉じる。** Nest は終了の処理（onApplicationShutdown）を
   * WebSocket のサーバーを閉じるより先に呼ぶため、そこで閉じると、アダプタが閉じるときの unsubscribe が閉じた接続に送られる。
   * publish の接続はレート制限と共有しており、ValkeyModule が閉じる。
   */
  override async close(server: Server): Promise<void> {
    await super.close(server);
    this.settings.valkey.subscriber.disconnect();
  }
}
