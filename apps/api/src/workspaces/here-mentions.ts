import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { addMentionNotifications } from '../notifications/mention-notifications';
import { PrismaService } from '../prisma.service';
import { HereReceipts } from '../realtime/here-receipts';
import { PresenceRegistry } from '../realtime/presence-registry';
import { RealtimePresence } from '../realtime/realtime-presence';
import { RealtimeEmitter } from '../realtime/realtime.emitter';
import { announceUnreadTo } from './unread';

/**
 * そのチャンネルの参加者で、退会していない利用者の `User.id`。`except`（書いた本人）を渡すと除き、`among` を渡すと、その中から選ぶ。
 * **一斉メンション（F-21）の宛先に利用者の部屋を加えるときの資格の確認はこれを通す**（機能一覧 5.2「加える利用者がその値を受け取る資格を持つことを確認する」）。
 * **在席の一覧に載っていることを資格の根拠にしない**（一覧は古くなりうる。9.2）。
 */
export async function participantIds(
  db: Pick<PrismaService, '$queryRaw'>,
  channelId: string,
  { except, among }: { except?: string; among?: readonly string[] },
): Promise<string[]> {
  if (among?.length === 0) return [];
  const exceptCondition =
    except === undefined ? Prisma.empty : Prisma.sql`AND cm."userId" <> ${except}::uuid`;
  const amongCondition =
    among === undefined ? Prisma.empty : Prisma.sql`AND cm."userId" = ANY(${[...among]}::uuid[])`;
  const rows = await db.$queryRaw<{ userId: string }[]>`
    SELECT cm."userId" AS "userId"
    FROM "ChannelMember" cm
    JOIN "User" u ON u."id" = cm."userId" AND u."deletedAt" IS NULL
    WHERE cm."channelId" = ${channelId}::uuid ${exceptCondition} ${amongCondition}
  `;
  return rows.map(({ userId }) => userId);
}

/**
 * `@here` の宛先と、受け取りの記録（F-21。機能一覧 9.2「タスクをまたぐ在席」）。
 *
 * - **宛先は、送る時点で在席の一覧を取り直した結果の、そのチャンネルの部屋に入っている参加者**（書いた本人を除く）。
 *   **取り直しに失敗したら、このタスクが持っている一覧のまま**選ぶ（取り直しは失敗したとき今の一覧を残す。presence-registry.ts）。
 *   どちらの場合も、いま参加者で退会していない利用者だけに絞る（`participantIds`）
 * - **受け取りの確かめは、投稿の応答を待たせずに走らせ、失敗を未処理の例外にしない**（要件定義書 4.2。確定済みの投稿を 500 にしない）
 * - 送った宛先ごとに1行を書き、受け取りを返した利用者は `receivedAt` を持つ（送った宛先の一覧と受け取りの一覧が、一致しないときも残る）。
 *   **受け取りを返した利用者のメンションの件数が変わるため、その人の部屋へ `unread:updated` を送る**——送る前に、いまも参加者であることを確かめ直す（5.2）
 * - **代償**: `@here` を含む投稿の `message:new` は、在席の一覧を取り直すまで配らない（取り直しは Valkey への往復と、他のタスクの答えを待つ）
 */
@Injectable()
export class HereMentions {
  private readonly logger = new Logger('HereMentions');

  constructor(
    private readonly prisma: PrismaService,
    private readonly presence: RealtimePresence,
    private readonly registry: PresenceRegistry,
    private readonly receipts: HereReceipts,
    private readonly emitter: RealtimeEmitter,
  ) {}

  /** `@here` の宛先。問い合わせに失敗したら、宛先を空にして error を残す（投稿そのものは配る）。 */
  async targetsOf(channelId: string, authorId: string): Promise<string[]> {
    try {
      await this.presence.refresh(channelId);
      return await participantIds(this.prisma, channelId, {
        except: authorId,
        among: this.registry.usersIn(channelId),
      });
    } catch (error) {
      this.logFailure('@here の宛先を決められなかった', error);
      return [];
    }
  }

  /** 宛先ごとに受け取りを確かめて記録する。**失敗しても reject しない**（呼ぶ側は待たない）。 */
  async confirm(channelId: string, messageId: string, targets: readonly string[]): Promise<void> {
    try {
      const received = await this.receipts.collect({ channelId, messageId }, targets);
      const receivedAt = new Date();
      await this.prisma.hereMentionRecipient.createMany({
        data: targets.map((userId) => ({
          messageId,
          userId,
          receivedAt: received.has(userId) ? receivedAt : null,
        })),
        skipDuplicates: true,
      });
      const notified = await participantIds(this.prisma, channelId, { among: [...received] });
      // 受け取りを返した利用者（いまも参加者）にだけ通知を作る（F-26。機能一覧 9.2・10.3「@here が一覧に載るのは、受け取りを返した利用者だけ」）。
      // 受け取りを待つ間に消された・`@here` を編集で外したメッセージには作らない
      const message = await this.prisma.message.findFirst({
        where: { id: messageId, deletedAt: null, mentionsHere: true },
        select: { workspaceId: true, authorId: true },
      });
      if (message) {
        await addMentionNotifications(this.prisma, {
          messageId,
          channelId,
          workspaceId: message.workspaceId,
          authorId: message.authorId,
          userIds: notified,
        });
      }
      for (const userId of notified) {
        await announceUnreadTo(this.emitter, this.prisma, channelId, userId);
      }
    } catch (error) {
      this.logFailure('@here の受け取りを記録できなかった', error);
    }
  }

  private logFailure(message: string, error: unknown): void {
    const failure = error instanceof Error ? error : new Error(String(error));
    this.logger.error(`${message}: ${failure.message}`, failure.stack ?? '');
  }
}
