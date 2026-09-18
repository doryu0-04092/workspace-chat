import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { ReactionChangedPayload, components } from '@workspace-chat/shared';
import { isSingleEmoji } from '../emoji';
import { type ErrorResponse, errorBodyForStatus } from '../error-response';
import { PrismaService } from '../prisma.service';
import { RealtimeEmitter } from '../realtime/realtime.emitter';
import { assertChannelParticipant, lockedChannelFor } from './channel-access';
import { CHANNEL_ARCHIVED, REACTION_LIMIT_REACHED } from './channel-errors';
import { REACTION_KINDS_LIMIT, reactionsOf } from './reactions';
import { WorkspacesService } from './workspaces.service';

export type MessageReactions = components['schemas']['MessageReactions'];

type Tx = Parameters<Parameters<PrismaService['$transaction']>[0]>[0];

/**
 * メッセージの絵文字リアクションの付け外し（F-18。機能一覧 7）。
 *
 * - **判定の順**: 絵文字1つか（400）→ 所属（404）→ 参加の2段階（パブリック 403・プライベート 404。**オーナーの例外は及ばない**）→
 *   メッセージの有無（そのチャンネルに無い・削除済みは 404）→ アーカイブ済み（409 `channel_archived`）→ 種類の上限（409 `reaction_limit_reached`。付けるときだけ）。
 *   参加していない人に、メッセージの有無を漏らさない
 * - **チャンネルの行を共有ロックで掴んでからアーカイブ済みかを読む**（`lockedChannelFor`。機能一覧 3.2。投稿・編集と同じ）
 * - **メッセージの行を `FOR UPDATE` で掴んでから、行とカウンタ列を同じトランザクションで増減する**（要件定義書 4.1）——同じメッセージの付け外しを直列にし、
 *   件数の読み書き・種類の上限の判定・応答に載せるリアクションの全体を食い違わせない。削除（行を更新する）もこの掴みを待つため、削除の確定の後には付かない
 * - **同じ人の同じ絵文字は二重に付かない**（一意制約 `MessageReaction_messageId_userId_emoji_key`）。付けていれば・付けていなければ何も変えずに今のリアクションを返し、配らない
 * - **変わったら、確定の後にそのメッセージのリアクションの全体を `reaction:changed` としてチャンネルの部屋へ送る**（確定しなかった書き込みを配らない。機能一覧 5.2）
 */
@Injectable()
export class ReactionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly workspaces: WorkspacesService,
    private readonly emitter: RealtimeEmitter,
  ) {}

  add(
    userId: string,
    workspaceId: string,
    channelId: string,
    messageId: string,
    emoji: string,
  ): Promise<MessageReactions> {
    return this.change(userId, workspaceId, channelId, messageId, emoji, async (tx) => {
      const { count } = await tx.messageReaction.createMany({
        data: [{ messageId, userId, emoji }],
        skipDuplicates: true,
      });
      if (count === 0) return false;
      const counter = await tx.messageReactionCount.findUnique({
        where: { messageId_emoji: { messageId, emoji } },
        select: { id: true },
      });
      if (counter) {
        await tx.messageReactionCount.update({
          where: { id: counter.id },
          data: { count: { increment: 1 } },
        });
        return true;
      }
      const kinds = await tx.messageReactionCount.count({ where: { messageId } });
      if (kinds >= REACTION_KINDS_LIMIT) throw new ConflictException(REACTION_LIMIT_REACHED);
      await tx.messageReactionCount.create({ data: { messageId, emoji, count: 1 } });
      return true;
    });
  }

  remove(
    userId: string,
    workspaceId: string,
    channelId: string,
    messageId: string,
    emoji: string,
  ): Promise<MessageReactions> {
    return this.change(userId, workspaceId, channelId, messageId, emoji, async (tx) => {
      const { count } = await tx.messageReaction.deleteMany({
        where: { messageId, userId, emoji },
      });
      if (count === 0) return false;
      // 件数は 1 以上（検査制約）。最後の1件なら行ごと消し、そうでなければ減らす
      const { count: dropped } = await tx.messageReactionCount.deleteMany({
        where: { messageId, emoji, count: 1 },
      });
      if (dropped === 0) {
        await tx.messageReactionCount.update({
          where: { messageId_emoji: { messageId, emoji } },
          data: { count: { decrement: 1 } },
        });
      }
      return true;
    });
  }

  /**
   * 判定の順どおりに確かめてから `write` を呼び、変わったら（`write` が true を返したら）確定の後に配る。
   * **判定の順を変えない**（上のクラスの説明）。
   */
  private async change(
    userId: string,
    workspaceId: string,
    channelId: string,
    messageId: string,
    emoji: string,
    write: (tx: Tx) => Promise<boolean>,
  ): Promise<MessageReactions> {
    if (!isSingleEmoji(emoji)) {
      throw new BadRequestException({
        ...errorBodyForStatus(400),
        errors: [{ path: '/params/emoji', message: '絵文字1つにしてください' }],
      } satisfies ErrorResponse);
    }
    await this.workspaces.membershipOf(userId, workspaceId);
    const { reactions, changed } = await this.prisma.$transaction(async (tx) => {
      const channel = await lockedChannelFor(tx, userId, workspaceId, channelId);
      assertChannelParticipant(channel);
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "Message"
        WHERE "id" = ${messageId}::uuid AND "channelId" = ${channelId}::uuid AND "deletedAt" IS NULL
        FOR UPDATE
      `;
      if (locked.length === 0) throw new NotFoundException();
      if (channel.archived) throw new ConflictException(CHANNEL_ARCHIVED);
      const changed = await write(tx);
      const reactions = (await reactionsOf(tx, [messageId])).get(messageId) ?? [];
      return { reactions, changed };
    });
    const result: MessageReactions = { channelId, messageId, reactions };
    if (changed) {
      const payload: ReactionChangedPayload = { ...result, sentAt: new Date().toISOString() };
      this.emitter.toChannel(channelId, 'reaction:changed', payload);
    }
    return result;
  }
}
