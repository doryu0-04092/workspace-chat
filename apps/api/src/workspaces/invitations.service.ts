import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { InvitationNewPayload, paths } from '@workspace-chat/shared';
import { isUniqueViolation } from '../prisma-errors';
import { PrismaService } from '../prisma.service';
import { RealtimeEmitter } from '../realtime/realtime.emitter';
import { USER_SUMMARY_SELECT, toUserSummary } from '../users/user-summary';
import { ALREADY_INVITED, ALREADY_MEMBER, INVITEE_NOT_FOUND } from './invitation-errors';
import {
  type Workspace,
  WORKSPACE_SELECT,
  WorkspacesService,
  toWorkspace,
} from './workspaces.service';

/** 招待の候補の上限（#616。実装時に決めた値）。**踏むと壊れる: 変えるなら openapi.yaml の `listInvitationCandidates` の maxItems も同じ値にする。** */
export const INVITATION_CANDIDATE_LIMIT = 10;

type UserSummary = ReturnType<typeof toUserSummary>;

type InviteOperation = paths['/workspaces/{id}/invitations']['post'];
export type CreateInvitationRequest = InviteOperation['requestBody']['content']['application/json'];
export type Invitation = InviteOperation['responses'][201]['content']['application/json'];
export type MyInvitation =
  paths['/invitations']['get']['responses'][200]['content']['application/json'][number];

/**
 * ワークスペースへの招待と、招待の承諾・辞退（F-08 / F-38。機能一覧 2.2）。
 *
 * - **招待できるのはオーナーだけ**（メンバーは 403 `owner_only`。所属していなければ、存在の有無を区別せず 404）
 * - **宛先はユーザーID を大文字小文字を区別せずに引き、退会済みは解決しない**（`lower("userId")` と `"deletedAt" IS NULL`。
 *   Prisma のクライアントの等値比較では大文字小文字を区別するため `$queryRaw` で書く。解決できなければ 422 `invitee_not_found`）
 * - **同じ利用者への未承諾の招待が既にあれば 409 `already_invited`、既にメンバーなら 409 `already_member`**（決定・2026-09-12・依頼側。#326）
 * - **招待したら、招待された利用者の部屋へ `invitation:new` を送る**（決定・同。宛先は招待された本人だけ——自分宛ての招待を受け取る資格は本人にある）
 * - **要求する側の `deletedAt IS NULL` を、入口（ガード）とは別に、招待・自分宛ての一覧・承諾・辞退の問い合わせにも置く**（機能一覧 1.4 の2段構えの1段目）
 * - **承諾・辞退できるのは招待された本人だけ**（他人宛ては、存在の有無を区別せず 404）。承諾は招待を消して `Membership`（MEMBER）を作る
 */
@Injectable()
export class InvitationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeEmitter,
    private readonly workspaces: WorkspacesService,
  ) {}

  async invite(
    ownerId: string,
    workspaceId: string,
    input: CreateInvitationRequest,
  ): Promise<Invitation> {
    // 所属（退会していない）とオーナーの判定は WorkspacesService に1つだけ置く。要求する側の要約も同じ問い合わせで取る。
    const owner = await this.workspaces.ownerMembershipOf(ownerId, workspaceId);

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
      workspace: { id: owner.workspace.id, name: owner.workspace.name },
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

  /**
   * 招待の候補（#616。提案・承認済・2026-09-18・依頼側）。**オーナーだけ**（判定は `invite` と同じ `ownerMembershipOf`）。
   * - 対象は退会していない利用者のうち、そのワークスペースのメンバーでなく、未承諾の招待も無い人（招待しても 409 になる人を出さない）
   * - ユーザーID か表示名に q を含む人を、大文字小文字によらず当てる。**`LIKE` を使わない**（`_` と `%` を利用者が書けるため。`strpos` で位置を見る）
   * - 並びは、ユーザーID の先頭一致 → 表示名の先頭一致 → 途中の一致の順、同じ段ではユーザーID の小文字の順。最大 `INVITATION_CANDIDATE_LIMIT` 人
   * - **踏むと壊れる: 生の SQL は schema.prisma の列名の写し（`@map`）を通らない**——`User.loginId` の列は `"userId"` である
   *
   * 代償: オーナーは、登録している利用者のユーザーID と表示名を一部の文字から調べられる（ワークスペースは誰でも作れるため、実質すべての利用者）。
   * 依頼側の判断で受け入れる。返すのは要約（id・ユーザーID・表示名）だけで、件数と回数に上限を置く。
   */
  async candidates(ownerId: string, workspaceId: string, q: string): Promise<UserSummary[]> {
    await this.workspaces.ownerMembershipOf(ownerId, workspaceId);
    const rows = await this.prisma.$queryRaw<
      { id: string; loginId: string; displayName: string }[]
    >`
      SELECT u."id", u."userId" AS "loginId", u."displayName"
      FROM "User" u
      WHERE u."deletedAt" IS NULL
        AND (strpos(lower(u."userId"), lower(${q})) > 0 OR strpos(lower(u."displayName"), lower(${q})) > 0)
        AND NOT EXISTS (
          SELECT 1 FROM "Membership" m WHERE m."workspaceId" = ${workspaceId}::uuid AND m."userId" = u."id"
        )
        AND NOT EXISTS (
          SELECT 1 FROM "Invitation" i WHERE i."workspaceId" = ${workspaceId}::uuid AND i."inviteeId" = u."id"
        )
      ORDER BY
        CASE
          WHEN starts_with(lower(u."userId"), lower(${q})) THEN 0
          WHEN starts_with(lower(u."displayName"), lower(${q})) THEN 1
          ELSE 2
        END,
        lower(u."userId")
      LIMIT ${INVITATION_CANDIDATE_LIMIT}
    `;
    return rows.map(toUserSummary);
  }

  /** 自分宛ての未承諾の招待。届いた順（同時刻は id〔UUIDv7〕の順）。 */
  async mine(userId: string): Promise<MyInvitation[]> {
    const rows = await this.prisma.invitation.findMany({
      where: { inviteeId: userId, invitee: { deletedAt: null } },
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
          where: { id: invitationId, inviteeId: userId, invitee: { deletedAt: null } },
          select: { workspace: { select: WORKSPACE_SELECT } },
        });
        if (!invitation) throw new NotFoundException();
        const { count } = await tx.invitation.deleteMany({
          where: { id: invitationId, inviteeId: userId, invitee: { deletedAt: null } },
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
      where: { id: invitationId, inviteeId: userId, invitee: { deletedAt: null } },
    });
    if (count !== 1) throw new NotFoundException();
  }
}
