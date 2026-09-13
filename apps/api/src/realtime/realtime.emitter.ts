import { Injectable } from '@nestjs/common';
import type { RealtimeEventName } from '@workspace-chat/shared';
import { RealtimeGateway, channelRoom, userRoom } from './realtime.gateway';

/**
 * 配信の出口。**複数の部屋へは1回で送る**——Socket.IO は複数の部屋へ1回で送ると和集合をとり、両方に入っている接続にも1回だけ届ける
 * （公式文書 Rooms。機能一覧 5.2「チャンネルの部屋と利用者の部屋へ分けて2回送ってはならない」）。
 *
 * **宛先を受け取る資格は、呼ぶ側が確かめてから渡す**（5.2「利用者の部屋を宛先に加えるなら、加える利用者がその値を受け取る資格を持つことを確認する」）。
 */
@Injectable()
export class RealtimeEmitter {
  constructor(private readonly gateway: RealtimeGateway) {}

  toUsers(userIds: readonly string[], event: RealtimeEventName, payload: unknown): void {
    // **宛先が空なら送らない。** Socket.IO は部屋を1つも指定しない配信を、名前空間の全接続へ送る。
    if (userIds.length === 0) return;
    this.gateway.server.to(userIds.map(userRoom)).emit(event, payload);
  }

  /** チャンネルの部屋へ送る（チャンネル本体のイベント。機能一覧 5.2）。受け取れるのは入室の関門を通って部屋に入っている接続だけである。 */
  toChannel(channelId: string, event: RealtimeEventName, payload: unknown): void {
    this.gateway.server.to(channelRoom(channelId)).emit(event, payload);
  }
}
