import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type {
  DmMessageDeletedPayload,
  DmMessageNewPayload,
  DmMessageUpdatedPayload,
  DmUnreadUpdatedPayload,
  paths,
  RealtimeEventName,
} from '@workspace-chat/shared';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma.service';
import { RealtimeEmitter } from '../realtime/realtime.emitter';
import { USER_SUMMARY_SELECT, toUserSummary, type UserSummaryRow } from '../users/user-summary';
import { NOT_MESSAGE_AUTHOR } from './channel-errors';
import { DM_COUNTERPART_NOT_FOUND, DM_COUNTERPART_UNAVAILABLE, DM_WITH_SELF } from './dm-errors';
import { advanceReadPosition } from './unread';
import { WorkspacesService } from './workspaces.service';

type DmsPath = paths['/workspaces/{id}/dms'];
export type Dm = DmsPath['post']['responses'][200]['content']['application/json'];
export type StartDmRequest = DmsPath['post']['requestBody']['content']['application/json'];
type DmMessagesPath = paths['/workspaces/{id}/dms/{dmId}/messages'];
export type DmMessage = DmMessagesPath['post']['responses'][201]['content']['application/json'];
export type DmMessagePage = DmMessagesPath['get']['responses'][200]['content']['application/json'];
export type PostDmMessageRequest =
  DmMessagesPath['post']['requestBody']['content']['application/json'];
export type UpdateDmReadRequest =
  paths['/workspaces/{id}/dms/{dmId}/read']['put']['requestBody']['content']['application/json'];

type PageQuery = { before?: string; limit?: string | number };

/** 既読位置を持たないときの下限（`unread.ts` の `AFTER_READ_POSITION` と同じ値）。 */
const NO_READ_POSITION = '00000000-0000-0000-0000-000000000000';

export const DM_MESSAGE_SELECT = {
  id: true,
  dmId: true,
  body: true,
  createdAt: true,
  editedAt: true,
  deletedAt: true,
  author: { select: USER_SUMMARY_SELECT },
} as const;

type DmMessageRow = {
  id: string;
  dmId: string;
  body: string;
  createdAt: Date;
  editedAt: Date | null;
  deletedAt: Date | null;
  author: UserSummaryRow;
};

/**
 * 退会した書き手は `author: null`（機能一覧 1.5）。**削除済みのメッセージは本文を返さない**（`body: null`・`deleted: true`。機能一覧 4.2）。
 * チャンネルのメッセージ（`messages.service.ts` の `toMessage`）と同じ扱いである。
 */
export function toDmMessage(row: DmMessageRow): DmMessage {
  const deleted = row.deletedAt !== null;
  return {
    id: row.id,
    dmId: row.dmId,
    author: row.author.deletedAt === null ? toUserSummary(row.author) : null,
    body: deleted ? null : row.body,
    createdAt: row.createdAt.toISOString(),
    editedAt: row.editedAt?.toISOString() ?? null,
    deleted,
  };
}

/** DM の当事者（User.id の小さい方と大きい方）。 */
type Parties = { id: string; lowUserId: string; highUserId: string };

/**
 * 要求する側が当事者の DM を読む。**当事者でない・無い・別のワークスペースの DM は、区別せず 404**（機能一覧 8「自分が当事者でない DM は取得できない（404）」）。
 * 所属の確認（`WorkspacesService.membershipOf`）の後に呼ぶ——所属していなければ、DM の有無を問う前に 404 になる。
 */
async function partiesFor(
  db: Pick<PrismaService, 'dm'>,
  userId: string,
  workspaceId: string,
  dmId: string,
): Promise<Parties> {
  const dm = await db.dm.findFirst({
    where: { id: dmId, workspaceId, OR: [{ lowUserId: userId }, { highUserId: userId }] },
    select: { id: true, lowUserId: true, highUserId: true },
  });
  if (!dm) throw new NotFoundException();
  return dm;
}

function counterpartOf(parties: Parties, userId: string): string {
  return parties.lowUserId === userId ? parties.highUserId : parties.lowUserId;
}

/**
 * ダイレクトメッセージ（F-19。機能一覧 8）と、その未読（「利用者 × DM」。F-23。機能一覧 10.1）。
 *
 * - **読めるのも書けるのも当事者だけ**。所属していなければ 404（`membershipOf`）、当事者でない・無い DM も 404（`partiesFor`）。**オーナーの例外は無い**
 * - **相手は同一ワークスペースのメンバーに限る**（8）。始めるときは、相手が退会していないメンバーでなければ 422。
 *   **投稿は、当事者2人の `Membership` を共有ロックで掴んでから確かめる**（相手がいまメンバーでなければ 409）——掴まずに読むと、キック・退出・退会の確定の直前に読んだ古い値に基づいて、その後に投稿が成立する
 * - **相手が抜けても DM とメッセージは残し、当事者は読める**（1.5・2.2「過去のメッセージは残る」）。自分のメッセージの編集・削除もできる
 * - **配信は、当事者2人のうち、いまそのワークスペースの退会していないメンバーである利用者の部屋へ1回で送る**（5.2 の DM の箇条。`deliver`）。
 *   DM はチャンネルの部屋を持たず、入室の関門を通らないため、**送るたびのこの確認が関門である**
 * - `unread:updated` は、その未読の持ち主の部屋へだけ送る（相手には送らない。5.2）。宛先の資格は配信と同じ確認で決める
 */
@Injectable()
export class DmsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly workspaces: WorkspacesService,
    private readonly emitter: RealtimeEmitter,
  ) {}

  async list(userId: string, workspaceId: string): Promise<Dm[]> {
    await this.workspaces.membershipOf(userId, workspaceId);
    return this.dmsOf(userId, workspaceId);
  }

  /**
   * DM を始める・開く。**同じ2人の DM は1つに集約する**——当事者を User.id の小さい方と大きい方の順に並べ、
   * `ON CONFLICT DO NOTHING` で作ってから引く（同時に始めても、一意索引 `Dm_workspaceId_lowUserId_highUserId_key` が2つ目を止める）。
   */
  async start(userId: string, workspaceId: string, input: StartDmRequest): Promise<Dm> {
    const membership = await this.workspaces.membershipOf(userId, workspaceId);
    // 形は仕様が uuid と確かめている。**大文字で送られても当事者の順が DB（uuid の比較）と揃うよう、小文字にしてから比べる**
    const counterpartId = input.userId.toLowerCase();
    if (counterpartId === userId.toLowerCase()) {
      throw new UnprocessableEntityException(DM_WITH_SELF);
    }
    const counterpart = await this.prisma.membership.findFirst({
      where: { workspaceId, userId: counterpartId, user: { deletedAt: null } },
      select: { id: true },
    });
    if (!counterpart) throw new UnprocessableEntityException(DM_COUNTERPART_NOT_FOUND);
    const [lowUserId = '', highUserId = ''] = [userId.toLowerCase(), counterpartId].sort();
    const key = { workspaceId: membership.workspace.id, lowUserId, highUserId };
    await this.prisma.dm.createMany({ data: [key], skipDuplicates: true });
    const dm = await this.prisma.dm.findUniqueOrThrow({
      where: { workspaceId_lowUserId_highUserId: key },
      select: { id: true },
    });
    const [started] = await this.dmsOf(userId, workspaceId, dm.id);
    if (!started) throw new NotFoundException();
    return started;
  }

  async listMessages(
    userId: string,
    workspaceId: string,
    dmId: string,
    query: PageQuery,
  ): Promise<DmMessagePage> {
    await this.workspaces.membershipOf(userId, workspaceId);
    const dm = await partiesFor(this.prisma, userId, workspaceId, dmId);
    const limit = Number(query.limit);
    const rows = await this.prisma.dmMessage.findMany({
      where: {
        dmId: dm.id,
        ...(query.before === undefined ? {} : { id: { lt: query.before } }),
      },
      orderBy: { id: 'desc' },
      take: limit + 1,
      select: DM_MESSAGE_SELECT,
    });
    const messages = rows.slice(0, limit).map(toDmMessage);
    return {
      messages,
      nextBefore: rows.length > limit ? (messages.at(-1)?.id ?? null) : null,
    };
  }

  /**
   * 投稿。判定の順は、所属 → 当事者 → 当事者2人がいまメンバーか（相手でなければ 409）。
   * `message:new` は確定の後に配り、相手に未読の変化を配る。
   */
  async post(
    userId: string,
    workspaceId: string,
    dmId: string,
    input: PostDmMessageRequest,
  ): Promise<DmMessage> {
    const membership = await this.workspaces.membershipOf(userId, workspaceId);
    const { dm, message } = await this.prisma.$transaction(async (tx) => {
      const dm = await partiesFor(tx, userId, workspaceId, dmId);
      const members = await lockedMembersOf(tx, workspaceId, [dm.lowUserId, dm.highUserId]);
      // 書き手がもうメンバーでない（所属の確認の後にキック・退出・退会が確定した）なら、所属していない人と同じく 404
      if (!members.has(userId)) throw new NotFoundException();
      if (!members.has(counterpartOf(dm, userId))) {
        throw new ConflictException(DM_COUNTERPART_UNAVAILABLE);
      }
      const row = await tx.dmMessage.create({
        data: { dmId: dm.id, authorId: userId, body: input.body },
        select: DM_MESSAGE_SELECT,
      });
      // 相手の DM の通知（F-26。機能一覧 10.3。#623）。書いたのと同じトランザクションで作り、確定しなかった投稿の通知を残さない
      await tx.dmNotification.create({
        data: {
          userId: counterpartOf(dm, userId),
          workspaceId: membership.workspace.id,
          dmId: dm.id,
          messageId: row.id,
        },
      });
      return { dm, message: toDmMessage(row) };
    });
    const payload: DmMessageNewPayload = { message, sentAt: new Date().toISOString() };
    const recipients = await this.deliver(workspaceId, dm, 'message:new', payload);
    await this.announceUnread(membership.workspace.id, dm.id, recipients, userId);
    return message;
  }

  /** 編集。判定の順は、所属 → 当事者 → メッセージの有無（その DM に無い・削除済みは 404）→ 作者（403 `not_message_author`）。 */
  async edit(
    userId: string,
    workspaceId: string,
    dmId: string,
    messageId: string,
    input: PostDmMessageRequest,
  ): Promise<DmMessage> {
    await this.workspaces.membershipOf(userId, workspaceId);
    const { dm, message } = await this.prisma.$transaction(async (tx) => {
      const dm = await assertAuthored(tx, userId, workspaceId, dmId, messageId);
      // 削除済みでない行だけを条件付きで書き換え、同時の削除の後に編集が成立しないようにする
      const { count } = await tx.dmMessage.updateMany({
        where: { id: messageId, dmId: dm.id, deletedAt: null },
        data: { body: input.body, editedAt: new Date() },
      });
      if (count !== 1) throw new NotFoundException();
      const row = await tx.dmMessage.findUniqueOrThrow({
        where: { id: messageId },
        select: DM_MESSAGE_SELECT,
      });
      return { dm, message: toDmMessage(row) };
    });
    const payload: DmMessageUpdatedPayload = { message, sentAt: new Date().toISOString() };
    await this.deliver(workspaceId, dm, 'message:updated', payload);
    return message;
  }

  /** 削除（論理削除。本文は消さない）。判定の順は編集と同じ。削除で相手の未読が減るため、相手に未読の変化を配る。 */
  async remove(userId: string, workspaceId: string, dmId: string, messageId: string) {
    const membership = await this.workspaces.membershipOf(userId, workspaceId);
    const dm = await this.prisma.$transaction(async (tx) => {
      const dm = await assertAuthored(tx, userId, workspaceId, dmId, messageId);
      const { count } = await tx.dmMessage.updateMany({
        where: { id: messageId, dmId: dm.id, deletedAt: null },
        data: { deletedAt: new Date() },
      });
      if (count !== 1) throw new NotFoundException();
      return dm;
    });
    const payload: DmMessageDeletedPayload = {
      dmId: dm.id,
      messageId,
      sentAt: new Date().toISOString(),
    };
    const recipients = await this.deliver(workspaceId, dm, 'message:deleted', payload);
    await this.announceUnread(membership.workspace.id, dm.id, recipients, userId);
  }

  /**
   * 既読位置の更新（「利用者 × DM」。F-23。機能一覧 10.1）。判定は、所属 → 当事者 → その DM の削除されていないメッセージか（でなければ 404）。
   * **進めるだけで戻さない**（`advanceReadPosition`）。**変わったのは読んだ本人の未読だけ**なので、本人の部屋へ1件だけ送る（5.2）。
   */
  async updateRead(
    userId: string,
    workspaceId: string,
    dmId: string,
    lastReadMessageId: string,
  ): Promise<void> {
    const membership = await this.workspaces.membershipOf(userId, workspaceId);
    const dm = await partiesFor(this.prisma, userId, workspaceId, dmId);
    const message = await this.prisma.dmMessage.findFirst({
      where: { id: lastReadMessageId, dmId: dm.id, deletedAt: null },
      select: { id: true },
    });
    if (!message) throw new NotFoundException();
    await advanceReadPosition(this.prisma.dmRead, {
      where: { dmId: dm.id, userId },
      create: {
        dmId: dm.id,
        workspaceId: membership.workspace.id,
        userId,
        lastReadMessageId: message.id,
      },
      lastReadMessageId: message.id,
    });
    // 資格の確認は上の所属と当事者の確認で済んでいる
    await this.announceUnread(membership.workspace.id, dm.id, [userId]);
  }

  /**
   * DM の配信（5.2 の DM の箇条）。**当事者2人のうち、いまそのワークスペースの退会していないメンバーである利用者の部屋へ1回で送る**。
   * 送った宛先を返す（未読の変化を配る宛先の資格の確認に使う）。
   * **踏むと壊れる: 当事者2人をそのまま宛先にしない**——DM はチャンネルの部屋への入室という関門を通らないため、この確認が無いと、
   * キック・退出した利用者や、`Membership` の消し込みを取りこぼした退会済みの利用者の、確立済みの接続に届く。
   */
  private async deliver(
    workspaceId: string,
    dm: Parties,
    event: RealtimeEventName,
    payload: unknown,
  ): Promise<string[]> {
    const rows = await this.prisma.membership.findMany({
      where: {
        workspaceId,
        userId: { in: [dm.lowUserId, dm.highUserId] },
        user: { deletedAt: null },
      },
      select: { userId: true },
    });
    const recipients = rows.map(({ userId }) => userId);
    this.emitter.toUsers(recipients, event, payload);
    return recipients;
  }

  /**
   * `unread:updated` を、宛先ごとにその人の未読数で1回ずつ送る（F-23。5.2）。**`recipients` は資格を確かめた利用者だけを渡す**。
   * 書いた本人（`writerId`）には送らない——自分の投稿・自分の削除では自分の未読は変わらない。
   * **`workspaceId` は DB の値（`membershipOf` が返す id）を渡す**——payload に載せ、画面が開いているワークスペースの一覧と比べるため（パスの値は大文字でも通る）。
   */
  private async announceUnread(
    workspaceId: string,
    dmId: string,
    recipients: readonly string[],
    writerId?: string,
  ): Promise<void> {
    const sentAt = new Date().toISOString();
    for (const userId of recipients) {
      if (userId === writerId) continue;
      const [dm] = await this.dmsOf(userId, workspaceId, dmId);
      if (!dm) continue;
      const payload: DmUnreadUpdatedPayload = {
        workspaceId,
        dmId: dm.id,
        unread: dm.unread,
        sentAt,
      };
      this.emitter.toUsers([userId], 'unread:updated', payload);
    }
  }

  /**
   * 利用者が当事者の DM を、未読数・既読位置・相手と一緒に返す（`dmId` を渡すとその1件だけ）。**未読の数え方はこの問い合わせだけに置く**
   * （一覧と配信で数え方が分かれると、片方だけが仕様とずれる。`unread.ts` の `UNREAD_JOINS` と同じ理由）。
   *
   * 未読の不変条件は、チャンネルと同じく4つのうち3つである（DM はスレッドを持たない）。
   * - **自分の投稿は数えない**（`m."authorId" <> ms."userId"`）
   * - **削除済みは数えない**（`m."deletedAt" IS NULL`）
   * - **既読位置を持たない利用者は、そのワークスペースに参加した時点より後だけを数える**（`m."createdAt" >= ms."joinedAt"`。抜けて戻った利用者に、抜ける前の履歴を未読にしない）
   *
   * **踏むと壊れる: メッセージを絞る条件は、結合の `ON` 側に置く**（`WHERE` に置くと、未読が0件の DM が結合の後に消える。`unread.ts` の `UNREAD_JOINS` と同じ）。
   * **並びは新しいメッセージのある順**——DM ごとの最新のメッセージの id（無ければ DM の id。どちらも UUIDv7）の降順。
   */
  private async dmsOf(userId: string, workspaceId: string, dmId?: string): Promise<Dm[]> {
    const rows = await this.prisma.$queryRaw<
      {
        id: string;
        counterpartId: string;
        joinedAt: Date;
        unread: bigint;
        lastReadMessageId: string | null;
      }[]
    >`
      SELECT d."id",
             CASE WHEN d."lowUserId" = ${userId}::uuid THEN d."highUserId" ELSE d."lowUserId" END AS "counterpartId",
             ms."joinedAt" AS "joinedAt",
             COUNT(m."id") AS "unread",
             MIN(r."lastReadMessageId"::text) AS "lastReadMessageId"
      FROM "Dm" d
      JOIN "Membership" ms ON ms."workspaceId" = d."workspaceId" AND ms."userId" = ${userId}::uuid
      LEFT JOIN "DmRead" r ON r."dmId" = d."id" AND r."userId" = ms."userId"
      LEFT JOIN "DmMessage" m
        ON m."dmId" = d."id"
       AND m."id" > COALESCE(r."lastReadMessageId", ${NO_READ_POSITION}::uuid)
       AND m."deletedAt" IS NULL
       AND m."authorId" <> ms."userId"
       AND m."createdAt" >= ms."joinedAt"
      WHERE d."workspaceId" = ${workspaceId}::uuid
        AND (d."lowUserId" = ${userId}::uuid OR d."highUserId" = ${userId}::uuid)
        ${dmId === undefined ? Prisma.empty : Prisma.sql`AND d."id" = ${dmId}::uuid`}
      GROUP BY d."id", ms."joinedAt"
      ORDER BY COALESCE(
        (SELECT x."id" FROM "DmMessage" x WHERE x."dmId" = d."id" ORDER BY x."id" DESC LIMIT 1),
        d."id"
      ) DESC
    `;
    const counterparts = await this.prisma.user.findMany({
      where: { id: { in: rows.map(({ counterpartId }) => counterpartId) } },
      select: {
        ...USER_SUMMARY_SELECT,
        memberships: { where: { workspaceId }, select: { id: true } },
      },
    });
    const byId = new Map(counterparts.map((user) => [user.id, user]));
    return rows.map((row) => {
      const counterpart = byId.get(row.counterpartId);
      const present = counterpart !== undefined && counterpart.deletedAt === null;
      return {
        id: row.id,
        counterpart: present ? toUserSummary(counterpart) : null,
        writable: present && counterpart.memberships.length > 0,
        joinedAt: row.joinedAt.toISOString(),
        unread: Number(row.unread),
        lastReadMessageId: row.lastReadMessageId,
      };
    });
  }
}

/**
 * 編集・削除してよいメッセージか。**判定の順を変えない**: 当事者（でなければ 404）→ メッセージの有無（その DM に無い・削除済みは 404）→ 作者（403 `not_message_author`）。
 * 当事者でない人に、メッセージの有無も作者も漏らさない。**相手がいまメンバーかは問わない**（自分が送ったものは、相手が抜けた後も直せる）。
 */
async function assertAuthored(
  tx: Pick<PrismaService, 'dm' | 'dmMessage'>,
  userId: string,
  workspaceId: string,
  dmId: string,
  messageId: string,
): Promise<Parties> {
  const dm = await partiesFor(tx, userId, workspaceId, dmId);
  const row = await tx.dmMessage.findFirst({
    where: { id: messageId, dmId: dm.id, deletedAt: null },
    select: { authorId: true },
  });
  if (!row) throw new NotFoundException();
  if (row.authorId !== userId) throw new ForbiddenException(NOT_MESSAGE_AUTHOR);
  return dm;
}

/**
 * 渡した利用者のうち、そのワークスペースの退会していないメンバーを、`Membership` の行を共有ロックで掴んでから返す。
 * **掴んでいる間、キック・退出・退会（`Membership` の削除）は確定を待つ**——投稿の確定の後に抜けた利用者には、配信の側の確認（`deliver`）が届けない。
 */
async function lockedMembersOf(
  tx: Pick<PrismaService, '$queryRaw'>,
  workspaceId: string,
  userIds: readonly string[],
): Promise<Set<string>> {
  const rows = await tx.$queryRaw<{ userId: string }[]>`
    SELECT ms."userId" AS "userId"
    FROM "Membership" ms
    JOIN "User" u ON u."id" = ms."userId" AND u."deletedAt" IS NULL
    WHERE ms."workspaceId" = ${workspaceId}::uuid AND ms."userId" = ANY(${userIds}::uuid[])
    FOR SHARE OF ms
  `;
  return new Set(rows.map(({ userId }) => userId));
}
