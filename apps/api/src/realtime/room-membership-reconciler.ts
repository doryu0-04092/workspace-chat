import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { REALTIME_VALKEY_CLIENTS, type RealtimeValkeyClients } from './realtime-valkey';
import { RealtimeGateway, channelIdOfRoom, channelRoom } from './realtime.gateway';

/** 照合の間隔（決定・2026-09-13・依頼側）。 */
export const ROOM_RECONCILE_INTERVAL_MS = 5 * 60 * 1000;

/**
 * チャンネルの部屋の参加の照合（決定・2026-09-13・依頼側）。
 *
 * - **このタスクの接続が入っているチャンネルの部屋を、参加の行（退会していない利用者の所属を通る `ChannelMember`）と照合し、
 *   参加者でない接続を部屋から外す**——Valkey が止まっている間のキック・退出では、部屋から外す通知（`socketsLeave`）が
 *   他のタスクに届かず、参加者でなくなった接続が部屋に残るため（要件定義書 4.8 の3）
 * - **契機は5分ごとと、Valkey への publish が戻ったとき**。見るのは自タスクの接続だけ（`local`）——Valkey が止まっていても照合できる
 * - 照合に失敗しても例外にせず、warn を残す（次の契機でやり直す）
 */
@Injectable()
export class RoomMembershipReconciler implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('RoomMembershipReconciler');
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly gateway: RealtimeGateway,
    private readonly prisma: PrismaService,
    @Inject(REALTIME_VALKEY_CLIENTS) private readonly valkey: RealtimeValkeyClients,
  ) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => void this.reconcile(), ROOM_RECONCILE_INTERVAL_MS);
    this.timer.unref?.();
    this.valkey.onPublishRecovered(() => void this.reconcile());
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  async reconcile(): Promise<void> {
    try {
      const sockets = await this.gateway.server.local.fetchSockets();
      const entries = sockets.flatMap((socket) => {
        const userId = (socket.data as { user?: { id: string } }).user?.id;
        if (userId === undefined) return [];
        return [...socket.rooms].flatMap((room) => {
          const channelId = channelIdOfRoom(room);
          return channelId === undefined ? [] : [{ socket, userId, channelId }];
        });
      });
      if (entries.length === 0) return;
      const rows = await this.prisma.channelMember.findMany({
        where: {
          userId: { in: [...new Set(entries.map(({ userId }) => userId))] },
          channelId: { in: [...new Set(entries.map(({ channelId }) => channelId))] },
          membership: { user: { deletedAt: null } },
        },
        select: { userId: true, channelId: true },
      });
      const participating = new Set(rows.map(({ userId, channelId }) => `${userId}/${channelId}`));
      for (const { socket, userId, channelId } of entries) {
        if (!participating.has(`${userId}/${channelId}`)) socket.leave(channelRoom(channelId));
      }
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      this.logger.warn(
        `チャンネルの部屋の参加を照合できなかった（次の契機でやり直す）: ${failure.message}`,
      );
    }
  }
}
