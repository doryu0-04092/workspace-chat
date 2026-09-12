import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { paths } from '@workspace-chat/shared';
import { isUniqueViolation } from '../prisma-errors';
import { PrismaService } from '../prisma.service';
import { USER_SUMMARY_SELECT, toUserSummary } from '../users/user-summary';
import { CHANNEL_NAME_TAKEN, NOT_A_CHANNEL_MEMBER } from './channel-errors';
import { OWNER_ONLY } from './workspace-errors';
import { WorkspacesService } from './workspaces.service';

type CreateOperation = paths['/workspaces/{id}/channels']['post'];
export type CreateChannelRequest = CreateOperation['requestBody']['content']['application/json'];
export type Channel = CreateOperation['responses'][201]['content']['application/json'];
export type ManagedChannel =
  paths['/workspaces/{id}/managed-channels']['get']['responses'][200]['content']['application/json'][number];
export type ChannelMember =
  paths['/workspaces/{id}/channels/{channelId}/members']['get']['responses'][200]['content']['application/json'][number];

/**
 * チャンネルの作成・一覧・オーナーの管理用の一覧・参加者一覧（F-10。機能一覧 3.1）。
 *
 * - **要求する側の所属（`Membership`・退会していない）を最初に確かめ、無ければ存在の有無を区別せず 404**
 *   （`WorkspacesService.membershipOf`。機能一覧 1.4 の2段構えの1段目もここで満たす）
 * - **プライベートチャンネルの可視性の根拠は `ChannelMember` の有無である**（CLAUDE.md 2。`schema.prisma` の `ChannelMember`）。
 *   **オーナーでも、参加していなければ一般の一覧には出さない**——オーナーの例外は管理用の一覧と参加者一覧（人の出入りの管理）だけ
 * - 条件の形は `apps/api/src/prisma-schema.test.ts` の参照実装（`visibleChannels` / `manageableChannels` / `channelMemberViewers` /
 *   `channelMemberList`）に揃える。値はクライアントの問い合わせ API で渡す（文字列に埋め込まない）
 */
@Injectable()
export class ChannelsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly workspaces: WorkspacesService,
  ) {}

  /**
   * 作成。**オーナーだけ**（メンバーは 403 `owner_only`）。**作ったオーナーはそのチャンネルの参加者になる**
   * （派生: プライベートチャンネルに招待できるのは参加者だけであり、作成者が入らないと誰も入れない。パブリックも同じ扱いにする）。
   * チャンネルと参加を1つのトランザクションで作る。同じワークスペースに同じ名前があれば 409 `channel_name_taken`
   * （一意索引 `Channel_workspaceId_name_key`。同時の2件目もここで 409）。名前の形は仕様が確かめる（#290）。
   */
  async create(userId: string, workspaceId: string, input: CreateChannelRequest): Promise<Channel> {
    const membership = await this.workspaces.membershipOf(userId, workspaceId);
    if (membership.role !== 'OWNER') throw new ForbiddenException(OWNER_ONLY);
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
        return { ...channel, joined: true };
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
    return rows.map(({ members, ...channel }) => ({ ...channel, joined: members.length > 0 }));
  }

  /**
   * オーナーの管理用の一覧（機能一覧 3.1。**派生**: これが無いと F-09 が成立しない）。**オーナーだけ**（メンバーは 403 `owner_only`）。
   * **返すのは id・名前・種別・参加者数・アーカイブ済みか だけ**（メッセージ・添付ファイル・未読数・在席は返さない）。
   * **アーカイブ済みも含める**（含めないと復元の経路が無くなる。F-35）。**参加者数は退会者を除く**。
   */
  async managed(userId: string, workspaceId: string): Promise<ManagedChannel[]> {
    const membership = await this.workspaces.membershipOf(userId, workspaceId);
    if (membership.role !== 'OWNER') throw new ForbiddenException(OWNER_ONLY);
    const rows = await this.prisma.channel.findMany({
      where: { workspaceId },
      select: {
        id: true,
        name: true,
        visibility: true,
        archivedAt: true,
        _count: {
          select: { members: { where: { membership: { user: { deletedAt: null } } } } },
        },
      },
      orderBy: { name: 'asc' },
    });
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      visibility: row.visibility,
      memberCount: row._count.members,
      archived: row.archivedAt !== null,
    }));
  }

  /**
   * 参加者一覧（機能一覧 3.1）。**コードは2段階**: 所属していなければ種別によらず 404。所属していて参加者でもオーナーでもなければ、
   * **パブリックは 403 `not_a_channel_member`・プライベートは 404**（存在を隠す）。**オーナーは参加していなくても取得できる**（例外の側）。
   * 別のワークスペースのチャンネル・存在しないチャンネルは 404。**退会者は一覧に出さない**（1.5）。在席は含めない。
   */
  async members(userId: string, workspaceId: string, channelId: string): Promise<ChannelMember[]> {
    const membership = await this.workspaces.membershipOf(userId, workspaceId);
    const channel = await this.prisma.channel.findFirst({
      where: { id: channelId, workspaceId },
      select: { visibility: true, members: { where: { userId }, select: { id: true } } },
    });
    if (!channel) throw new NotFoundException();
    if (channel.members.length === 0 && membership.role !== 'OWNER') {
      if (channel.visibility === 'PRIVATE') throw new NotFoundException();
      throw new ForbiddenException(NOT_A_CHANNEL_MEMBER);
    }
    const rows = await this.prisma.channelMember.findMany({
      where: { channelId, membership: { user: { deletedAt: null } } },
      select: { membership: { select: { user: { select: USER_SUMMARY_SELECT } } } },
      orderBy: [{ joinedAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map(({ membership: { user } }) => toUserSummary(user));
  }
}
