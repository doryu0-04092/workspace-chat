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
import { USER_SUMMARY_SELECT, type UserSummary, toUserSummary } from '../users/user-summary';
import { assertChannelParticipant, channelFor, lockedChannelFor } from './channel-access';
import { CHANNEL_ARCHIVED, NOT_MESSAGE_AUTHOR } from './channel-errors';
import { WorkspacesService } from './workspaces.service';

type MessagesPath = paths['/workspaces/{id}/channels/{channelId}/messages'];
export type PostMessageRequest = MessagesPath['post']['requestBody']['content']['application/json'];
export type Message = MessagesPath['post']['responses'][201]['content']['application/json'];
export type MessagePage = MessagesPath['get']['responses'][200]['content']['application/json'];

type PageQuery = { before?: string; limit?: string | number };

/** 親に載せる返信の参加者の上限（機能一覧 6。実装時に決めた値）。 */
const REPLY_PARTICIPANT_LIMIT = 3;

const MESSAGE_SELECT = {
  id: true,
  channelId: true,
  parentId: true,
  replyCount: true,
  body: true,
  createdAt: true,
  editedAt: true,
  deletedAt: true,
  author: { select: { ...USER_SUMMARY_SELECT, deletedAt: true } },
} as const;

type MessageRow = {
  id: string;
  channelId: string;
  parentId: string | null;
  replyCount: number;
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
function toMessage(row: MessageRow, replyParticipants: UserSummary[]): Message {
  const deleted = row.deletedAt !== null;
  return {
    id: row.id,
    channelId: row.channelId,
    author: row.author.deletedAt === null ? toUserSummary(row.author) : null,
    body: deleted ? null : row.body,
    createdAt: row.createdAt.toISOString(),
    editedAt: row.editedAt?.toISOString() ?? null,
    deleted,
    parentId: row.parentId,
    replyCount: row.replyCount,
    replyParticipants,
  };
}

/**
 * 親ごとの返信の参加者（機能一覧 6）。削除されていない返信を書いた、退会していない利用者を、最後に返信した順に上限まで。
 * **渡した親の分を1回の問い合わせで引く**（親ごとに引かない。技術スタックの「スレッドの返信件数・参加者」の CTE と window 関数）——
 * 利用者ごとの最後の返信に絞ってから、親ごとに新しい順の順位を付ける。
 * **踏むと壊れる: 生の SQL は schema.prisma の列名の写し（`@map`）を通らない**——`User.loginId` の列は `"userId"` である。
 * **返信は親のチャンネルでも絞る**——`parentId` だけで引くと、索引 `(channelId, parentId, id DESC)` の前方を使えない（schema.prisma の注記）。
 */
async function participantsOf(
  db: Pick<PrismaService, '$queryRaw'>,
  parents: { id: string; channelId: string }[],
): Promise<Map<string, UserSummary[]>> {
  const participants = new Map<string, UserSummary[]>();
  if (parents.length === 0) return participants;
  const parentIds = parents.map(({ id }) => id);
  const channelIds = [...new Set(parents.map(({ channelId }) => channelId))];
  const rows = await db.$queryRaw<
    { parentId: string; id: string; loginId: string; displayName: string }[]
  >`
    WITH "latest" AS (
      SELECT m."parentId", m."authorId", m."id",
        ROW_NUMBER() OVER (PARTITION BY m."parentId", m."authorId" ORDER BY m."id" DESC) AS "perAuthor"
      FROM "Message" m
      JOIN "User" u ON u."id" = m."authorId"
      WHERE m."channelId" = ANY(${channelIds}::uuid[]) AND m."parentId" = ANY(${parentIds}::uuid[])
        AND m."deletedAt" IS NULL AND u."deletedAt" IS NULL
    ), "ranked" AS (
      SELECT "parentId", "authorId",
        ROW_NUMBER() OVER (PARTITION BY "parentId" ORDER BY "id" DESC) AS "rank"
      FROM "latest"
      WHERE "perAuthor" = 1
    )
    SELECT r."parentId", u."id", u."userId" AS "loginId", u."displayName"
    FROM "ranked" r
    JOIN "User" u ON u."id" = r."authorId"
    WHERE r."rank" <= ${REPLY_PARTICIPANT_LIMIT}
    ORDER BY r."parentId", r."rank"
  `;
  for (const { parentId, ...user } of rows) {
    participants.set(parentId, [...(participants.get(parentId) ?? []), toUserSummary(user)]);
  }
  return participants;
}

/** 行を応答のメッセージにする。返信のある本体のメッセージにだけ、参加者を引いて載せる（返信と返信の無いメッセージは空）。 */
async function toMessages(
  db: Pick<PrismaService, '$queryRaw'>,
  rows: MessageRow[],
): Promise<Message[]> {
  const participants = await participantsOf(
    db,
    rows.filter((row) => row.parentId === null && row.replyCount > 0),
  );
  return rows.map((row) => toMessage(row, participants.get(row.id) ?? []));
}

/**
 * 編集・削除してよいメッセージか。**そのチャンネルに無い・削除済みなら 404、作者でなければ 403 `not_message_author`**。
 * 参加の判定（`assertChannelParticipant`）の後に呼ぶ——参加していない人に、メッセージの有無も作者も漏らさない。
 * 返信なら親の id を返す（削除で親の返信件数を減らすため）。
 */
async function assertAuthoredMessage(
  tx: Pick<PrismaService, 'message'>,
  userId: string,
  channelId: string,
  messageId: string,
): Promise<{ parentId: string | null }> {
  const row = await tx.message.findFirst({
    where: { id: messageId, channelId, deletedAt: null },
    select: { authorId: true, parentId: true },
  });
  if (!row) throw new NotFoundException();
  if (row.authorId !== userId) throw new ForbiddenException(NOT_MESSAGE_AUTHOR);
  return { parentId: row.parentId };
}

/**
 * 編集・削除してよいかを、トランザクションの中で判定の順どおりに確かめる（機能一覧 4.2）。
 * **順を変えない**: チャンネルの行を掴んでから読む → 参加の2段階 → メッセージの有無 → 作者 → アーカイブ済み。
 * 参加していない人に、メッセージの有無も作者も漏らさない。
 */
async function assertEditableMessage(
  tx: Pick<PrismaService, 'channel' | '$queryRaw' | 'message'>,
  userId: string,
  workspaceId: string,
  channelId: string,
  messageId: string,
): Promise<{ parentId: string | null }> {
  const channel = await lockedChannelFor(tx, userId, workspaceId, channelId);
  assertChannelParticipant(channel);
  const message = await assertAuthoredMessage(tx, userId, channelId, messageId);
  if (channel.archived) throw new ConflictException(CHANNEL_ARCHIVED);
  return message;
}

/**
 * 一覧の1ページ（id の新しい順）。`before` より古いものを `limit + 1` 件引き、続きの有無を決める（`OFFSET` を使わない）。
 * 既定値（50）と範囲（1〜100）は仕様の `limit` が持ち、openapi-validation.ts が要求に入れてから届く。
 */
async function pageOf(
  db: Pick<PrismaService, 'message' | '$queryRaw'>,
  where: { channelId: string; parentId: string | null },
  query: PageQuery,
): Promise<MessagePage> {
  const limit = Number(query.limit);
  const rows = await db.message.findMany({
    where: { ...where, ...(query.before === undefined ? {} : { id: { lt: query.before } }) },
    orderBy: { id: 'desc' },
    take: limit + 1,
    select: MESSAGE_SELECT,
  });
  const messages = await toMessages(db, rows.slice(0, limit));
  const hasMore = rows.length > limit;
  return { messages, nextBefore: hasMore ? (messages.at(-1)?.id ?? null) : null };
}

/** 1件の行を応答のメッセージにする（`toMessages` と同じく、返信のある本体のメッセージには参加者を載せる）。 */
async function messageOf(db: Pick<PrismaService, '$queryRaw'>, row: MessageRow): Promise<Message> {
  const [message] = await toMessages(db, [row]);
  if (!message) throw new Error('1件の行から応答のメッセージを作れなかった');
  return message;
}

/**
 * チャンネルのメッセージの投稿・一覧・編集・削除と、スレッドの返信（F-11・F-12・F-13・F-17。機能一覧 4.1・4.2・6）。
 *
 * - **読めるのも書けるのも参加者だけ**。所属していなければ 404（`membershipOf`）、所属していれば 2段階（`assertChannelParticipant`）。
 *   **オーナーの例外は及ばない**
 * - **投稿・返信・編集・削除はチャンネルの行を掴んでからアーカイブ済みかを読む**（`lockedChannelFor`。機能一覧 3.2）。アーカイブ済みなら 409 `channel_archived`
 * - **`message:new` / `message:updated` / `message:deleted` は確定の後にチャンネルの部屋へ送る**（確定しなかった書き込みを配らない。機能一覧 5.2）
 * - 一覧は id の新しい順（`pageOf`）。**チャンネルの一覧は本体だけ**で、返信を混ぜない（機能一覧 6）
 * - **スレッドは1階層だけ**。親にできるのは、そのチャンネルの削除されていない本体のメッセージ（`parentId` が null）だけ
 * - **親の返信件数（`replyCount`）は、返信の投稿・削除と同じトランザクションで増減し**（一覧で `COUNT` を発行しない。要件定義書 4.1）、
 *   件数が変わった親を、参加者を付け直して `message:updated` で配る
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
      return messageOf(tx, row);
    });
    const payload: MessageNewPayload = { message, sentAt: new Date().toISOString() };
    this.emitter.toChannel(channelId, 'message:new', payload);
    return message;
  }

  async list(
    userId: string,
    workspaceId: string,
    channelId: string,
    query: PageQuery,
  ): Promise<MessagePage> {
    await this.workspaces.membershipOf(userId, workspaceId);
    assertChannelParticipant(await channelFor(this.prisma, userId, workspaceId, channelId));
    return pageOf(this.prisma, { channelId, parentId: null }, query);
  }

  /**
   * スレッドへの返信（F-17。機能一覧 6）。判定の順は、所属 → 参加の2段階 → 親の有無（そのチャンネルに無い・削除済み・返信なら 404）→ アーカイブ済み。
   * **親の返信件数は、削除済みでない本体のメッセージだけを条件付きで増やす**——親の行を掴むため、同時の親の削除の後に返信が成立しない。
   * `message:new`（返信）と `message:updated`（件数と参加者が変わった親）は確定の後に配る。
   */
  async postReply(
    userId: string,
    workspaceId: string,
    channelId: string,
    parentId: string,
    input: PostMessageRequest,
  ): Promise<Message> {
    await this.workspaces.membershipOf(userId, workspaceId);
    const { reply, parent } = await this.prisma.$transaction(async (tx) => {
      const channel = await lockedChannelFor(tx, userId, workspaceId, channelId);
      assertChannelParticipant(channel);
      const { count } = await tx.message.updateMany({
        where: { id: parentId, channelId, parentId: null, deletedAt: null },
        data: { replyCount: { increment: 1 } },
      });
      if (count !== 1) throw new NotFoundException();
      if (channel.archived) throw new ConflictException(CHANNEL_ARCHIVED);
      const created = await tx.message.create({
        data: { channelId, workspaceId, authorId: userId, parentId, body: input.body },
        select: MESSAGE_SELECT,
      });
      const counted = await tx.message.findUniqueOrThrow({
        where: { id: parentId },
        select: MESSAGE_SELECT,
      });
      return { reply: await messageOf(tx, created), parent: await messageOf(tx, counted) };
    });
    const sentAt = new Date().toISOString();
    const created: MessageNewPayload = { message: reply, sentAt };
    const counted: MessageUpdatedPayload = { message: parent, sentAt };
    this.emitter.toChannel(channelId, 'message:new', created);
    this.emitter.toChannel(channelId, 'message:updated', counted);
    return reply;
  }

  /**
   * スレッドの返信の一覧（F-17。機能一覧 6）。判定は、所属 → 参加の2段階 → 親の有無（そのチャンネルに無い・返信なら 404）。
   * **削除済みの親の返信も返す**（返信は保持する。機能一覧 4.2）。
   */
  async listReplies(
    userId: string,
    workspaceId: string,
    channelId: string,
    parentId: string,
    query: PageQuery,
  ): Promise<MessagePage> {
    await this.workspaces.membershipOf(userId, workspaceId);
    assertChannelParticipant(await channelFor(this.prisma, userId, workspaceId, channelId));
    const parent = await this.prisma.message.findFirst({
      where: { id: parentId, channelId, parentId: null },
      select: { id: true },
    });
    if (!parent) throw new NotFoundException();
    return pageOf(this.prisma, { channelId, parentId }, query);
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
      await assertEditableMessage(tx, userId, workspaceId, channelId, messageId);
      const { count } = await tx.message.updateMany({
        where: { id: messageId, channelId, deletedAt: null },
        data: { body: input.body, editedAt: new Date() },
      });
      if (count !== 1) throw new NotFoundException();
      const row = await tx.message.findUniqueOrThrow({
        where: { id: messageId },
        select: MESSAGE_SELECT,
      });
      return messageOf(tx, row);
    });
    const payload: MessageUpdatedPayload = { message, sentAt: new Date().toISOString() };
    this.emitter.toChannel(channelId, 'message:updated', payload);
    return message;
  }

  /**
   * 削除（論理削除。F-13。機能一覧 4.2）。判定の順は編集と同じ。**本文は消さない**（要件定義書 3.4）。
   * **返信を消したら、親の返信件数を同じトランザクションで減らす**（F-17。親を消しても返信は残す）。
   * `message:deleted` は本文を載せずに、件数と参加者が変わった親は `message:updated` として、確定の後に配る。
   */
  async remove(
    userId: string,
    workspaceId: string,
    channelId: string,
    messageId: string,
  ): Promise<void> {
    await this.workspaces.membershipOf(userId, workspaceId);
    const parent = await this.prisma.$transaction(async (tx) => {
      const { parentId } = await assertEditableMessage(
        tx,
        userId,
        workspaceId,
        channelId,
        messageId,
      );
      const { count } = await tx.message.updateMany({
        where: { id: messageId, channelId, deletedAt: null },
        data: { deletedAt: new Date() },
      });
      if (count !== 1) throw new NotFoundException();
      if (parentId === null) return null;
      const row = await tx.message.update({
        where: { id: parentId },
        data: { replyCount: { decrement: 1 } },
        select: MESSAGE_SELECT,
      });
      return messageOf(tx, row);
    });
    const sentAt = new Date().toISOString();
    const payload: MessageDeletedPayload = { channelId, messageId, sentAt };
    this.emitter.toChannel(channelId, 'message:deleted', payload);
    if (parent !== null) {
      const counted: MessageUpdatedPayload = { message: parent, sentAt };
      this.emitter.toChannel(channelId, 'message:updated', counted);
    }
  }
}
