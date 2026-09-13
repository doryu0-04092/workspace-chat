import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { MessageNewPayload, paths } from '@workspace-chat/shared';
import { PrismaService } from '../prisma.service';
import { RealtimeEmitter } from '../realtime/realtime.emitter';
import { USER_SUMMARY_SELECT, toUserSummary } from '../users/user-summary';
import { assertChannelParticipant, lockedChannelFor } from './channel-access';
import { CHANNEL_ARCHIVED } from './channel-errors';
import { WorkspacesService } from './workspaces.service';

type MessagesPath = paths['/workspaces/{id}/channels/{channelId}/messages'];
export type PostMessageRequest = MessagesPath['post']['requestBody']['content']['application/json'];
export type Message = MessagesPath['post']['responses'][201]['content']['application/json'];
export type MessagePage = MessagesPath['get']['responses'][200]['content']['application/json'];

/** 一覧の件数の既定値（実装時に決めた値。機能一覧 4.1）。上限は仕様（`limit` の maximum）が確かめる。 */
export const MESSAGE_PAGE_DEFAULT_LIMIT = 50;

const MESSAGE_SELECT = {
  id: true,
  channelId: true,
  body: true,
  createdAt: true,
  author: { select: { ...USER_SUMMARY_SELECT, deletedAt: true } },
} as const;

type MessageRow = {
  id: string;
  channelId: string;
  body: string;
  createdAt: Date;
  author: { id: string; loginId: string; displayName: string; deletedAt: Date | null };
};

/** 退会した投稿者は `author: null`（削除済みの利用者として表示する。機能一覧 1.5）。 */
function toMessage(row: MessageRow): Message {
  return {
    id: row.id,
    channelId: row.channelId,
    author: row.author.deletedAt === null ? toUserSummary(row.author) : null,
    body: row.body,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * チャンネルのメッセージの投稿と一覧（F-11・F-12。機能一覧 4.1）。
 *
 * - **読めるのも書けるのも参加者だけ**。所属していなければ 404（`membershipOf`）、所属していれば 2段階（`assertChannelParticipant`）。
 *   **オーナーの例外は及ばない**
 * - **投稿はチャンネルの行を掴んでからアーカイブ済みかを読む**（`lockedChannelFor`。機能一覧 3.2）。アーカイブ済みなら 409 `channel_archived`
 * - **`message:new` は確定の後にチャンネルの部屋へ送る**（確定しなかった投稿を配らない。機能一覧 5.2）
 * - 一覧は id の新しい順。`before` より古いものを `limit + 1` 件引き、続きの有無を決める（`OFFSET` を使わない）
 */
@Injectable()
export class MessagesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly workspaces: WorkspacesService,
    private readonly emitter: RealtimeEmitter,
  ) {}

  async post(
    userId: string,
    workspaceId: string,
    channelId: string,
    input: PostMessageRequest,
  ): Promise<Message> {
    await this.workspaces.membershipOf(userId, workspaceId);
    const message = await this.prisma.$transaction(async (tx) => {
      const channel = await lockedChannelFor(tx, userId, workspaceId, channelId);
      assertChannelParticipant(channel);
      if (channel.archived) throw new ConflictException(CHANNEL_ARCHIVED);
      const row = await tx.message.create({
        data: { channelId, workspaceId, authorId: userId, body: input.body },
        select: MESSAGE_SELECT,
      });
      return toMessage(row);
    });
    const payload: MessageNewPayload = { message, sentAt: new Date().toISOString() };
    this.emitter.toChannel(channelId, 'message:new', payload);
    return message;
  }

  async list(
    userId: string,
    workspaceId: string,
    channelId: string,
    query: { before?: string; limit?: string | number },
  ): Promise<MessagePage> {
    await this.workspaces.membershipOf(userId, workspaceId);
    const channel = await this.prisma.channel.findFirst({
      where: { id: channelId, workspaceId },
      select: { visibility: true, members: { where: { userId }, select: { id: true } } },
    });
    if (!channel) throw new NotFoundException();
    assertChannelParticipant({
      visibility: channel.visibility,
      joined: channel.members.length > 0,
    });

    const limit = query.limit === undefined ? MESSAGE_PAGE_DEFAULT_LIMIT : Number(query.limit);
    const rows = await this.prisma.message.findMany({
      where: { channelId, ...(query.before === undefined ? {} : { id: { lt: query.before } }) },
      orderBy: { id: 'desc' },
      take: limit + 1,
      select: MESSAGE_SELECT,
    });
    const messages = rows.slice(0, limit).map(toMessage);
    const hasMore = rows.length > limit;
    return { messages, nextBefore: hasMore ? (messages.at(-1)?.id ?? null) : null };
  }
}
