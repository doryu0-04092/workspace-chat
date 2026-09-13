import { Injectable } from '@nestjs/common';
import { RealtimePresence } from './realtime-presence';
import { RealtimeGateway, channelRoom, userRoom } from './realtime.gateway';

/**
 * 接続を部屋から外す（機能一覧 9.2「部屋（Socket.IO の room）」・2.2）。
 *
 * **参加資格を失った利用者（チャンネル・ワークスペースからのキック、退出）の接続を、チャンネルの部屋から外し、
 * 在席していた部屋にだけ在席の変化を配る。**
 * 利用者の部屋に入っている接続を対象にするため、その利用者のすべてのタブ・端末の接続に当たり、
 * Redis アダプタを通して他のタスクの接続にも効く（公式文書 Server instance「Utility methods」）。
 * **外さないと、確立済みの接続が部屋への配信を受け続ける**（2.2）。
 */
@Injectable()
export class RealtimeRooms {
  constructor(
    private readonly gateway: RealtimeGateway,
    private readonly presence: RealtimePresence,
  ) {}

  removeFromChannels(userId: string, channelIds: readonly string[]): void {
    if (channelIds.length === 0) return;
    this.gateway.server.in(userRoom(userId)).socketsLeave(channelIds.map(channelRoom));
    this.presence.userRemoved(channelIds, userId);
  }
}
