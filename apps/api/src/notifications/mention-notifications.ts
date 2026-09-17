import type { PrismaService } from '../prisma.service';

type NotificationWriter = Pick<PrismaService, 'notification'>;

/**
 * メンションの通知を作る（F-26。機能一覧 10.3）。**メンションの対象を保存するのと同じトランザクションで呼ぶ**——
 * 確定しなかった投稿の通知を残さない。
 *
 * - **書き手本人には作らない**（自分で自分をメンションしても、自分の通知にしない。未読〔10.1〕が自分の投稿を数えないのと揃える）
 * - 渡す `userIds` は、経路1（投稿時の宛先解決。機能一覧 9.1）で参加者と確かめた利用者だけにする
 * - 同じメッセージ・同じ利用者の通知は1件（一意制約）。既にあれば作らない
 */
export async function addMentionNotifications(
  tx: NotificationWriter,
  {
    messageId,
    channelId,
    workspaceId,
    authorId,
    userIds,
  }: {
    messageId: string;
    channelId: string;
    workspaceId: string;
    authorId: string;
    userIds: readonly string[];
  },
): Promise<void> {
  const recipients = userIds.filter((userId) => userId !== authorId);
  if (recipients.length === 0) return;
  await tx.notification.createMany({
    data: recipients.map((userId) => ({
      messageId,
      channelId,
      workspaceId,
      userId,
      kind: 'MENTION' as const,
    })),
    skipDuplicates: true,
  });
}
