import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { UnreadUpdatedPayload, paths } from '@workspace-chat/shared';
import { isUniqueViolation } from '../prisma-errors';
import { PrismaService } from '../prisma.service';
import { RealtimeEmitter } from '../realtime/realtime.emitter';
import { USER_SUMMARY_SELECT, toUserSummary } from '../users/user-summary';
import { assertChannelParticipant, channelFor } from './channel-access';
import { unreadOfChannels } from './unread';
import { CHANNEL_NAME_TAKEN } from './channel-errors';
import { MANAGED_CHANNEL_SELECT, type ManagedChannel, toManagedChannel } from './managed-channel';
import { WorkspacesService } from './workspaces.service';

type CreateOperation = paths['/workspaces/{id}/channels']['post'];
export type CreateChannelRequest = CreateOperation['requestBody']['content']['application/json'];
export type Channel = CreateOperation['responses'][201]['content']['application/json'];
export type UpdateChannelReadRequest =
  paths['/workspaces/{id}/channels/{channelId}/read']['put']['requestBody']['content']['application/json'];
export type { ManagedChannel };
export type ChannelMember =
  paths['/workspaces/{id}/channels/{channelId}/members']['get']['responses'][200]['content']['application/json'][number];

/**
 * メンションの補完候補の上限（機能一覧 9.1。実装時に決めた値）。
 * **踏むと壊れる: 変えるなら `packages/shared/openapi/openapi.yaml` の `listMentionCandidates` の `maxItems` と description、機能一覧 9.1 も同じ値にする**
 * ——応答は仕様で検証しない（openapi-validation.ts の `validateResponses: false`）ため、片方だけ変えても何も落ちない。
 */
const MENTION_CANDIDATE_LIMIT = 10;

/**
 * チャンネルの作成・一覧・オーナーの管理用の一覧・参加者一覧（F-10。機能一覧 3.1）と、メンションの補完候補（F-20。9.1）。
 *
 * - **要求する側の所属（`Membership`・退会していない）を最初に確かめ、無ければ存在の有無を区別せず 404**
 *   （`WorkspacesService.membershipOf`。機能一覧 1.4 の2段構えの1段目もここで満たす）
 * - **プライベートチャンネルの可視性の根拠は `ChannelMember` の有無である**（CLAUDE.md 2。`schema.prisma` の `ChannelMember`）。
 *   **オーナーでも、参加していなければ一般の一覧には出さない**——オーナーの例外は管理用の一覧と参加者一覧（人の出入りの管理）と、アーカイブ・復元の応答（管理用の一覧と同じ項目）だけ
 * - 条件の形は `apps/api/src/prisma-schema.test.ts` の参照実装（`visibleChannels` / `manageableChannels` / `channelMemberViewers` /
 *   `channelMemberList` / `mentionCandidatesByPrefix`）に揃える。値はクライアントの問い合わせ API か、`$queryRaw` のタグ付きテンプレートのプレースホルダで渡す（文字列に埋め込まない）
 */
@Injectable()
export class ChannelsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly workspaces: WorkspacesService,
    private readonly emitter: RealtimeEmitter,
  ) {}

  /**
   * 作成。**オーナーだけ**（メンバーは 403 `owner_only`）。**作ったオーナーはそのチャンネルの参加者になる**
   * （派生: プライベートチャンネルに招待できるのは参加者だけであり、作成者が入らないと誰も入れない。パブリックも同じ扱いにする）。
   * チャンネルと参加を1つのトランザクションで作る。同じワークスペースに同じ名前があれば 409 `channel_name_taken`
   * （一意索引 `Channel_workspaceId_name_key`。同時の2件目もここで 409）。名前の形は仕様が確かめる（#290）。
   */
  async create(userId: string, workspaceId: string, input: CreateChannelRequest): Promise<Channel> {
    await this.workspaces.ownerMembershipOf(userId, workspaceId);
    try {
      return await this.prisma.$transaction(async (tx) => {
        const channel = await tx.channel.create({
          // baseName は作成時の名前（アーカイブの採番の基底。schema.prisma の Channel.baseName）。
          data: {
            workspaceId,
            name: input.name,
            baseName: input.name,
            visibility: input.visibility,
          },
          select: { id: true, name: true, visibility: true },
        });
        await tx.channelMember.create({ data: { channelId: channel.id, workspaceId, userId } });
        // 作った直後は、そのチャンネルにメッセージが1件も無い（F-23。機能一覧 10.1）。
        return { ...channel, joined: true, unread: 0, lastReadMessageId: null };
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictException(CHANNEL_NAME_TAKEN);
      throw error;
    }
  }

  /**
   * 一般の一覧（参加者向け）。**パブリックと、自分が参加しているプライベートだけ**。アーカイブ済みは出さない（3.2）。名前の順。
   * `visibleChannels` の条件に `archivedAt IS NULL` を足した形（`manageableChannels` には写さない）。
   */
  async list(userId: string, workspaceId: string): Promise<Channel[]> {
    await this.workspaces.membershipOf(userId, workspaceId);
    const rows = await this.prisma.channel.findMany({
      where: {
        workspaceId,
        archivedAt: null,
        OR: [{ visibility: 'PUBLIC' }, { members: { some: { userId } } }],
      },
      select: {
        id: true,
        name: true,
        visibility: true,
        members: { where: { userId }, select: { id: true } },
      },
      orderBy: { name: 'asc' },
    });
    const unread = await unreadOfChannels(
      this.prisma,
      userId,
      rows.filter(({ members }) => members.length > 0).map(({ id }) => id),
    );
    return rows.map(({ members, ...channel }) => ({
      ...channel,
      joined: members.length > 0,
      // **参加していないチャンネルは、未読 0・既読位置なし**（既読位置も参加も持たない。機能一覧 10.1）。
      unread: unread.get(channel.id)?.unread ?? 0,
      lastReadMessageId: unread.get(channel.id)?.lastReadMessageId ?? null,
    }));
  }

  /**
   * 既読位置の更新（F-23。機能一覧 10.1）。**コードは参加者一覧と同じ2段階で、オーナーの例外は及ばない**
   * （参加していないチャンネルに既読位置を持たない）。渡された id が、そのチャンネルの削除されていないメッセージでなければ 404。
   *
   * **既読位置は進めるだけで戻さない**——渡された id が、いま持っている位置より古ければ何も変えない（応答は 204 のまま。10.1）。
   */
  async updateRead(
    userId: string,
    workspaceId: string,
    channelId: string,
    lastReadMessageId: string,
  ): Promise<void> {
    await this.workspaces.membershipOf(userId, workspaceId);
    assertChannelParticipant(await channelFor(this.prisma, userId, workspaceId, channelId));
    const message = await this.prisma.message.findFirst({
      where: { id: lastReadMessageId, channelId, deletedAt: null },
      select: { id: true },
    });
    if (message === null) throw new NotFoundException();
    await this.prisma.$executeRaw`
      INSERT INTO "ChannelRead" ("id", "channelId", "workspaceId", "userId", "lastReadMessageId", "updatedAt")
      VALUES (gen_random_uuid(), ${channelId}::uuid, ${workspaceId}::uuid, ${userId}::uuid, ${lastReadMessageId}::uuid, now())
      ON CONFLICT ("channelId", "userId") DO UPDATE
        SET "lastReadMessageId" = EXCLUDED."lastReadMessageId", "updatedAt" = now()
        WHERE "ChannelRead"."lastReadMessageId" < EXCLUDED."lastReadMessageId"
    `;
    // **変わったのは自分の未読だけ**なので、自分の部屋へ1件だけ送る（機能一覧 5.2・10.1）。
    // 資格の確認は上の2段階で済んでいる（参加者でなければここへ来ない）。
    const unread = await unreadOfChannels(this.prisma, userId, [channelId]);
    const payload: UnreadUpdatedPayload = {
      channelId,
      unread: unread.get(channelId)?.unread ?? 0,
      sentAt: new Date().toISOString(),
    };
    this.emitter.toUsers([userId], 'unread:updated', payload);
  }

  /**
   * オーナーの管理用の一覧（機能一覧 3.1。**派生**: これが無いと F-09 が成立しない）。**オーナーだけ**（メンバーは 403 `owner_only`）。
   * **返すのは id・名前・種別・参加者数・アーカイブ済みか だけ**（メッセージ・添付ファイル・未読数・在席は返さない）。
   * **アーカイブ済みも含める**（含めないと復元の経路が無くなる。F-35）。**参加者数は退会者を除く**。
   */
  async managed(userId: string, workspaceId: string): Promise<ManagedChannel[]> {
    await this.workspaces.ownerMembershipOf(userId, workspaceId);
    const rows = await this.prisma.channel.findMany({
      where: { workspaceId },
      select: MANAGED_CHANNEL_SELECT,
      orderBy: { name: 'asc' },
    });
    return rows.map(toManagedChannel);
  }

  /**
   * 参加者一覧（機能一覧 3.1）。**コードは2段階**: 所属していなければ種別によらず 404。所属していて参加者でもオーナーでもなければ、
   * **パブリックは 403 `not_a_channel_member`・プライベートは 404**（存在を隠す）。**オーナーは参加していなくても取得できる**（例外の側）。
   * 別のワークスペースのチャンネル・存在しないチャンネルは 404。**退会者は一覧に出さない**（1.5）。在席は含めない。
   */
  async members(userId: string, workspaceId: string, channelId: string): Promise<ChannelMember[]> {
    const membership = await this.workspaces.membershipOf(userId, workspaceId);
    const channel = await channelFor(this.prisma, userId, workspaceId, channelId);
    if (membership.role !== 'OWNER') assertChannelParticipant(channel);
    const rows = await this.prisma.channelMember.findMany({
      where: { channelId, membership: { user: { deletedAt: null } } },
      select: { membership: { select: { user: { select: USER_SUMMARY_SELECT } } } },
      orderBy: [{ joinedAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map(({ membership: { user } }) => toUserSummary(user));
  }

  /**
   * メンションの補完候補（F-20。機能一覧 9.1。参照実装は prisma-schema.test.ts の `mentionCandidatesByPrefix`）。
   * **候補は投稿時の宛先解決（経路1）で解決できる利用者と一致させる**——対象も要求する側も、そのチャンネルの参加者で退会していない。違うのは前方一致であることだけ。
   * **オーナーの例外は及ばない**（`members` と違い、役割によらず参加の2段階を当てる。候補に出た利用者は、参加者でなければ投稿で解決されない）。
   * - 照合は `lower()` の前方一致で、**`LIKE` を使わない**（`_` はユーザーID の文字であり、`LIKE` のワイルドカードでもある）
   * - **踏むと壊れる: 生の SQL は schema.prisma の列名の写し（`@map`）を通らない**——`User.loginId` の列は `"userId"` である
   */
  async mentionCandidates(
    userId: string,
    workspaceId: string,
    channelId: string,
    prefix: string,
  ): Promise<ChannelMember[]> {
    await this.workspaces.membershipOf(userId, workspaceId);
    assertChannelParticipant(await channelFor(this.prisma, userId, workspaceId, channelId));
    const rows = await this.prisma.$queryRaw<
      { id: string; loginId: string; displayName: string }[]
    >`
      SELECT u."id", u."userId" AS "loginId", u."displayName"
      FROM "User" u
      JOIN "ChannelMember" cm ON cm."userId" = u."id" AND cm."channelId" = ${channelId}::uuid
      JOIN "ChannelMember" vcm ON vcm."channelId" = ${channelId}::uuid AND vcm."userId" = ${userId}::uuid
      JOIN "User" viewer ON viewer."id" = vcm."userId" AND viewer."deletedAt" IS NULL
      WHERE starts_with(lower(u."userId"), lower(${prefix})) AND u."deletedAt" IS NULL
      ORDER BY lower(u."userId")
      LIMIT ${MENTION_CANDIDATE_LIMIT}
    `;
    return rows.map(toUserSummary);
  }
}
