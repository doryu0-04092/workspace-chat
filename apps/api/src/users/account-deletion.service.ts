import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import type { paths } from '@workspace-chat/shared';
import { accountBackoffKey, type LoginBackoffStore } from '../auth/login-backoff';
import { LOGIN_BACKOFF_STORE } from '../auth/login.service';
import { verifySecret } from '../auth/secret-hash';
import { INVALID_TOKEN } from '../auth/session.service';
import {
  BearerUnauthorizedException,
  type ErrorResponse,
  RetryAfterException,
} from '../error-response';
import { PrismaService } from '../prisma.service';
import { RealtimeRooms } from '../realtime/realtime-rooms';

export type DeleteAccountRequest =
  paths['/users/me/delete']['post']['requestBody']['content']['application/json'];

/** 再入力したパスワードが違う（403。本人であることを確かめられない。機能一覧 1.5「本人以外がアカウント削除 API を呼ぶと 403」）。 */
export const PASSWORD_MISMATCH: ErrorResponse = {
  code: 'password_mismatch',
  message: 'パスワードが違います',
};

/**
 * ワークスペースのオーナーは削除できない（403。機能一覧 1.5「理由が画面に表示される」）。
 * 削除すると、そのワークスペースにオーナーが不在になる。オーナー権限の委譲とワークスペースの削除を対象外にしているため（要件定義書 3.4）。
 */
export const OWNER_CANNOT_DELETE_ACCOUNT: ErrorResponse = {
  code: 'owner_cannot_delete_account',
  message:
    'ワークスペースのオーナーはアカウントを削除できません（オーナー権限の委譲とワークスペースの削除には対応していません）',
};

/**
 * アカウントの削除（退会。F-36。機能一覧 1.5）。**本人だけ**——アクセストークンの利用者を消し、他人を指す手段を持たない。
 *
 * - **パスワードの再入力で確かめる。** 違えば 403 `password_mismatch`。**アカウント単位の制限はログインとは別のキーで数える**
 *   （`accountBackoffKey('account_deletion', User.id)`。盗まれたアクセストークンでパスワードを総当たりさせない）
 * - **論理削除と、`User` の行が残るために連鎖削除が働かないものの後始末を、1つのトランザクションで行う**:
 *   `deletedAt` を埋める・未使用のリカバリーコードを使用済みにする・`Membership` を消す（`ChannelMember` は複合外部キーで連鎖する）・
 *   リフレッシュトークンを失効させる（schema.prisma の User.deletedAt）
 * - **オーナーなら削除しない**（403 `owner_cannot_delete_account`）。**利用者の行を掴んでから所属を読む**——
 *   ワークスペースの作成（WorkspacesService.create）は同じ行を FOR SHARE で掴んでからオーナーの所属を作る。掴まずに読むと、
 *   確定前の作成を見落として削除し、オーナーが退会済みのワークスペースが残る（DB は止めない）
 * - **確定した後に、その利用者の WebSocket 接続を切る**（全部の部屋から出る。他のタスクの接続にも効く）。トークンの失効だけでは確立済みの接続は切れない
 */
@Injectable()
export class AccountDeletionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rooms: RealtimeRooms,
    @Inject(LOGIN_BACKOFF_STORE) private readonly backoff: LoginBackoffStore,
  ) {}

  async delete(userId: string, input: DeleteAccountRequest): Promise<void> {
    const key = accountBackoffKey('account_deletion', userId);
    const started = await this.backoff.begin(key, Date.now());
    if (!started.allowed) {
      throw new RetryAfterException(Math.ceil(started.retryAfterMs / 1000));
    }

    const user = await this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: { passwordHash: true },
    });
    if (!user) throw new BearerUnauthorizedException(INVALID_TOKEN);
    if (!(await verifySecret(user.passwordHash, input.password))) {
      await this.backoff.recordFailure(key, Date.now());
      throw new ForbiddenException(PASSWORD_MISMATCH);
    }
    await this.backoff.reset(key);

    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      // 行を掴む前に所属を読まない（上の docblock）。掴めなければ、入口の後で退会した（同時の削除）。
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "User" WHERE "id" = ${userId}::uuid AND "deletedAt" IS NULL FOR UPDATE
      `;
      if (locked.length === 0) throw new BearerUnauthorizedException(INVALID_TOKEN);
      const owned = await tx.membership.count({ where: { userId, role: 'OWNER' } });
      if (owned > 0) throw new ForbiddenException(OWNER_CANNOT_DELETE_ACCOUNT);

      await tx.user.update({ where: { id: userId }, data: { deletedAt: now } });
      await tx.recoveryCode.updateMany({ where: { userId, usedAt: null }, data: { usedAt: now } });
      await tx.membership.deleteMany({ where: { userId } });
      await tx.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: now },
      });
    });

    this.rooms.disconnectUser(userId);
  }
}
