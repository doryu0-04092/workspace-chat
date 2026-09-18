import { HttpException, HttpStatus, Inject, Logger } from '@nestjs/common';
import { ThrottlerStorage } from '@nestjs/throttler';
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
  type RealtimeEventName,
  type TypingPayload,
} from '@workspace-chat/shared';
import { errorBodyForStatus, errorResponseOf } from '../error-response';
import { RealtimePresence } from '../realtime/realtime-presence';
import { RealtimeEmitter } from '../realtime/realtime.emitter';
import { type RealtimeSocket, channelIdOfRoom, channelRoom } from '../realtime/realtime.gateway';
import { ChannelRoomsService, channelIdOf } from './channel-rooms.service';

/**
 * 入室要求の上限（利用者単位。決定・2026-09-13・依頼側。機能一覧 9.2）。
 *
 * **踏むと壊れる**: web の送り直しの間隔（`ENTER_RETRY_DELAY_MS`。
 * `apps/web/src/realtime/use-channel-realtime.ts`）はこの `ttlMs` に依存する。
 * ここだけ値を変えると、送り直しても窓が明けておらず再び断られ続ける。
 */
export const CHANNEL_ENTER_LIMIT = { limit: 60, ttlMs: 60 * 1000 } as const;
const CHANNEL_ENTER_THROTTLER = 'channel-enter';

/**
 * 入力中（`typing:start` / `typing:stop`）の上限（利用者単位。2つの名前を合わせて数える。実装時に決めた値。機能一覧 13.3）。
 * 1件ごとに参加を DB で確かめるための歯止めである（CWE-770）。画面は入力中の知らせを3秒に1回までしか送らないため、
 * 1つのタブで打ち続けても1分に20回ほどであり、60 は3つのタブで同時に打っても届く値にした。
 */
export const TYPING_LIMIT = { limit: 60, ttlMs: 60 * 1000 } as const;
const TYPING_THROTTLER = 'typing';
const TYPING_START = 'typing:start' satisfies RealtimeEventName;
const TYPING_STOP = 'typing:stop' satisfies RealtimeEventName;

/**
 * チャンネルの部屋への入室要求・退室要求（機能一覧 9.2「部屋（Socket.IO の room）」）と、在席の変化（F-22）。接続の入口と認証は realtime.gateway.ts が持つ。
 *
 * - **断るときは acknowledgement で、HTTP と同じ状態コードとエラーの本体を返す**（本体は error-response.ts の `errorResponseOf`。
 *   入室の処理で個別の文言を書かない）。想定外の失敗は例外のメッセージを渡さず `internal_error` にし、ログに error で残す
 * - **入室要求は、利用者単位で `CHANNEL_ENTER_LIMIT` までに限る**——本体の形を見る前に数え（形の誤った要求も1回）、
 *   超えたら 429 で断り、`rate_limit_exceeded`（`limit: 'user'`）を warn で残す（ErrorResponseFilter を通らないため、ここで残す）。退室要求は数えない
 * - **確かめてから部屋に入れた後に、もう一度確かめ、参加者でなくなっていれば外して断る**——確かめてから入れるまでの間に
 *   キック・退出が走ると、その処理が外す時点ではこの接続はまだ部屋に入っておらず、参加者でない接続が部屋に残る。
 *   **入室し直しの取り消しなら、在席からも外す**（要求の前から在席に載っている。外れる契機はどれでも同じ。機能一覧 9.2）
 * - **入っていない部屋への退室要求は何もしない**——退室要求は数えないため、在席の変化や他のタスクへの通知（Valkey への publish）を起こすと、
 *   1本の接続から際限なく起こせる（機能一覧 9.2）
 * - **入室できたら、その時点で部屋に入っている参加者を acknowledgement で返す**（在席を画面へ渡す経路は部屋の側だけ。9.2）
 * - **切断では、部屋から出る前（`disconnecting`）に入っていたチャンネルの部屋を取り出して在席の変化を配る**
 *   （`disconnect` を待つと入っていた部屋を取り出せない。公式文書 Server socket instance）
 * - **入力中（`typing:start` / `typing:stop`。F-34）は、1件ごとに入室と同じ確かめ（退会していない・参加者である。断り方も同じ）を通してから、
 *   そのチャンネルの部屋へ配る**（機能一覧 5.2「チャンネルのイベントを受け付けるたびに、送信元が該当チャンネルの参加者であることを確認する」）。
 *   `TYPING_LIMIT` までに限り、数え方は入室要求と同じ（本体の形を見る前に数える）
 */
@WebSocketGateway()
export class ChannelRoomsGateway implements OnGatewayConnection<RealtimeSocket> {
  private readonly logger = new Logger('ChannelRoomsGateway');

  constructor(
    private readonly rooms: ChannelRoomsService,
    private readonly presence: RealtimePresence,
    private readonly emitter: RealtimeEmitter,
    @Inject(ThrottlerStorage) private readonly limits: ThrottlerStorage,
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
      const userId = userIdOf(socket);
      await this.count(
        userId,
        CHANNEL_ENTER_THROTTLER,
        CHANNEL_ENTER_LIMIT,
        REALTIME_REQUESTS.channelEnter,
      );
      const channelId = channelIdOf(body);
      await this.rooms.assertCanEnter(userId, channelId);
      const reentering = socket.rooms.has(channelRoom(channelId));
      if (reentering) await this.presence.refresh(channelId);
      await socket.join(channelRoom(channelId));
      try {
        await this.rooms.assertCanEnter(userId, channelId);
      } catch (error) {
        await socket.leave(channelRoom(channelId));
        if (reentering) this.presence.left(channelId, userId, socket.id);
        throw error;
      }
      const present = this.presence.entered(channelId, userId, socket.id);
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
      if (!socket.rooms.has(channelRoom(channelId))) return { ok: true } as const;
      await socket.leave(channelRoom(channelId));
      this.presence.left(channelId, userIdOf(socket), socket.id);
      return { ok: true } as const;
    });
  }

  @SubscribeMessage(TYPING_START)
  typingStart(
    @ConnectedSocket() socket: RealtimeSocket,
    @MessageBody() body: unknown,
  ): Promise<ChannelRoomAck> {
    return this.relayTyping(socket, body, TYPING_START);
  }

  @SubscribeMessage(TYPING_STOP)
  typingStop(
    @ConnectedSocket() socket: RealtimeSocket,
    @MessageBody() body: unknown,
  ): Promise<ChannelRoomAck> {
    return this.relayTyping(socket, body, TYPING_STOP);
  }

  private relayTyping(
    socket: RealtimeSocket,
    body: unknown,
    event: typeof TYPING_START | typeof TYPING_STOP,
  ): Promise<ChannelRoomAck> {
    return this.acknowledge(async () => {
      const userId = userIdOf(socket);
      await this.count(userId, TYPING_THROTTLER, TYPING_LIMIT, event);
      const channelId = channelIdOf(body);
      const user = await this.rooms.assertCanEnter(userId, channelId);
      const payload: TypingPayload = { channelId, user, sentAt: new Date().toISOString() };
      this.emitter.toChannel(channelId, event, payload);
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

  /** 利用者単位で数え、上限を超えたら 429 で断り、`rate_limit_exceeded` を warn で残す（`request` は要求の名前）。 */
  private async count(
    userId: string,
    throttler: string,
    { limit, ttlMs }: { readonly limit: number; readonly ttlMs: number },
    request: string,
  ): Promise<void> {
    const { isBlocked } = await this.limits.increment(
      `${throttler}:${userId}`,
      ttlMs,
      limit,
      ttlMs,
      throttler,
    );
    if (!isBlocked) return;
    this.logger.warn({
      event: 'rate_limit_exceeded',
      limit: 'user',
      userId,
      request,
    });
    throw new HttpException(
      errorBodyForStatus(HttpStatus.TOO_MANY_REQUESTS),
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}

function userIdOf(socket: RealtimeSocket): string {
  // 認証のミドルウェアを通らずに接続は確立しない。ここに来て利用者が無いのは組み立ての誤りである。
  const user = socket.data.user;
  if (!user) throw new Error('認証を通らない接続から要求が届いた');
  return user.id;
}
