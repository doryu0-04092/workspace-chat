import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  type MessageDeletedPayload,
  type MessageNewPayload,
  type MessageUpdatedPayload,
  mentionedLoginIds,
  type paths,
} from '@workspace-chat/shared';
import { PrismaService } from '../prisma.service';
import { RealtimeEmitter } from '../realtime/realtime.emitter';
import { USER_SUMMARY_SELECT, type UserSummary, toUserSummary } from '../users/user-summary';
import { assertChannelParticipant, channelFor, lockedChannelFor } from './channel-access';
import { CHANNEL_ARCHIVED, NOT_MESSAGE_AUTHOR } from './channel-errors';
import { type Reaction, reactionsOf } from './reactions';
import { advanceReadPosition, announceUnreadTo, announceUnreadToMembers } from './unread';
import { WorkspacesService } from './workspaces.service';

type MessagesPath = paths['/workspaces/{id}/channels/{channelId}/messages'];
export type PostMessageRequest = MessagesPath['post']['requestBody']['content']['application/json'];
export type Message = MessagesPath['post']['responses'][201]['content']['application/json'];
export type MessagePage = MessagesPath['get']['responses'][200]['content']['application/json'];

type PageQuery = { before?: string; limit?: string | number };

/** 行を応答のメッセージにするときに読む表（参加者・メンションの対象・リアクション）。 */
type MessageReadDb = Pick<
  PrismaService,
  '$queryRaw' | 'messageMention' | 'messageReaction' | 'messageReactionCount'
>;

/** 親に載せる返信の参加者の上限（機能一覧 6。実装時に決めた値）。 */
const REPLY_PARTICIPANT_LIMIT = 3;

/**
 * 投稿時の宛先解決（機能一覧 9.1 の経路1。参照実装は prisma-schema.test.ts の `mentionTargetByLoginId`）。
 * **対象も要求する側（`viewerId`。トークンから導いた書き手）も、そのチャンネルの参加者で、退会していないこと**。
 * 照合は `lower()` で引く（`User_userId_lower_key` を使う。Prisma のクライアントの等値比較では大文字小文字を区別してしまう）。
 * **踏むと壊れる: 生の SQL は schema.prisma の列名の写し（`@map`）を通らない**——`User.loginId` の列は `"userId"` である。
 */
async function mentionTargetsOf(
  tx: Pick<PrismaService, '$queryRaw'>,
  { viewerId, channelId, body }: { viewerId: string; channelId: string; body: string },
): Promise<string[]> {
  const loginIds = mentionedLoginIds(body);
  if (loginIds.length === 0) return [];
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT u."id"
    FROM "User" u
    JOIN "ChannelMember" cm ON cm."userId" = u."id" AND cm."channelId" = ${channelId}::uuid
    JOIN "ChannelMember" vcm ON vcm."channelId" = ${channelId}::uuid AND vcm."userId" = ${viewerId}::uuid
    JOIN "User" viewer ON viewer."id" = vcm."userId" AND viewer."deletedAt" IS NULL
    WHERE lower(u."userId") = ANY(${loginIds}::text[]) AND u."deletedAt" IS NULL
  `;
  return rows.map(({ id }) => id);
}

/**
 * 本文のメンションを経路1 で解決し、メッセージの対象として保存する。保存した対象の `User.id` を返す（配信の宛先に加える）。
 * **保存するのは経路1 が返した値だけ**（表示時の参照先は、ここで確定させたものに限る。機能一覧 9.1）。
 */
async function saveMentions(
  tx: Pick<PrismaService, '$queryRaw' | 'messageMention'>,
  {
    messageId,
    ...target
  }: { messageId: string; viewerId: string; channelId: string; body: string },
): Promise<string[]> {
  const userIds = await mentionTargetsOf(tx, target);
  if (userIds.length > 0) {
    await tx.messageMention.createMany({ data: userIds.map((userId) => ({ messageId, userId })) });
  }
  return userIds;
}

/**
 * 編集のときに、メッセージの対象を編集後の本文に合わせる（機能一覧 9.1）。
 * **保存した対象のうち、編集後の本文にユーザーID が残っているものは消さない**——経路1 で引き直すと、チャンネルを抜けた・退会した対象は
 * 解決できず、本文の `@` を変えていなくても消える（経路2 と、1.5 の「メンションの参照先も削除済みの利用者として表示する」が崩れる）。
 * 本文から消えた対象だけを外し、まだ保存していない `@` は経路1 で解決して足す（足すのは経路1 が返した対象だけ）。
 */
async function replaceMentions(
  tx: Pick<PrismaService, '$queryRaw' | 'messageMention'>,
  {
    messageId,
    ...target
  }: { messageId: string; viewerId: string; channelId: string; body: string },
): Promise<void> {
  const loginIds = new Set(mentionedLoginIds(target.body));
  const saved = await tx.messageMention.findMany({
    where: { messageId },
    select: { userId: true, user: { select: { loginId: true } } },
  });
  const removed = saved.filter(({ user }) => !loginIds.has(user.loginId.toLowerCase()));
  if (removed.length > 0) {
    await tx.messageMention.deleteMany({
      where: { messageId, userId: { in: removed.map(({ userId }) => userId) } },
    });
  }
  const kept = new Set(
    saved.filter((mention) => !removed.includes(mention)).map(({ userId }) => userId),
  );
  const added = (await mentionTargetsOf(tx, target)).filter((userId) => !kept.has(userId));
  if (added.length > 0) {
    await tx.messageMention.createMany({ data: added.map((userId) => ({ messageId, userId })) });
  }
}

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
function toMessage(
  row: MessageRow,
  replyParticipants: UserSummary[],
  mentions: MentionTarget[],
  reactions: Reaction[],
): Message {
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
    mentions,
    reactions,
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

type MentionTarget = Message['mentions'][number];

/**
 * 表示時の参照先解決（機能一覧 9.1 の経路2。参照実装は prisma-schema.test.ts の `mentionDisplayTarget`）。
 * 渡したメッセージの保存した対象の `User` を、**まとめて1回で引く**（メッセージごとに引かない）。
 * **`ChannelMember` を条件にしない**（対象がいま参加しているかを問わない）。退会した対象は `user: null`（削除済みの利用者。1.5）。並びは本文に最初に現れた順。
 * **要求する側の条件を持たない**——呼ぶ側が読んでよいと決めたメッセージだけを渡す。**単独の API にしない**（UUID を試して利用者を引けてしまう）。
 */
async function mentionsOf(
  db: Pick<PrismaService, 'messageMention'>,
  rows: { id: string; body: string }[],
): Promise<Map<string, MentionTarget[]>> {
  const mentions = new Map<string, MentionTarget[]>();
  if (rows.length === 0) return mentions;
  const saved = await db.messageMention.findMany({
    where: { messageId: { in: rows.map(({ id }) => id) } },
    select: { messageId: true, user: { select: { ...USER_SUMMARY_SELECT, deletedAt: true } } },
  });
  for (const row of rows) {
    const order = mentionedLoginIds(row.body);
    const positionOf = (loginId: string) => order.indexOf(loginId.toLowerCase());
    const users = saved
      .filter(({ messageId }) => messageId === row.id)
      .map(({ user }) => user)
      .sort((a, b) => positionOf(a.loginId) - positionOf(b.loginId));
    mentions.set(
      row.id,
      users.map((user) => {
        // 列の loginId → 応答の userId の写像は toUserSummary だけに置く（users/user-summary.ts）
        const summary = toUserSummary(user);
        return { userId: summary.userId, user: user.deletedAt === null ? summary : null };
      }),
    );
  }
  return mentions;
}

/**
 * 行を応答のメッセージにする。返信のある本体のメッセージにだけ参加者を、本文に `@` のある削除されていないメッセージにだけメンションの対象を、引いて載せる
 * （**削除済みのメッセージは、本文を返さないのと同じく、誰を指したかも、リアクションも返さない**。機能一覧 9.1・7）。
 * **トランザクションの中でも呼ぶため、問い合わせは順に出す**（同じ接続で並べない）。
 */
async function toMessages(db: MessageReadDb, rows: MessageRow[]): Promise<Message[]> {
  const participants = await participantsOf(
    db,
    rows.filter((row) => row.parentId === null && row.replyCount > 0),
  );
  const mentions = await mentionsOf(
    db,
    rows.filter((row) => row.deletedAt === null && mentionedLoginIds(row.body).length > 0),
  );
  const reactions = await reactionsOf(
    db,
    rows.filter((row) => row.deletedAt === null).map(({ id }) => id),
  );
  return rows.map((row) =>
    toMessage(
      row,
      participants.get(row.id) ?? [],
      mentions.get(row.id) ?? [],
      reactions.get(row.id) ?? [],
    ),
  );
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
  db: MessageReadDb & Pick<PrismaService, 'message'>,
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
async function messageOf(db: MessageReadDb, row: MessageRow): Promise<Message> {
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
 * - **`message:new` / `message:updated` / `message:deleted` は確定の後にチャンネルの部屋へ送る**（確定しなかった書き込みを配らない。機能一覧 5.2。メンションを含む `message:new` の宛先は下の箇条）
 * - 一覧は id の新しい順（`pageOf`）。**チャンネルの一覧は本体だけ**で、返信を混ぜない（機能一覧 6）
 * - **スレッドは1階層だけ**。親にできるのは、そのチャンネルの削除されていない本体のメッセージ（`parentId` が null）だけ
 * - **親の返信件数（`replyCount`）は、返信の投稿・削除と同じトランザクションで増減し**（一覧で `COUNT` を発行しない。要件定義書 4.1）、
 *   件数が変わった親を、参加者を付け直して `message:updated` で配る
 * - **本文の `@ユーザーID` は、投稿・返信と同じトランザクションで経路1 で解決して保存する**（機能一覧 9.1。`saveMentions`）。
 *   **編集では、本文にユーザーID が残っている対象を解決し直さずに残し**（抜けた・退会した対象も残る）、本文から消えた対象だけを外して新しい `@` を足す（`replaceMentions`）。
 *   投稿と返信の `message:new` は、解決した対象の利用者の部屋をチャンネルの部屋に加えて1回で送る（5.2）——**対象はトランザクションの中で参加者と確かめた利用者だけ**
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
    const { message, mentioned } = await this.prisma.$transaction(async (tx) => {
      const channel = await lockedChannelFor(tx, userId, workspaceId, channelId);
      assertChannelParticipant(channel);
      if (channel.archived) throw new ConflictException(CHANNEL_ARCHIVED);
      const row = await tx.message.create({
        data: { channelId, workspaceId, authorId: userId, body: input.body },
        select: MESSAGE_SELECT,
      });
      const mentioned = await saveMentions(tx, {
        messageId: row.id,
        viewerId: userId,
        channelId,
        body: input.body,
      });
      return { message: await messageOf(tx, row), mentioned };
    });
    const payload: MessageNewPayload = { message, sentAt: new Date().toISOString() };
    this.emitter.toChannelAndUsers(channelId, mentioned, 'message:new', payload);
    await this.announceUnread(channelId, userId);
    return message;
  }

  /**
   * 未読数の変化を配らせる（F-23。機能一覧 10.1・5.2）。**payload の組み立てと宛先の決め方は `unread.ts` に置く**
   * ——2箇所に分かれると、項目を足すときや宛先の規則を変えるときに片方だけが変わる（#505 第5巡の 🟡2）。
   */
  private announceUnread(channelId: string, writerId?: string): Promise<void> {
    return announceUnreadToMembers(this.emitter, this.prisma, channelId, writerId);
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
    const { reply, parent, mentioned } = await this.prisma.$transaction(async (tx) => {
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
      const mentioned = await saveMentions(tx, {
        messageId: created.id,
        viewerId: userId,
        channelId,
        body: input.body,
      });
      const counted = await tx.message.findUniqueOrThrow({
        where: { id: parentId },
        select: MESSAGE_SELECT,
      });
      return {
        reply: await messageOf(tx, created),
        parent: await messageOf(tx, counted),
        mentioned,
      };
    });
    const sentAt = new Date().toISOString();
    const created: MessageNewPayload = { message: reply, sentAt };
    const counted: MessageUpdatedPayload = { message: parent, sentAt };
    this.emitter.toChannelAndUsers(channelId, mentioned, 'message:new', created);
    this.emitter.toChannel(channelId, 'message:updated', counted);
    await this.announceUnread(channelId, userId);
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
   * スレッドの既読位置の更新（F-23。機能一覧 10.1）。**判定は返信の一覧と同じ**（所属 → 参加の2段階 → 親の有無）。
   * 渡された id が、その親への削除されていない返信でなければ 404。
   *
   * **チャンネルの既読位置とは別系統で持つ**——スレッド内の未読をチャンネルの未読に含めるかを利用者が切り替えられ、
   * 切り替えた瞬間に集計対象が変わるためである（3.5.2）。**進めるだけで戻さない**のはチャンネルの既読位置と同じ。
   */
  async updateThreadRead(
    userId: string,
    workspaceId: string,
    channelId: string,
    parentId: string,
    lastReadMessageId: string,
  ): Promise<void> {
    const membership = await this.workspaces.membershipOf(userId, workspaceId);
    assertChannelParticipant(await channelFor(this.prisma, userId, workspaceId, channelId));
    // **親がそのチャンネルの本体であることは、返信の確認に含まれている**——返信を `parentId` と `channelId` の
    // 両方で引くため、親が別のチャンネルのもの・存在しないもの・返信そのものなら、その親への返信は1件も無く 404 になる。
    // **親だけを別に確かめる条件は到達しない**（置いても、壊して落ちるテストが書けない。変異で確かめた）。
    const reply = await this.prisma.message.findFirst({
      where: { id: lastReadMessageId, channelId, parentId, deletedAt: null },
      select: { id: true },
    });
    if (!reply) throw new NotFoundException();
    await advanceReadPosition(this.prisma.threadRead, {
      where: { parentMessageId: parentId, userId },
      create: {
        parentMessageId: parentId,
        channelId,
        workspaceId: membership.workspace.id,
        userId,
        lastReadMessageId,
      },
      lastReadMessageId,
    });
    // **変わったのは読んだ本人の未読だけ**なので、本人の部屋へ1件だけ送る（機能一覧 5.2・10.1）。
    // **参加者全員へ配らない**——1要求が人数分の集計と配信に増幅する（#505 第0巡の 🔴3）。
    await announceUnreadTo(this.emitter, this.prisma, channelId, userId);
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
      // メンションの対象は、編集後の本文に合わせる（本文に残した対象は消さない）。**編集では対象の部屋へ配らない**（機能一覧 9.1 の実装時に決めた値）
      await replaceMentions(tx, { messageId, viewerId: userId, channelId, body: input.body });
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
    // 削除で未読が減る（削除済みは数えないため。機能一覧 10.1）。
    await this.announceUnread(channelId, userId);
  }
}
