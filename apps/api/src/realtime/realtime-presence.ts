import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import type { PresenceChangedPayload } from '@workspace-chat/shared';
import { PresenceRegistry } from './presence-registry';
import { RealtimeGateway, channelRoom } from './realtime.gateway';

/** 他のタスクへ在席の変化を知らせるサーバー間の通知（serverSideEmit）の名前。クライアントとはやりとりしない。 */
const ENTERED = 'presence:server:entered';
const LEFT = 'presence:server:left';
const USER_REMOVED = 'presence:server:user-removed';

type Entered = { channelId: string; userId: string; socketId: string };
type UserRemoved = { channelIds: string[]; userId: string };

/**
 * 在席の変化を配る（F-22。機能一覧 9.2「在席の変化は利用者単位で配る」「タスクをまたぐ在席」）。
 *
 * - **利用者の最初の接続が部屋に入ったときと、最後の接続が外れたときにだけ、そのチャンネルの部屋へ `presence:changed` を送る**
 *   （同じ利用者の別の接続が残っている間は送らない）。**外れる契機（退室・切断・キック・退出）はどれでも同じ**
 * - **他のタスクへはサーバー間の通知で知らせ、受け取った側は一覧を更新するだけにする**
 *   （クライアントへの配信は、送った側の部屋への送信がアダプタを通って届く）
 * - 部屋への送信とサーバー間の通知の失敗は、アダプタが例外にしない（realtime-valkey.ts・Redis アダプタの serverSideEmit）
 */
@Injectable()
export class RealtimePresence implements OnApplicationBootstrap {
  constructor(
    private readonly gateway: RealtimeGateway,
    private readonly registry: PresenceRegistry,
  ) {}

  onApplicationBootstrap(): void {
    const server = this.gateway.server;
    server.on(ENTERED, ({ channelId, userId, socketId }: Entered) => {
      this.registry.add(channelId, userId, socketId);
    });
    server.on(LEFT, ({ channelId, userId, socketId }: Entered) => {
      this.registry.remove(channelId, userId, socketId);
    });
    server.on(USER_REMOVED, ({ channelIds, userId }: UserRemoved) => {
      for (const channelId of channelIds) this.registry.removeUser(channelId, userId);
    });
  }

  /** 接続が部屋に入った。その時点で部屋に入っている参加者（利用者 ID）を返す。 */
  entered(channelId: string, userId: string, socketId: string): string[] {
    if (this.registry.add(channelId, userId, socketId)) this.broadcast(channelId, userId, true);
    this.gateway.server.serverSideEmit(ENTERED, { channelId, userId, socketId } satisfies Entered);
    return this.registry.usersIn(channelId);
  }

  /**
   * 既に部屋に入っている接続が入室し直した（画面の側の5分ごとの取り直し。機能一覧 9.2）。
   * **一覧を取り直してから返す**——このタスクの一覧は通知の取りこぼしでずれうるため、そのまま返すと表示のずれが5分を超えうる。
   */
  async reentered(channelId: string, userId: string, socketId: string): Promise<string[]> {
    await this.registry.refreshOne(channelId);
    return this.entered(channelId, userId, socketId);
  }

  /** 接続が部屋から外れた（退室・切断）。 */
  left(channelId: string, userId: string, socketId: string): void {
    if (this.registry.remove(channelId, userId, socketId)) this.broadcast(channelId, userId, false);
    this.gateway.server.serverSideEmit(LEFT, { channelId, userId, socketId } satisfies Entered);
  }

  /** 利用者のすべての接続が、それらのチャンネルの部屋から外された（キック・退出）。 */
  userRemoved(channelIds: readonly string[], userId: string): void {
    for (const channelId of channelIds) {
      if (this.registry.removeUser(channelId, userId)) this.broadcast(channelId, userId, false);
    }
    this.gateway.server.serverSideEmit(USER_REMOVED, {
      channelIds: [...channelIds],
      userId,
    } satisfies UserRemoved);
  }

  private broadcast(channelId: string, userId: string, present: boolean): void {
    const payload: PresenceChangedPayload = {
      channelId,
      userId,
      present,
      sentAt: new Date().toISOString(),
    };
    this.gateway.server.to(channelRoom(channelId)).emit('presence:changed', payload);
  }
}
