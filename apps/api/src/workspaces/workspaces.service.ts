import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { paths } from '@workspace-chat/shared';
import { INVALID_TOKEN } from '../auth/session.service';
import { BearerUnauthorizedException } from '../error-response';
import { PrismaService } from '../prisma.service';
import { OWNER_CANNOT_LEAVE, OWNER_ONLY } from './workspace-errors';

type CreateOperation = paths['/workspaces']['post'];
export type CreateWorkspaceRequest = CreateOperation['requestBody']['content']['application/json'];
export type Workspace = CreateOperation['responses'][201]['content']['application/json'];
export type WorkspaceMember =
  paths['/workspaces/{id}/members']['get']['responses'][200]['content']['application/json'][number];

export const WORKSPACE_SELECT = { id: true, name: true, createdAt: true } as const;

/**
 * ワークスペース（F-06。機能一覧 2.1）。**所属は `Membership` の行だけを根拠にする**（オーナーも `role` で表す。schema.prisma）。
 *
 * - **所属していないワークスペースは、存在の有無を区別せず 404**（本体は状態コードの本体。機能一覧 2.1・1.4）
 * - **参加者一覧と所属の判定は `User.deletedAt IS NULL` の行だけを見る**（退会済みを参加者に残さない。機能一覧 1.5・2.1）
 * - 名前の形（1〜50 文字・空白だけは不可）は仕様（openapi.yaml）が確かめる。同名を許す（#290。schema.prisma の Workspace の注記）
 */
@Injectable()
export class WorkspacesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 作成者をオーナーとして、**同じ文で**参加させる（schema.prisma の Membership の注記: オーナーが 0 人のワークスペースを作らない）。
   * 退会済みの利用者は作れない（入口の判定とは別に、書き込み側にも条件を置く。profile.service.ts と同じ）。
   */
  async create(userId: string, input: CreateWorkspaceRequest): Promise<Workspace> {
    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.findFirst({
        where: { id: userId, deletedAt: null },
        select: { id: true },
      });
      if (!user) throw new BearerUnauthorizedException(INVALID_TOKEN);
      const workspace = await tx.workspace.create({
        data: { name: input.name, memberships: { create: { userId, role: 'OWNER' } } },
        select: WORKSPACE_SELECT,
      });
      return toWorkspace(workspace, 'OWNER');
    });
  }

  /** 自分が所属するワークスペース（サイドバーの切替）。参加した順（同時刻は id〔UUIDv7〕の順）。 */
  async list(userId: string): Promise<Workspace[]> {
    const rows = await this.prisma.membership.findMany({
      where: { userId, user: { deletedAt: null } },
      select: { role: true, workspace: { select: WORKSPACE_SELECT } },
      orderBy: [{ joinedAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map((row) => toWorkspace(row.workspace, row.role));
  }

  async get(userId: string, workspaceId: string): Promise<Workspace> {
    const row = await this.membershipOf(userId, workspaceId);
    return toWorkspace(row.workspace, row.role);
  }

  /** 参加者一覧。**退会済みを含まない**（機能一覧 2.1。prisma-schema.test.ts の `workspaceMemberList` が参照実装）。 */
  async members(userId: string, workspaceId: string): Promise<WorkspaceMember[]> {
    await this.membershipOf(userId, workspaceId);
    const rows = await this.prisma.membership.findMany({
      where: { workspaceId, user: { deletedAt: null } },
      select: { role: true, user: { select: { id: true, loginId: true, displayName: true } } },
      orderBy: [{ joinedAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map(({ role, user }) => ({
      id: user.id,
      userId: user.loginId,
      displayName: user.displayName,
      role,
    }));
  }

  /**
   * キック（F-09。機能一覧 2.2）。**オーナーだけ**（メンバーは 403 `owner_only`、所属していなければ存在の有無を区別せず 404）。
   * オーナー自身は外せない（403 `owner_cannot_leave`）。外す相手がメンバーでなければ 404。
   * **参加の記録は物理削除**（機能一覧 F-38 の代償）。`ChannelMember` は `Membership` の連鎖で消える（全チャンネルから外れる）。
   * 接続をチャンネルの部屋から外す処理は、チャンネルの部屋の実装と同時に入れる（#331）。
   */
  async kick(ownerId: string, workspaceId: string, memberId: string): Promise<void> {
    const requester = await this.membershipOf(ownerId, workspaceId);
    if (requester.role !== 'OWNER') throw new ForbiddenException(OWNER_ONLY);
    if (memberId === ownerId) throw new ForbiddenException(OWNER_CANNOT_LEAVE);
    const { count } = await this.prisma.membership.deleteMany({
      where: { workspaceId, userId: memberId, role: 'MEMBER' },
    });
    if (count !== 1) throw new NotFoundException();
  }

  /**
   * 退出（F-38）。メンバー本人。**オーナーは退出できない**（403 `owner_cannot_leave`。理由のメッセージを返す）。
   * 所属していなければ存在の有無を区別せず 404。参加の記録は物理削除（キックと同じ）。
   */
  async leave(userId: string, workspaceId: string): Promise<void> {
    const membership = await this.membershipOf(userId, workspaceId);
    if (membership.role === 'OWNER') throw new ForbiddenException(OWNER_CANNOT_LEAVE);
    const { count } = await this.prisma.membership.deleteMany({
      where: { workspaceId, userId, role: 'MEMBER', user: { deletedAt: null } },
    });
    if (count !== 1) throw new NotFoundException();
  }

  /** 要求する側の所属。無ければ 404（存在の有無を区別しない）。 */
  private async membershipOf(userId: string, workspaceId: string) {
    const row = await this.prisma.membership.findFirst({
      where: { userId, workspaceId, user: { deletedAt: null } },
      select: { role: true, workspace: { select: WORKSPACE_SELECT } },
    });
    if (!row) throw new NotFoundException();
    return row;
  }
}

export function toWorkspace(
  row: { id: string; name: string; createdAt: Date },
  role: Workspace['role'],
): Workspace {
  return { id: row.id, name: row.name, createdAt: row.createdAt.toISOString(), role };
}
