import { Logger } from '@nestjs/common';
import {
  type OnGatewayConnection,
  type OnGatewayInit,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { ErrorResponse } from '../error-response';
import type { Server, Socket } from 'socket.io';
import { AccessTokenResolver, type AuthenticatedUser } from '../auth/access-token.guard';
import { MetricsWriter } from '../logging/metrics';

/** 利用者の部屋の名前（機能一覧 9.2「利用者の部屋」）。 */
export function userRoom(userId: string): string {
  return `user:${userId}`;
}

type RealtimeSocket = Socket & { data: { user?: AuthenticatedUser } };

/** 断ったときにクライアントの `connect_error` の `data` に載る値。HTTP の 401 の `code` と同じ綴り（仕様の列挙から取る）。 */
type RejectCode = Extract<
  ErrorResponse['code'],
  'authentication_required' | 'invalid_token' | 'internal_error'
>;

function reject(code: RejectCode): Error & { data: { code: RejectCode } } {
  return Object.assign(new Error(code), { data: { code } });
}

/**
 * 接続の入口（F-16。機能一覧 5.2）。パス・Origin・アダプタは realtime-io.adapter.ts が持つ。
 *
 * - **トークンはハンドシェイクの `auth.token` だけから読む**（Cookie で渡さない。5.2）。無い → `authentication_required`
 * - **HTTP の入口と同じ AccessTokenResolver で解決し、使えないトークンも退会済みも `invalid_token` で断る**（1.4。#90）
 * - **解決の想定外の失敗（DB に繋がらないなど）は、例外のメッセージを渡さず `internal_error` で断り、ログに error で残す**
 *   （Socket.IO は `next(err)` の `message` をクライアントへ送る。`server.use` は Nest の例外フィルタを通らないため、error-response.ts と同じ決めをここで当てる）
 * - 認証を通った接続を、その利用者の部屋に入れる（9.2）
 * - **接続と切断を、構造化ログ（`websocket_connected` / `websocket_disconnected`。利用者の ID と切断の理由）と EMF のメトリクス
 *   （`WebSocketConnections`: このタスクの現在の接続数、`WebSocketConnects` / `WebSocketDisconnects`: 回数）の両方で記録する**
 *   （要件定義書 4.6。決定・2026-09-12・依頼側。#287）。切断率は回数の比から取る。配信遅延はイベントに送信時刻を載せる形になるため、チャンネルの実装で足す
 */
@WebSocketGateway()
export class RealtimeGateway implements OnGatewayInit<Server>, OnGatewayConnection<RealtimeSocket> {
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger('RealtimeGateway');
  /** このタスクで確立している接続の数（他のタスクの分は含まない。合計は取れない——logging/metrics.ts の次元の注記）。 */
  private connections = 0;

  constructor(
    private readonly tokens: AccessTokenResolver,
    private readonly metrics: MetricsWriter,
  ) {}

  afterInit(server: Server): void {
    server.use((socket: RealtimeSocket, next) => {
      const token = (socket.handshake.auth as { token?: unknown }).token;
      if (typeof token !== 'string') {
        next(reject('authentication_required'));
        return;
      }
      this.tokens.resolve(token).then(
        (user) => {
          if (!user) {
            next(reject('invalid_token'));
            return;
          }
          socket.data.user = user;
          next();
        },
        (error: unknown) => {
          const failure = error instanceof Error ? error : new Error(String(error));
          this.logger.error(failure.message, failure.stack ?? '');
          next(reject('internal_error'));
        },
      );
    });
  }

  handleConnection(socket: RealtimeSocket): void {
    const user = socket.data.user;
    // 認証のミドルウェアを通らずに接続は確立しない。ここに来て利用者が無いのは組み立ての誤りである。
    if (!user) throw new Error('認証を通らない接続が確立した');
    void socket.join(userRoom(user.id));

    this.connections += 1;
    this.logger.log({ event: 'websocket_connected', userId: user.id });
    this.metrics.write([
      { name: 'WebSocketConnects', unit: 'Count', value: 1 },
      { name: 'WebSocketConnections', unit: 'Count', value: this.connections },
    ]);
    socket.on('disconnect', (reason) => {
      this.connections -= 1;
      this.logger.log({ event: 'websocket_disconnected', userId: user.id, reason });
      this.metrics.write([
        { name: 'WebSocketDisconnects', unit: 'Count', value: 1 },
        { name: 'WebSocketConnections', unit: 'Count', value: this.connections },
      ]);
    });
  }
}
