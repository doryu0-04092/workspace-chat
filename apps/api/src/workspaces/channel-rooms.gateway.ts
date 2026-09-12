import { Logger } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import { type ChannelRoomAck, REALTIME_REQUESTS } from '@workspace-chat/shared';
import { errorResponseOf } from '../error-response';
import { type RealtimeSocket, channelRoom } from '../realtime/realtime.gateway';
import { ChannelRoomsService, channelIdOf } from './channel-rooms.service';

/**
 * チャンネルの部屋への入室要求・退室要求（機能一覧 9.2「部屋（Socket.IO の room）」）。接続の入口と認証は realtime.gateway.ts が持つ。
 *
 * - **断るときは acknowledgement で、HTTP と同じ状態コードとエラーの本体を返す**（本体は error-response.ts の `errorResponseOf`。
 *   入室の処理で個別の文言を書かない）。想定外の失敗は例外のメッセージを渡さず `internal_error` にし、ログに error で残す
 * - **確かめてから部屋に入れた後に、もう一度確かめ、参加者でなくなっていれば外して断る**——確かめてから入れるまでの間に
 *   キック・退出が走ると、その処理が外す時点ではこの接続はまだ部屋に入っておらず、参加者でない接続が部屋に残る
 */
@WebSocketGateway()
export class ChannelRoomsGateway {
  private readonly logger = new Logger('ChannelRoomsGateway');

  constructor(private readonly rooms: ChannelRoomsService) {}

  @SubscribeMessage(REALTIME_REQUESTS.channelEnter)
  enter(
    @ConnectedSocket() socket: RealtimeSocket,
    @MessageBody() body: unknown,
  ): Promise<ChannelRoomAck> {
    return this.acknowledge(async () => {
      const channelId = channelIdOf(body);
      const userId = userIdOf(socket);
      await this.rooms.assertCanEnter(userId, channelId);
      await socket.join(channelRoom(channelId));
      try {
        await this.rooms.assertCanEnter(userId, channelId);
      } catch (error) {
        await socket.leave(channelRoom(channelId));
        throw error;
      }
    });
  }

  @SubscribeMessage(REALTIME_REQUESTS.channelExit)
  exit(
    @ConnectedSocket() socket: RealtimeSocket,
    @MessageBody() body: unknown,
  ): Promise<ChannelRoomAck> {
    return this.acknowledge(async () => {
      await socket.leave(channelRoom(channelIdOf(body)));
    });
  }

  private async acknowledge(action: () => Promise<void>): Promise<ChannelRoomAck> {
    try {
      await action();
      return { ok: true };
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
