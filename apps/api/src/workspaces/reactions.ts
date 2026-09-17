import type { components } from '@workspace-chat/shared';
import type { PrismaService } from '../prisma.service';
import { USER_SUMMARY_SELECT, toUserSummary } from '../users/user-summary';

export type Reaction = components['schemas']['Reaction'];

/**
 * 1つのメッセージに付けられる絵文字の種類の上限（F-18。機能一覧 7。実装時に決めた値）。
 * **応答の大きさに上限を置くためである**——絵文字1つの組み合わせは数千あり、上限が無いと1件のメッセージの応答が際限なく伸びる（CWE-770）。
 * 50 は Slack の上限と同じ値にした。**変えるなら、仕様（openapi.yaml の `Message.reactions` と `MessageReactions.reactions` の `maxItems`）も同じ値にする。**
 */
export const REACTION_KINDS_LIMIT = 50;

/**
 * 渡したメッセージのリアクションを、**まとめて2回の問い合わせで引く**（メッセージごとに引かない。一覧で `COUNT` を発行しない——件数はカウンタ列から読む。要件定義書 4.1）。
 * 絵文字はその絵文字を初めて付けた順（`MessageReactionCount.id`）、付けた人は付けた順（`MessageReaction.id`）。**退会した利用者は付けた人から外し、件数には残す**（機能一覧 1.5）。
 * **要求する側の条件を持たない**——呼ぶ側が読んでよいと決めた、削除されていないメッセージだけを渡す。
 */
export async function reactionsOf(
  db: Pick<PrismaService, 'messageReaction' | 'messageReactionCount'>,
  messageIds: readonly string[],
): Promise<Map<string, Reaction[]>> {
  const reactions = new Map<string, Reaction[]>();
  if (messageIds.length === 0) return reactions;
  const counts = await db.messageReactionCount.findMany({
    where: { messageId: { in: [...messageIds] } },
    orderBy: { id: 'asc' },
    select: { messageId: true, emoji: true, count: true },
  });
  if (counts.length === 0) return reactions;
  const rows = await db.messageReaction.findMany({
    where: { messageId: { in: [...messageIds] }, user: { deletedAt: null } },
    orderBy: { id: 'asc' },
    select: { messageId: true, emoji: true, user: { select: USER_SUMMARY_SELECT } },
  });
  for (const { messageId, emoji, count } of counts) {
    const users = rows
      .filter((row) => row.messageId === messageId && row.emoji === emoji)
      .map(({ user }) => toUserSummary(user));
    reactions.set(messageId, [...(reactions.get(messageId) ?? []), { emoji, count, users }]);
  }
  return reactions;
}
