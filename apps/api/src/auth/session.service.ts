import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { ErrorResponse } from '../error-response';
import { PrismaService } from '../prisma.service';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  REFRESH_TOKEN_TTL_SECONDS,
  generateRefreshToken,
  hashRefreshToken,
} from './session-tokens';

/** 発行したトークン。リフレッシュトークンは Cookie でだけ渡し、本体には載せない。 */
export type IssuedTokens = {
  readonly accessToken: string;
  readonly expiresIn: number;
  readonly refreshToken: string;
};

/** リフレッシュトークンが使えないときの本体。**無い・知らない・失効済み・期限切れ・退会済みを区別しない。** */
export const INVALID_TOKEN: ErrorResponse = {
  code: 'invalid_token',
  message: 'ログインし直してください',
};

/**
 * ログインの系列（リフレッシュトークンの入れ替えの連なり）を扱う（機能一覧 1.2）。
 *
 * - **start**: ログインで新しい系列を作る
 * - **rotate**: リフレッシュのたびに、使ったトークンを失効させて同じ系列の新しいトークンを出す。**失効済みのトークンが
 *   出されたら、盗まれたものとみなして系列ごと失効させる**（RFC 9700 4.14.2）
 * - **end**: ログアウトで系列ごと失効させる
 */
@Injectable()
export class SessionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  async start(userId: string): Promise<IssuedTokens> {
    const refreshToken = generateRefreshToken();
    // familyId は schema.prisma の既定値（UUIDv7）で新しく作る。
    await this.prisma.refreshToken.create({
      data: { userId, tokenHash: hashRefreshToken(refreshToken), expiresAt: refreshExpiry() },
    });
    return this.issue(userId, refreshToken);
  }

  /**
   * **使ったトークンの失効と新しいトークンの作成を1つのトランザクションで行い、失効は「まだ失効していない行」だけに当てる。**
   * 同じトークンで同時にリフレッシュされたとき、後の側は失効させる行が 0 件になり、再利用として扱う（入れ替えに成功するのは1つだけ）。
   */
  async rotate(refreshToken: string | undefined): Promise<IssuedTokens> {
    if (refreshToken === undefined || refreshToken === '') throw invalidToken();
    const row = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: hashRefreshToken(refreshToken) },
      include: { user: { select: { deletedAt: true } } },
    });
    if (!row) throw invalidToken();

    const now = new Date();
    // 失効済み（入れ替え済み・ログアウト済み）のトークンは、下のトランザクションで失効させる行が 0 件になり、再利用として扱う。
    if (row.expiresAt <= now || row.user.deletedAt !== null) throw invalidToken();

    const next = generateRefreshToken();
    const rotated = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.refreshToken.updateMany({
        where: { id: row.id, revokedAt: null },
        data: { revokedAt: now },
      });
      if (count !== 1) return false;
      await tx.refreshToken.create({
        data: {
          userId: row.userId,
          familyId: row.familyId,
          tokenHash: hashRefreshToken(next),
          expiresAt: refreshExpiry(),
        },
      });
      return true;
    });
    if (!rotated) {
      await this.revokeFamily(row.familyId, now);
      throw invalidToken();
    }
    return this.issue(row.userId, next);
  }

  /** トークンが無い・知らないときは何もしない（ログアウトは常に成功として返す）。 */
  async end(refreshToken: string | undefined): Promise<void> {
    if (refreshToken === undefined || refreshToken === '') return;
    const row = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: hashRefreshToken(refreshToken) },
      select: { familyId: true },
    });
    if (row) await this.revokeFamily(row.familyId, new Date());
  }

  private async revokeFamily(familyId: string, now: Date): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: now },
    });
  }

  private async issue(userId: string, refreshToken: string): Promise<IssuedTokens> {
    const accessToken = await this.jwt.signAsync({ sub: userId });
    return { accessToken, expiresIn: ACCESS_TOKEN_TTL_SECONDS, refreshToken };
  }
}

function refreshExpiry(): Date {
  return new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000);
}

function invalidToken(): UnauthorizedException {
  return new UnauthorizedException(INVALID_TOKEN);
}
