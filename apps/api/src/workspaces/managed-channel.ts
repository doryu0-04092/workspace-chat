import type { paths } from '@workspace-chat/shared';
import type { Prisma } from '../generated/prisma/client';

export type ManagedChannel =
  paths['/workspaces/{id}/managed-channels']['get']['responses'][200]['content']['application/json'][number];

/**
 * オーナーの管理用の範囲（機能一覧 3.1 の決定表: id / 名前 / 種別 / 参加者数 / アーカイブ済みか）を引く列。
 * **会話の中身（メッセージ・添付ファイル・未読数・在席）に当たる列を足さない。** 参加者数は退会者を除く（機能一覧 1.5）。
 * 管理用の一覧・アーカイブ・復元の応答がこの形を使う。
 */
export const MANAGED_CHANNEL_SELECT = {
  id: true,
  name: true,
  visibility: true,
  archivedAt: true,
  _count: { select: { members: { where: { membership: { user: { deletedAt: null } } } } } },
} satisfies Prisma.ChannelSelect;

export function toManagedChannel(row: {
  id: string;
  name: string;
  visibility: ManagedChannel['visibility'];
  archivedAt: Date | null;
  _count: { members: number };
}): ManagedChannel {
  return {
    id: row.id,
    name: row.name,
    visibility: row.visibility,
    memberCount: row._count.members,
    archived: row.archivedAt !== null,
  };
}
