import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { PrismaService } from '../prisma.service';
import { NOT_A_CHANNEL_MEMBER } from './channel-errors';
import { lockChannelRow } from './channel-row-lock';

/** 要求する側から見たチャンネル。 */
export type ChannelAccess = {
  readonly visibility: 'PUBLIC' | 'PRIVATE';
  readonly archived: boolean;
  readonly joined: boolean;
};

/**
 * 要求する側から見たチャンネルを、行を共有ロックで掴んでから読む（channel-row-lock.ts の `share`）。
 * **アーカイブ済みかを読んで書くかを決める経路（参加・招待・投稿・編集・削除）で使う**（機能一覧 3.2）。別のワークスペースのチャンネル・無いチャンネルは 404。
 */
export async function lockedChannelFor(
  tx: Pick<PrismaService, 'channel' | '$queryRaw'>,
  userId: string,
  workspaceId: string,
  channelId: string,
): Promise<ChannelAccess> {
  await lockChannelRow(tx, workspaceId, channelId, 'share');
  const row = await tx.channel.findFirst({
    where: { id: channelId, workspaceId },
    select: {
      visibility: true,
      archivedAt: true,
      members: { where: { userId }, select: { id: true } },
    },
  });
  if (!row) throw new NotFoundException();
  return {
    visibility: row.visibility,
    archived: row.archivedAt !== null,
    joined: row.members.length > 0,
  };
}

/**
 * 参加者でなければ断る。**コードは参加者一覧と同じ2段階の、所属している側**——パブリックは 403 `not_a_channel_member`、
 * プライベートは 404（存在を隠す。機能一覧 3.1）。**オーナーの例外はここに持たない**（メッセージに及ばない。3.1・4.1）。
 * 所属していない側の 404 は、呼ぶ前に `WorkspacesService.membershipOf` が返す。
 */
export function assertChannelParticipant(
  channel: Pick<ChannelAccess, 'visibility' | 'joined'>,
): void {
  if (channel.joined) return;
  if (channel.visibility === 'PRIVATE') throw new NotFoundException();
  throw new ForbiddenException(NOT_A_CHANNEL_MEMBER);
}
