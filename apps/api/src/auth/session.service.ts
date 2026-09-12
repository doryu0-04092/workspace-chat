import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { BearerErrorResponse } from '../error-response';
import { PrismaService } from '../prisma.service';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  REFRESH_TOKEN_RETENTION_MS,
  REFRESH_TOKEN_ROTATION_INTERVAL_MS,
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

/** リフレッシュの結果。**リフレッシュトークンは入れ替えたときだけ載る**（1日以内は入れ替えない。#303）。 */
export type RefreshedTokens = Omit<IssuedTokens, 'refreshToken'> & {
  readonly refreshToken: string | undefined;
};

/**
 * トークン（リフレッシュトークン・アクセストークン）が使えないときの本体。**無い・知らない・失効済み・期限切れ・退会済みを区別しない。**
 * 退会済みを応答から区別させないため、401（invalid_token）はすべてこれを返す（機能一覧 1.2・1.4）。
 * **Cookie の経路（リフレッシュ。ログアウトはこの本体を使わない）と Bearer の経路（AccessTokenGuard と、入口の後で退会したばかりの利用者を引けなかったサービス）の両方で使う。** Bearer の経路では
 * BearerUnauthorizedException に包んで投げ、WWW-Authenticate は例外フィルタが付ける。Cookie の経路には付けない（Bearer で守る資源ではない）。
 */
export const INVALID_TOKEN: BearerErrorResponse = {
  code: 'invalid_token',
  message: 'ログインし直してください',
};

/**
 * ログインの系列（リフレッシュトークンの入れ替えの連なり）を扱う（機能一覧 1.2）。
 *
 * - **start**: ログインで新しい系列を作る
 * - **rotate**: リフレッシュでアクセストークンを出す。**発行から1日を過ぎたトークンなら**、使ったトークンを失効させて同じ系列の新しいトークンを出す
 *   （1日に1回。#303）。**失効済みのトークンが
 *   出されたら、盗まれたものとみなして系列ごと失効させる**（RFC 9700 4.14.2）
 * - **end**: ログアウトで系列ごと失効させる
 *
 * **失効済みのトークンが出されたら、不正アクセスの疑いとして記録する**（`refresh_token_reuse`。系列と利用者の ID だけを載せ、
 * トークンは載せない。決定・2026-09-12・依頼側。#270）。アラートは要件定義書 4.2（ログを数える）。
 */
@Injectable()
export class SessionService {
  private readonly logger = new Logger('Session');

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  /** ログインで新しい系列を作る。**あわせて、この利用者の使い終わった行を消す**（removeUsedRows）。 */
  async start(userId: string): Promise<IssuedTokens> {
    await this.removeUsedRows(userId);
    const refreshToken = generateRefreshToken();
    // familyId は schema.prisma の既定値（UUIDv7）で新しく作る。
    await this.prisma.refreshToken.create({
      data: { userId, tokenHash: hashRefreshToken(refreshToken), expiresAt: refreshExpiry() },
    });
    return this.issue(userId, refreshToken);
  }

  /**
   * **使ったトークンの失効と新しいトークンの作成を1つのトランザクションで行い、失効は「まだ失効していない行」だけに当てる。**
   * 入れ替えの時点で同じトークンが同時に出されたとき、後の側は失効させる行が 0 件になり、再利用として扱う（入れ替えに成功するのは1つだけ）。
   */
  async rotate(refreshToken: string | undefined): Promise<RefreshedTokens> {
    if (refreshToken === undefined || refreshToken === '') throw invalidToken();
    const row = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: hashRefreshToken(refreshToken) },
      include: { user: { select: { deletedAt: true } } },
    });
    if (!row) throw invalidToken();

    const now = new Date();
    // 失効済み（入れ替え済み・ログアウト済み）のトークンは、期限や退会より先に見て系列ごと失効させる——期限は入れ替えのたびに
    // 延びるため、系列が生きたまま古いトークンだけが期限切れになる。同時の入れ替えの後の側は、下のトランザクションで見分ける。
    if (row.revokedAt !== null) {
      this.reportReuse(row.userId, row.familyId);
      await this.revokeFamily(row.familyId, now);
      throw invalidToken();
    }
    if (row.expiresAt <= now || row.user.deletedAt !== null) throw invalidToken();

    // 入れ替えは1日に1回（#303）。1日以内は書き込まず、アクセストークンだけを返す——この間の再送や同時の要求は競合しない。
    if (now.getTime() - row.createdAt.getTime() < REFRESH_TOKEN_ROTATION_INTERVAL_MS) {
      return { ...(await this.signAccessToken(row.userId)), refreshToken: undefined };
    }

    // 後始末は入れ替えの前に行う（start と同じ）。後に置くと、後始末が落ちたとき入れ替えだけが確定し、新しいトークンが利用者に渡らない。
    // 使い続ける利用者はログインし直さないため、入れ替えのときにも後始末をする（1端末あたり約 30 行に収める。#303）。
    // 対象は期限切れ・失効から 30 日を過ぎた行であり、いま入れ替える行（未失効・期限内）は含まない。
    await this.removeUsedRows(row.userId);

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
      this.reportReuse(row.userId, row.familyId);
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

  /** 失効済みのトークンの再利用。盗まれたトークンか、正規の利用者の再送か（1.2 の代償）はここでは分からない。 */
  private reportReuse(userId: string, familyId: string): void {
    this.logger.warn({ event: 'refresh_token_reuse', userId, familyId });
  }

  private async revokeFamily(familyId: string, now: Date): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: now },
    });
  }

  /**
   * この利用者の使い終わった行（期限切れ・失効のうち早く起きた方から 30 日を過ぎた行）を消す。ログインと入れ替えのときに呼ぶ
   * （#270・#303。定期の処理は持たない）。
   */
  private async removeUsedRows(userId: string): Promise<void> {
    const cutoff = new Date(Date.now() - REFRESH_TOKEN_RETENTION_MS);
    await this.prisma.refreshToken.deleteMany({
      where: { userId, OR: [{ expiresAt: { lt: cutoff } }, { revokedAt: { lt: cutoff } }] },
    });
  }

  private async signAccessToken(userId: string): Promise<Omit<IssuedTokens, 'refreshToken'>> {
    const accessToken = await this.jwt.signAsync({ sub: userId });
    return { accessToken, expiresIn: ACCESS_TOKEN_TTL_SECONDS };
  }

  private async issue(userId: string, refreshToken: string): Promise<IssuedTokens> {
    return { ...(await this.signAccessToken(userId)), refreshToken };
  }
}

function refreshExpiry(): Date {
  return new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000);
}

function invalidToken(): UnauthorizedException {
  return new UnauthorizedException(INVALID_TOKEN);
}
