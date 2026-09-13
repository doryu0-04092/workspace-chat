import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  MessageDeletedPayload,
  MessageNewPayload,
  MessageUpdatedPayload,
  paths,
} from '@workspace-chat/shared';
import { PrismaService } from '../prisma.service';
import { RealtimeEmitter } from '../realtime/realtime.emitter';
import { USER_SUMMARY_SELECT, toUserSummary } from '../users/user-summary';
import { assertChannelParticipant, lockedChannelFor } from './channel-access';
import { CHANNEL_ARCHIVED, NOT_MESSAGE_AUTHOR } from './channel-errors';
import { WorkspacesService } from './workspaces.service';

type MessagesPath = paths['/workspaces/{id}/channels/{channelId}/messages'];
export type PostMessageRequest = MessagesPath['post']['requestBody']['content']['application/json'];
export type Message = MessagesPath['post']['responses'][201]['content']['application/json'];
export type MessagePage = MessagesPath['get']['responses'][200]['content']['application/json'];

const MESSAGE_SELECT = {
  id: true,
  channelId: true,
  body: true,
  createdAt: true,
  editedAt: true,
  deletedAt: true,
  author: { select: { ...USER_SUMMARY_SELECT, deletedAt: true } },
} as const;

type MessageRow = {
  id: string;
  channelId: string;
  body: string;
  createdAt: Date;
  editedAt: Date | null;
  deletedAt: Date | null;
  author: { id: string; loginId: string; displayName: string; deletedAt: Date | null };
};

/**
 * 退会した投稿者は `author: null`（削除済みの利用者として表示する。機能一覧 1.5）。
 * **削除済みのメッセージは本文を返さない**（`body: null`・`deleted: true`。本文は DB に残る。機能一覧 4.2）。
 */
function toMessage(row: MessageRow): Message {
  const deleted = row.deletedAt !== null;
  return {
    id: row.id,
    channelId: row.channelId,
    author: row.author.deletedAt === null ? toUserSummary(row.author) : null,
    body: deleted ? null : row.body,
    createdAt: row.createdAt.toISOString(),
    editedAt: row.editedAt?.toISOString() ?? null,
    deleted,
  };
}

/**
 * 編集・削除してよいメッセージか。**そのチャンネルに無い・削除済みなら 404、作者でなければ 403 `not_message_author`**。
 * 参加の判定（`assertChannelParticipant`）の後に呼ぶ——参加していない人に、メッセージの有無も作者も漏らさない。
 */
async function assertAuthoredMessage(
  tx: Pick<PrismaService, 'message'>,
  userId: string,
  channelId: string,
  messageId: string,
): Promise<void> {
  const row = await tx.message.findFirst({
    where: { id: messageId, channelId, deletedAt: null },
    select: { authorId: true },
  });
  if (!row) throw new NotFoundException();
  if (row.authorId !== userId) throw new ForbiddenException(NOT_MESSAGE_AUTHOR);
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

    // 既定値（50）と範囲（1〜100）は仕様の `limit` が持ち、openapi-validation.ts が要求に入れてから届く。
    const limit = Number(query.limit);
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

  /**
   * 編集（F-13。機能一覧 4.2）。判定の順は、所属 → 参加の2段階 → メッセージの有無 → 作者 → アーカイブ済み。
   * 削除済みでない行だけを条件付きで書き換え、同時の削除の後に編集が成立しないようにする。`message:updated` は確定の後に配る。
   */
  async edit(
    userId: string,
    workspaceId: string,
    channelId: string,
    messageId: string,
    input: PostMessageRequest,
  ): Promise<Message> {
    await this.workspaces.membershipOf(userId, workspaceId);
    const message = await this.prisma.$transaction(async (tx) => {
      const channel = await lockedChannelFor(tx, userId, workspaceId, channelId);
      assertChannelParticipant(channel);
      await assertAuthoredMessage(tx, userId, channelId, messageId);
      if (channel.archived) throw new ConflictException(CHANNEL_ARCHIVED);
      const { count } = await tx.message.updateMany({
        where: { id: messageId, channelId, deletedAt: null },
        data: { body: input.body, editedAt: new Date() },
      });
      if (count !== 1) throw new NotFoundException();
      const row = await tx.message.findUniqueOrThrow({
        where: { id: messageId },
        select: MESSAGE_SELECT,
      });
      return toMessage(row);
    });
    const payload: MessageUpdatedPayload = { message, sentAt: new Date().toISOString() };
    this.emitter.toChannel(channelId, 'message:updated', payload);
    return message;
  }

  /**
   * 削除（論理削除。F-13。機能一覧 4.2）。判定の順は編集と同じ。**本文は消さない**（要件定義書 3.4）。
   * `message:deleted` は本文を載せずに、確定の後に配る。
   */
  async remove(
    userId: string,
    workspaceId: string,
    channelId: string,
    messageId: string,
  ): Promise<void> {
    await this.workspaces.membershipOf(userId, workspaceId);
    await this.prisma.$transaction(async (tx) => {
      const channel = await lockedChannelFor(tx, userId, workspaceId, channelId);
      assertChannelParticipant(channel);
      await assertAuthoredMessage(tx, userId, channelId, messageId);
      if (channel.archived) throw new ConflictException(CHANNEL_ARCHIVED);
      const { count } = await tx.message.updateMany({
        where: { id: messageId, channelId, deletedAt: null },
        data: { deletedAt: new Date() },
      });
      if (count !== 1) throw new NotFoundException();
    });
    const payload: MessageDeletedPayload = {
      channelId,
      messageId,
      sentAt: new Date().toISOString(),
    };
    this.emitter.toChannel(channelId, 'message:deleted', payload);
  }
}
