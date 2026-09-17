import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { components } from '@workspace-chat/shared';
import { PrismaService } from '../prisma.service';
import { USER_SUMMARY_SELECT, toUserSummary } from '../users/user-summary';
import { assertChannelParticipant, channelFor } from './channel-access';
import { CHANNEL_ARCHIVED, PIN_LIMIT_REACHED } from './channel-errors';
import { lockChannelRow } from './channel-row-lock';
import { MESSAGE_SELECT, toMessages } from './messages.service';
import { WorkspacesService } from './workspaces.service';

export type PinnedMessage = components['schemas']['PinnedMessage'];
export type PinList = components['schemas']['PinList'];

type Tx = Parameters<Parameters<PrismaService['$transaction']>[0]>[0];

/**
 * 1つのチャンネルにピン留めできるメッセージの上限（F-33。機能一覧 13.2。実装時に決めた値）。削除済みのメッセージのピン留めは数えない。
 * **一覧を1回で全部返すため、その大きさに上限を置く**（ページングを持たない。CWE-770）。100 は Slack の上限と同じ値にした。
 * **変えるなら、仕様（openapi.yaml の `PinList.pins` の `maxItems` と各パスの説明）も同じ値にする。**
 */
export const PIN_LIMIT = 100;

const PIN_SELECT = {
  createdAt: true,
  pinnedBy: { select: { ...USER_SUMMARY_SELECT, deletedAt: true } },
  message: { select: MESSAGE_SELECT },
} as const;

/** ピン留めの行を応答にする。メッセージはまとめて組み立てる（1件ずつ引かない）。退会したピン留めした人は null（機能一覧 1.5）。 */
async function pinnedOf(
  db: Parameters<typeof toMessages>[0],
  rows: {
    createdAt: Date;
    pinnedBy: { id: string; loginId: string; displayName: string; deletedAt: Date | null };
    message: Parameters<typeof toMessages>[1][number];
  }[],
): Promise<PinnedMessage[]> {
  const messages = await toMessages(
    db,
    rows.map(({ message }) => message),
  );
  return rows.map((row, i) => {
    const message = messages[i];
    if (!message) throw new Error('ピン留めの行から応答のメッセージを作れなかった');
    return {
      message,
      pinnedBy: row.pinnedBy.deletedAt === null ? toUserSummary(row.pinnedBy) : null,
      pinnedAt: row.createdAt.toISOString(),
    };
  });
}

/**
 * ピン留め（F-33。機能一覧 13.2。区分: 提案・承認済〔2026-09-03〕）。
 *
 * - **読めるのも付け外しできるのも参加者だけ**。所属していなければ 404（`membershipOf`）、所属していれば2段階（`assertChannelParticipant`）。**オーナーの例外は及ばない**
 * - **外せるのはそのチャンネルの参加者なら誰でもよい**（ピン留めした本人・オーナーに限らない。付けられる人と外せる人を揃える。Slack と同じ。13.2 の「判断が必要な点」の決定）
 * - 付け外しの判定の順: 所属 → 参加の2段階 → メッセージの有無（そのチャンネルに無い・削除済みは 404）→ アーカイブ済み（409）→ 件数の上限（409。付けるときだけ）
 * - **付け外しはチャンネルの行を `FOR UPDATE` で掴んでから読む**——アーカイブ・復元の確定を待ってから読み（機能一覧 3.2）、
 *   同じチャンネルへの同時のピン留めを直列にして、件数の上限を超えない
 * - **配信しない**（要件定義書 4.1 の配信の対象イベントに無い。「この範囲外の変化は画面に即時反映されない」）
 */
@Injectable()
export class PinsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly workspaces: WorkspacesService,
  ) {}

  async list(userId: string, workspaceId: string, channelId: string): Promise<PinList> {
    await this.workspaces.membershipOf(userId, workspaceId);
    assertChannelParticipant(await channelFor(this.prisma, userId, workspaceId, channelId));
    const rows = await this.prisma.messagePin.findMany({
      where: { channelId, message: { deletedAt: null } },
      orderBy: { id: 'desc' },
      take: PIN_LIMIT,
      select: PIN_SELECT,
    });
    return { pins: await pinnedOf(this.prisma, rows) };
  }

  async pin(
    userId: string,
    workspaceId: string,
    channelId: string,
    messageId: string,
  ): Promise<PinnedMessage> {
    return this.write(userId, workspaceId, channelId, messageId, async (tx) => {
      const existing = await tx.messagePin.findUnique({
        where: { messageId },
        select: PIN_SELECT,
      });
      if (!existing) {
        const pinned = await tx.messagePin.count({
          where: { channelId, message: { deletedAt: null } },
        });
        if (pinned >= PIN_LIMIT) throw new ConflictException(PIN_LIMIT_REACHED);
      }
      const row =
        existing ??
        (await tx.messagePin.create({
          data: { messageId, channelId, pinnedById: userId },
          select: PIN_SELECT,
        }));
      const [result] = await pinnedOf(tx, [row]);
      if (!result) throw new Error('ピン留めの行から応答を作れなかった');
      return result;
    });
  }

  async unpin(
    userId: string,
    workspaceId: string,
    channelId: string,
    messageId: string,
  ): Promise<void> {
    await this.write(userId, workspaceId, channelId, messageId, async (tx) => {
      await tx.messagePin.deleteMany({ where: { messageId, channelId } });
    });
  }

  /** 判定の順どおりに確かめてから `change` を呼ぶ（上のクラスの説明）。 */
  private async write<T>(
    userId: string,
    workspaceId: string,
    channelId: string,
    messageId: string,
    change: (tx: Tx) => Promise<T>,
  ): Promise<T> {
    await this.workspaces.membershipOf(userId, workspaceId);
    return this.prisma.$transaction(async (tx) => {
      await lockChannelRow(tx, workspaceId, channelId, 'update');
      const channel = await channelFor(tx, userId, workspaceId, channelId);
      assertChannelParticipant(channel);
      const message = await tx.message.findFirst({
        where: { id: messageId, channelId, deletedAt: null },
        select: { id: true },
      });
      if (!message) throw new NotFoundException();
      if (channel.archived) throw new ConflictException(CHANNEL_ARCHIVED);
      return change(tx);
    });
  }
}
