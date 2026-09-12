import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { RealtimeGateway, channelRoom } from './realtime.gateway';

/** 一覧を取り直す間隔（機能一覧 9.2「各タスクは5分ごとに一覧を取り直す」）。 */
export const PRESENCE_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

type Connection = { readonly id: string; readonly userId: string };

/**
 * チャンネルごとの在席の一覧（このタスクのメモリ。機能一覧 9.2「タスクをまたぐ在席」。**Valkey には置かない**——要件定義書 4.2）。
 *
 * - **在席は利用者単位**: チャンネル → 利用者 → 部屋に入っている接続の ID。**最初の1本が入ったときと最後の1本が外れたときだけ、在席が変わったと返す**
 * - 他のタスクの接続も、サーバー間の通知（realtime-presence.ts）で同じ一覧に載せる。**取りこぼした通知によるずれは、5分ごとの取り直しで直る**
 * - **取り直しに失敗したチャンネルは今の一覧を残し、例外にしない**（要件定義書 4.2。Valkey が止まっていると、
 *   Redis アダプタの fetchSockets は購読者数の問い合わせで失敗する——`@socket.io/redis-adapter` の fetchSockets と serverCount）
 */
@Injectable()
export class PresenceRegistry implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('PresenceRegistry');
  private readonly channels = new Map<string, Map<string, Set<string>>>();
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly gateway: RealtimeGateway) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => void this.refresh(), PRESENCE_REFRESH_INTERVAL_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  /** 接続を足す。その利用者の最初の接続なら true。 */
  add(channelId: string, userId: string, socketId: string): boolean {
    const users = this.channels.get(channelId) ?? new Map<string, Set<string>>();
    this.channels.set(channelId, users);
    const sockets = users.get(userId);
    if (sockets) {
      sockets.add(socketId);
      return false;
    }
    users.set(userId, new Set([socketId]));
    return true;
  }

  /** 接続を外す。その利用者の最後の接続だったなら true。 */
  remove(channelId: string, userId: string, socketId: string): boolean {
    const users = this.channels.get(channelId);
    const sockets = users?.get(userId);
    if (!users || !sockets?.delete(socketId) || sockets.size > 0) return false;
    users.delete(userId);
    if (users.size === 0) this.channels.delete(channelId);
    return true;
  }

  /** その利用者の接続をすべて外す。在席していたなら true。 */
  removeUser(channelId: string, userId: string): boolean {
    const users = this.channels.get(channelId);
    if (!users?.delete(userId)) return false;
    if (users.size === 0) this.channels.delete(channelId);
    return true;
  }

  usersIn(channelId: string): string[] {
    return [...(this.channels.get(channelId)?.keys() ?? [])];
  }

  /** そのチャンネルの一覧を、部屋に入っている接続で置き換える。 */
  replace(channelId: string, connections: readonly Connection[]): void {
    const users = new Map<string, Set<string>>();
    for (const { id, userId } of connections) {
      const sockets = users.get(userId) ?? new Set<string>();
      sockets.add(id);
      users.set(userId, sockets);
    }
    if (users.size === 0) this.channels.delete(channelId);
    else this.channels.set(channelId, users);
  }

  /** 一覧にあるチャンネルごとに、部屋に入っている接続（全タスク）を問い合わせて置き換える。 */
  async refresh(): Promise<void> {
    let failed = 0;
    for (const channelId of [...this.channels.keys()]) {
      if (!(await this.refreshChannel(channelId))) failed += 1;
    }
    this.warnIfFailed(failed);
  }

  /** そのチャンネルの一覧を取り直す（入室し直した接続に返す前。機能一覧 9.2 の画面の側の取り直し）。失敗したら今の一覧を残す。 */
  async refreshOne(channelId: string): Promise<void> {
    this.warnIfFailed((await this.refreshChannel(channelId)) ? 0 : 1);
  }

  private async refreshChannel(channelId: string): Promise<boolean> {
    try {
      const sockets = await this.gateway.server.in(channelRoom(channelId)).fetchSockets();
      this.replace(
        channelId,
        sockets.flatMap((socket) => {
          const userId = (socket.data as { user?: { id: string } }).user?.id;
          return userId === undefined ? [] : [{ id: socket.id, userId }];
        }),
      );
      return true;
    } catch {
      return false;
    }
  }

  private warnIfFailed(failed: number): void {
    if (failed > 0) {
      this.logger.warn(`在席の一覧を取り直せなかったため、今の一覧を残す（${failed} チャンネル）`);
    }
  }
}
