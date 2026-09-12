import { Logger } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  type OnGatewayConnection,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import {
  type ChannelEnterAck,
  type ChannelRoomAck,
  type ChannelRoomRejection,
  REALTIME_REQUESTS,
} from '@workspace-chat/shared';
import { errorResponseOf } from '../error-response';
import { RealtimePresence } from '../realtime/realtime-presence';
import { type RealtimeSocket, channelIdOfRoom, channelRoom } from '../realtime/realtime.gateway';
import { ChannelRoomsService, channelIdOf } from './channel-rooms.service';

/**
 * チャンネルの部屋への入室要求・退室要求（機能一覧 9.2「部屋（Socket.IO の room）」）と、在席の変化（F-22）。接続の入口と認証は realtime.gateway.ts が持つ。
 *
 * - **断るときは acknowledgement で、HTTP と同じ状態コードとエラーの本体を返す**（本体は error-response.ts の `errorResponseOf`。
 *   入室の処理で個別の文言を書かない）。想定外の失敗は例外のメッセージを渡さず `internal_error` にし、ログに error で残す
 * - **確かめてから部屋に入れた後に、もう一度確かめ、参加者でなくなっていれば外して断る**——確かめてから入れるまでの間に
 *   キック・退出が走ると、その処理が外す時点ではこの接続はまだ部屋に入っておらず、参加者でない接続が部屋に残る
 * - **入室できたら、その時点で部屋に入っている参加者を acknowledgement で返す**（在席を画面へ渡す経路は部屋の側だけ。9.2）
 * - **切断では、部屋から出る前（`disconnecting`）に入っていたチャンネルの部屋を取り出して在席の変化を配る**
 *   （`disconnect` を待つと入っていた部屋を取り出せない。公式文書 Server socket instance）
 */
@WebSocketGateway()
export class ChannelRoomsGateway implements OnGatewayConnection<RealtimeSocket> {
  private readonly logger = new Logger('ChannelRoomsGateway');

  constructor(
    private readonly rooms: ChannelRoomsService,
    private readonly presence: RealtimePresence,
  ) {}

  handleConnection(socket: RealtimeSocket): void {
    socket.on('disconnecting', () => {
      const userId = socket.data.user?.id;
      if (!userId) return;
      for (const room of socket.rooms) {
        const channelId = channelIdOfRoom(room);
        if (channelId) this.presence.left(channelId, userId, socket.id);
      }
    });
  }

  @SubscribeMessage(REALTIME_REQUESTS.channelEnter)
  enter(
    @ConnectedSocket() socket: RealtimeSocket,
    @MessageBody() body: unknown,
  ): Promise<ChannelEnterAck> {
    return this.acknowledge(async () => {
      const channelId = channelIdOf(body);
      const userId = userIdOf(socket);
      await this.rooms.assertCanEnter(userId, channelId);
      const reentering = socket.rooms.has(channelRoom(channelId));
      await socket.join(channelRoom(channelId));
      try {
        await this.rooms.assertCanEnter(userId, channelId);
      } catch (error) {
        await socket.leave(channelRoom(channelId));
        throw error;
      }
      const present = reentering
        ? await this.presence.reentered(channelId, userId, socket.id)
        : this.presence.entered(channelId, userId, socket.id);
      return { ok: true, present } as const;
    });
  }

  @SubscribeMessage(REALTIME_REQUESTS.channelExit)
  exit(
    @ConnectedSocket() socket: RealtimeSocket,
    @MessageBody() body: unknown,
  ): Promise<ChannelRoomAck> {
    return this.acknowledge(async () => {
      const channelId = channelIdOf(body);
      await socket.leave(channelRoom(channelId));
      this.presence.left(channelId, userIdOf(socket), socket.id);
      return { ok: true } as const;
    });
  }

  private async acknowledge<T extends { readonly ok: true }>(
    action: () => Promise<T>,
  ): Promise<T | ChannelRoomRejection> {
    try {
      return await action();
    } catch (exception) {
      const { status, body } = errorResponseOf(exception);
      if (status >= 500) {
        const failure = exception instanceof Error ? exception : new Error(String(exception));
        this.logger.error(failure.message, failure.stack ?? '');
      }
      return { ok: false, status, error: body };
    }
  }
}

function userIdOf(socket: RealtimeSocket): string {
  // 認証のミドルウェアを通らずに接続は確立しない。ここに来て利用者が無いのは組み立ての誤りである。
  const user = socket.data.user;
  if (!user) throw new Error('認証を通らない接続から要求が届いた');
  return user.id;
}
