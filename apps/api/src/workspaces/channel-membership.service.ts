import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { paths } from '@workspace-chat/shared';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma.service';
import {
  ALREADY_CHANNEL_MEMBER,
  CHANNEL_ARCHIVED,
  CHANNEL_INVITEE_NOT_FOUND,
  CHANNEL_NOT_PRIVATE,
  NOT_A_CHANNEL_MEMBER,
} from './channel-errors';
import { OWNER_ONLY } from './workspace-errors';
import { WorkspacesService } from './workspaces.service';

export type InviteChannelMemberRequest =
  paths['/workspaces/{id}/channels/{channelId}/members']['post']['requestBody']['content']['application/json'];

/**
 * チャンネルへの参加・退出・招待・キック（機能一覧 2.2・3.1・3.2。#335）。
 *
 * - **要求する側の所属（`WorkspacesService.membershipOf`。退会していない）を最初に確かめ、無ければ存在の有無を区別せず 404**
 * - **チャンネルは `(id, workspaceId)` で引く**（別のワークスペースのチャンネルは 404）
 * - **人を増やす操作（参加・招待）はアーカイブ済みでは拒む。減らす操作（退出・キック）は拒まない**（機能一覧 3.2）
 * - **参加の記録は物理削除**（機能一覧 F-38 の代償）
 * - 接続をチャンネルの部屋へ入れる・部屋から外す処理は、チャンネルの部屋の実装と同時に入れる（#331）
 */
@Injectable()
export class ChannelMembershipService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly workspaces: WorkspacesService,
  ) {}

  /**
   * パブリックチャンネルへの参加（機能一覧 3.1「自由に参加・退出できる」）。
   * **プライベートは、参加していなければオーナーでも 404**（招待で参加する。オーナーの例外は一覧・取得 API だけ。CLAUDE.md 2）。
   * 既に参加していれば 409 `already_channel_member`、アーカイブ済みは 409 `channel_archived`。
   */
  async join(userId: string, workspaceId: string, channelId: string): Promise<void> {
    await this.workspaces.membershipOf(userId, workspaceId);
    const channel = await this.channelFor(userId, workspaceId, channelId);
    if (channel.joined) throw new ConflictException(ALREADY_CHANNEL_MEMBER);
    // 存在を隠す判定を、アーカイブ済みの判定より先に置く（アーカイブ済みのプライベートの存在を 409 で漏らさない）。
    if (channel.visibility === 'PRIVATE') throw new NotFoundException();
    if (channel.archived) throw new ConflictException(CHANNEL_ARCHIVED);
    try {
      await this.prisma.channelMember.create({ data: { channelId, workspaceId, userId } });
    } catch (error) {
      if (isKnown(error, 'P2002')) throw new ConflictException(ALREADY_CHANNEL_MEMBER);
      // 同時にワークスペースから外れた（参加は Membership への外部キーを持つ）。
      if (isKnown(error, 'P2003')) throw new NotFoundException();
      throw error;
    }
  }

  /**
   * 退出（パブリックは自由に。プライベートも自分の意思で。決定・2026-09-12・依頼側。#335）。
   * オーナーも、アーカイブ済みのチャンネルからも抜けられる。参加していなければ種別によらず 404。
   */
  async leave(userId: string, workspaceId: string, channelId: string): Promise<void> {
    await this.workspaces.membershipOf(userId, workspaceId);
    const { count } = await this.prisma.channelMember.deleteMany({
      where: { channelId, workspaceId, userId },
    });
    if (count !== 1) throw new NotFoundException();
  }

  /**
   * プライベートチャンネルへの招待（機能一覧 2.2）。**そのチャンネルの参加者なら誰でも**招待でき、**招待した時点で参加する**
   * （承諾の流れを持たない。決定・2026-09-12・依頼側。#335）。
   * 要求する側のコードは参加者一覧と同じ2段階（参加していなければ、パブリックは 403・プライベートは 404。**オーナーでも同じ**）。
   * パブリックは 422 `channel_not_private`、アーカイブ済みは 409 `channel_archived`。
   * 宛先はそのワークスペースのメンバーで退会していない利用者に限る（422 `invitee_not_found`）。既に参加していれば 409 `already_channel_member`。
   */
  async invite(
    userId: string,
    workspaceId: string,
    channelId: string,
    memberId: string,
  ): Promise<void> {
    await this.workspaces.membershipOf(userId, workspaceId);
    const channel = await this.channelFor(userId, workspaceId, channelId);
    if (!channel.joined) {
      if (channel.visibility === 'PRIVATE') throw new NotFoundException();
      throw new ForbiddenException(NOT_A_CHANNEL_MEMBER);
    }
    if (channel.visibility === 'PUBLIC')
      throw new UnprocessableEntityException(CHANNEL_NOT_PRIVATE);
    if (channel.archived) throw new ConflictException(CHANNEL_ARCHIVED);
    const invitee = await this.prisma.membership.findFirst({
      where: { workspaceId, userId: memberId, user: { deletedAt: null } },
      select: { id: true },
    });
    if (!invitee) throw new UnprocessableEntityException(CHANNEL_INVITEE_NOT_FOUND);
    try {
      await this.prisma.channelMember.create({
        data: { channelId, workspaceId, userId: memberId },
      });
    } catch (error) {
      if (isKnown(error, 'P2002')) throw new ConflictException(ALREADY_CHANNEL_MEMBER);
      // 宛先が同時にワークスペースから外れた。
      if (isKnown(error, 'P2003'))
        throw new UnprocessableEntityException(CHANNEL_INVITEE_NOT_FOUND);
      throw error;
    }
  }

  /**
   * チャンネルからのキック（F-09。機能一覧 2.2）。**オーナーだけ**（メンバーは 403 `owner_only`）。そのチャンネルだけから外す。
   * **オーナーは参加していないプライベートチャンネル・アーカイブ済みのチャンネルからも外せる**（相手は参加者一覧で特定する。機能一覧 3.1）。
   * チャンネルが無い・相手が参加していなければ 404。
   */
  async kick(
    ownerId: string,
    workspaceId: string,
    channelId: string,
    memberId: string,
  ): Promise<void> {
    const requester = await this.workspaces.membershipOf(ownerId, workspaceId);
    if (requester.role !== 'OWNER') throw new ForbiddenException(OWNER_ONLY);
    const { count } = await this.prisma.channelMember.deleteMany({
      where: { channelId, workspaceId, userId: memberId },
    });
    if (count !== 1) throw new NotFoundException();
  }

  /** 要求する側から見たチャンネル。別のワークスペースのチャンネル・無いチャンネルは 404。 */
  private async channelFor(userId: string, workspaceId: string, channelId: string) {
    const row = await this.prisma.channel.findFirst({
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
}

function isKnown(error: unknown, code: string): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === code;
}
