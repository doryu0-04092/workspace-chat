import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { InvitationNewPayload, paths } from '@workspace-chat/shared';
import type { ErrorResponse } from '../error-response';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma.service';
import { RealtimeEmitter } from '../realtime/realtime.emitter';
import { type Workspace, WORKSPACE_SELECT, toWorkspace } from './workspaces.service';

type InviteOperation = paths['/workspaces/{id}/invitations']['post'];
export type CreateInvitationRequest = InviteOperation['requestBody']['content']['application/json'];
export type Invitation = InviteOperation['responses'][201]['content']['application/json'];
export type MyInvitation =
  paths['/invitations']['get']['responses'][200]['content']['application/json'][number];

const OWNER_ONLY: ErrorResponse = { code: 'owner_only', message: 'オーナーだけが実行できます' };
const INVITEE_NOT_FOUND: ErrorResponse = {
  code: 'invitee_not_found',
  message: 'そのユーザーID の利用者はいません',
};
const ALREADY_INVITED: ErrorResponse = {
  code: 'already_invited',
  message: 'この利用者は既に招待しています',
};
const ALREADY_MEMBER: ErrorResponse = {
  code: 'already_member',
  message: 'この利用者は既にメンバーです',
};

const USER_SUMMARY_SELECT = { id: true, loginId: true, displayName: true } as const;

function toUserSummary(user: { id: string; loginId: string; displayName: string }) {
  return { id: user.id, userId: user.loginId, displayName: user.displayName };
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

/**
 * ワークスペースへの招待と、招待の承諾・辞退（F-08 / F-38。機能一覧 2.2）。
 *
 * - **招待できるのはオーナーだけ**（メンバーは 403 `owner_only`。所属していなければ、存在の有無を区別せず 404）
 * - **宛先はユーザーID を大文字小文字を区別せずに引き、退会済みは解決しない**（`lower("userId")` と `"deletedAt" IS NULL`。
 *   Prisma のクライアントの等値比較では大文字小文字を区別するため `$queryRaw` で書く。解決できなければ 422 `invitee_not_found`）
 * - **同じ利用者への未承諾の招待が既にあれば 409 `already_invited`、既にメンバーなら 409 `already_member`**（決定・2026-09-12・依頼側。#326）
 * - **招待したら、招待された利用者の部屋へ `invitation:new` を送る**（決定・同。宛先は招待された本人だけ——自分宛ての招待を受け取る資格は本人にある）
 * - **承諾・辞退できるのは招待された本人だけ**（他人宛ては、存在の有無を区別せず 404）。承諾は招待を消して `Membership`（MEMBER）を作る
 */
@Injectable()
export class InvitationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeEmitter,
  ) {}

  async invite(
    ownerId: string,
    workspaceId: string,
    input: CreateInvitationRequest,
  ): Promise<Invitation> {
    const owner = await this.prisma.membership.findFirst({
      where: { userId: ownerId, workspaceId, user: { deletedAt: null } },
      select: {
        role: true,
        workspace: { select: { id: true, name: true } },
        user: { select: USER_SUMMARY_SELECT },
      },
    });
    if (!owner) throw new NotFoundException();
    if (owner.role !== 'OWNER') throw new ForbiddenException(OWNER_ONLY);

    const [invitee] = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "User"
      WHERE lower("userId") = lower(${input.userId}) AND "deletedAt" IS NULL
    `;
    if (!invitee) throw new UnprocessableEntityException(INVITEE_NOT_FOUND);

    const member = await this.prisma.membership.findUnique({
      where: { workspaceId_userId: { workspaceId, userId: invitee.id } },
      select: { id: true },
    });
    if (member) throw new ConflictException(ALREADY_MEMBER);

    const created = await this.prisma.invitation
      .create({
        data: { workspaceId, inviteeId: invitee.id, invitedById: ownerId },
        select: { id: true, createdAt: true, invitee: { select: USER_SUMMARY_SELECT } },
      })
      .catch((error: unknown) => {
        // 同じ利用者への未承諾の招待は1件だけ（一意索引）。同時の2件目もここで 409 になる。
        if (isUniqueViolation(error)) throw new ConflictException(ALREADY_INVITED);
        throw error;
      });

    // 書き込みが確定してから送る（送った後に書き込みが落ちると、存在しない招待を知らせることになる）。
    const payload: InvitationNewPayload = {
      invitationId: created.id,
      workspace: owner.workspace,
      invitedBy: toUserSummary(owner.user),
      sentAt: new Date().toISOString(),
    };
    this.realtime.toUsers([invitee.id], 'invitation:new', payload);

    return {
      id: created.id,
      workspaceId,
      invitee: toUserSummary(created.invitee),
      createdAt: created.createdAt.toISOString(),
    };
  }

  /** 自分宛ての未承諾の招待。届いた順（同時刻は id〔UUIDv7〕の順）。 */
  async mine(userId: string): Promise<MyInvitation[]> {
    const rows = await this.prisma.invitation.findMany({
      where: { inviteeId: userId },
      select: {
        id: true,
        createdAt: true,
        workspace: { select: { id: true, name: true } },
        invitedBy: { select: USER_SUMMARY_SELECT },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map((row) => ({
      id: row.id,
      workspace: row.workspace,
      invitedBy: toUserSummary(row.invitedBy),
      createdAt: row.createdAt.toISOString(),
    }));
  }

  /**
   * 承諾。**招待を消すことと `Membership` を作ることを1つのトランザクションで行う**——片方だけが残ると、
   * 「参加したのに招待が残る」か「招待が消えたのに参加していない」になる。消す行が 0 件（同時の承諾・辞退と重なった）なら 404。
   */
  async accept(userId: string, invitationId: string): Promise<Workspace> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const invitation = await tx.invitation.findFirst({
          where: { id: invitationId, inviteeId: userId },
          select: { workspace: { select: WORKSPACE_SELECT } },
        });
        if (!invitation) throw new NotFoundException();
        const { count } = await tx.invitation.deleteMany({
          where: { id: invitationId, inviteeId: userId },
        });
        if (count !== 1) throw new NotFoundException();
        await tx.membership.create({
          data: { workspaceId: invitation.workspace.id, userId, role: 'MEMBER' },
        });
        return toWorkspace(invitation.workspace, 'MEMBER');
      });
    } catch (error) {
      // 招待の後に別の経路で参加していた。トランザクションは戻り、招待は残る。
      if (isUniqueViolation(error)) throw new ConflictException(ALREADY_MEMBER);
      throw error;
    }
  }

  /** 辞退。招待を消す（オーナーは再度招待できる）。 */
  async decline(userId: string, invitationId: string): Promise<void> {
    const { count } = await this.prisma.invitation.deleteMany({
      where: { id: invitationId, inviteeId: userId },
    });
    if (count !== 1) throw new NotFoundException();
  }
}
