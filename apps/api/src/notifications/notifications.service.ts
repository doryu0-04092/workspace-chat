import { Injectable, NotFoundException } from '@nestjs/common';
import type { paths } from '@workspace-chat/shared';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma.service';
import { DM_MESSAGE_SELECT, toDmMessage } from '../workspaces/dms.service';
import { MESSAGE_SELECT, toMessages } from '../workspaces/messages.service';

export type NotificationPage =
  paths['/users/me/notifications']['get']['responses'][200]['content']['application/json'];

type PageQuery = { before?: string; limit?: string | number };

/**
 * 本人が読んでよい通知の条件（F-26。機能一覧 10.3。CLAUDE.md 2）。**一覧と既読化の両方がこれを通す**——片方だけに条件を書くと、
 * 一覧に出ない通知を既読化で探れる。
 *
 * - **本人の通知だけ**（`userId`。トークンから導いた利用者）
 * - **いまそのチャンネルの参加者であること**（`ChannelMember` の有無）——チャンネル単位のキック・退出では通知の行が残るため、
 *   ここで落とさないと、抜けたプライベートチャンネルの本文が通知の一覧から読める。参加の行は `Membership` を参照するため、
 *   ワークスペースから外れていれば参加も無い（通知の行も `Membership` から連鎖して消える）
 * - **削除済みのメッセージの通知は出さない**（本文を返さないメッセージへ案内しない）
 */
function readableBy(userId: string): Prisma.NotificationWhereInput {
  return {
    userId,
    channel: { members: { some: { userId } } },
    message: { deletedAt: null },
  };
}

/**
 * 本人が読んでよい DM の通知の条件（#623）。一覧と既読化の両方がこれを通す（`readableBy` と同じ理由）。
 * - **本人の通知だけ**。ワークスペースから抜けた利用者の行は `Membership` から連鎖して消える
 * - **削除済みのメッセージの通知は出さない**
 */
function dmReadableBy(userId: string): Prisma.DmNotificationWhereInput {
  return { userId, message: { deletedAt: null } };
}

/**
 * 受け取った通知の一覧と既読化（F-26。機能一覧 10.3）。通知の行は、メンションの対象を保存するのと同じトランザクションで作る
 * （`mention-notifications.ts`。この経路は作らない）。
 */
@Injectable()
export class NotificationsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 新しい順（id の降順）の1ページ。`before` より古いものを `limit + 1` 件引き、続きの有無を決める（`OFFSET` を使わない）。
   * 既定値（50）と範囲（1〜100）は仕様の `limit` が持ち、openapi-validation.ts が要求に入れてから届く。
   */
  async list(userId: string, query: PageQuery): Promise<NotificationPage> {
    const limit = Number(query.limit);
    // チャンネルの通知と DM の通知（#623）を、それぞれ `limit + 1` 件まで新しい順に引いて合わせる。id は両方とも UUIDv7 で時刻の順に並ぶ
    const dmRows = await this.prisma.dmNotification.findMany({
      where: {
        ...dmReadableBy(userId),
        ...(query.before === undefined ? {} : { id: { lt: query.before } }),
      },
      orderBy: { id: 'desc' },
      take: limit + 1,
      select: {
        id: true,
        createdAt: true,
        readAt: true,
        dm: { select: { id: true, workspace: { select: { id: true, name: true } } } },
        message: { select: DM_MESSAGE_SELECT },
      },
    });
    const rows = await this.prisma.notification.findMany({
      where: {
        ...readableBy(userId),
        ...(query.before === undefined ? {} : { id: { lt: query.before } }),
      },
      orderBy: { id: 'desc' },
      take: limit + 1,
      select: {
        id: true,
        kind: true,
        createdAt: true,
        readAt: true,
        channel: {
          select: { id: true, name: true, workspace: { select: { id: true, name: true } } },
        },
        message: { select: MESSAGE_SELECT },
      },
    });
    // 合わせてから limit 件に切る（先に切ると、続きの有無が分からなくなる）
    const page = rows;
    const messages = await toMessages(
      this.prisma,
      page.map(({ message }) => message),
    );
    const channelNotifications = page.map((row, index) => {
      const message = messages[index];
      if (!message) throw new Error('通知のメッセージを応答の形にできなかった');
      return {
        id: row.id,
        kind: row.kind,
        createdAt: row.createdAt.toISOString(),
        readAt: row.readAt?.toISOString() ?? null,
        workspace: row.channel.workspace,
        channel: { id: row.channel.id, name: row.channel.name },
        message,
      };
    });
    const dmNotifications = dmRows.map((row) => {
      const message = toDmMessage(row.message);
      return {
        id: row.id,
        kind: 'DM' as const,
        createdAt: row.createdAt.toISOString(),
        readAt: row.readAt?.toISOString() ?? null,
        workspace: row.dm.workspace,
        // 通知の宛先は相手だけなので、書き手がそのまま相手である（退会していれば null）
        dm: { id: row.dm.id, counterpart: message.author },
        message,
      };
    });
    const merged = [...channelNotifications, ...dmNotifications].sort((a, b) =>
      a.id < b.id ? 1 : a.id > b.id ? -1 : 0,
    );
    const notifications = merged.slice(0, limit);
    const hasMore = merged.length > limit;
    return { notifications, nextBefore: hasMore ? (notifications.at(-1)?.id ?? null) : null };
  }

  /**
   * 既読にする。**読んでよい通知でなければ、他の利用者の通知でも存在しない通知でも 404**（存在を認めない。CLAUDE.md 2）。
   * **既に既読なら時刻を変えない**（未読の行だけを書き換える）。
   */
  async markRead(userId: string, notificationId: string): Promise<void> {
    const found = await this.prisma.notification.findFirst({
      where: { id: notificationId, ...readableBy(userId) },
      select: { id: true },
    });
    if (found) {
      await this.prisma.notification.updateMany({
        where: { id: found.id, readAt: null },
        data: { readAt: new Date() },
      });
      return;
    }
    // DM の通知（#623）。どちらの表にも無ければ 404（他の利用者の通知も同じ）
    const foundDm = await this.prisma.dmNotification.findFirst({
      where: { id: notificationId, ...dmReadableBy(userId) },
      select: { id: true },
    });
    if (!foundDm) throw new NotFoundException();
    await this.prisma.dmNotification.updateMany({
      where: { id: foundDm.id, readAt: null },
      data: { readAt: new Date() },
    });
  }
}
