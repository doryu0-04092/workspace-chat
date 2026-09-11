import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import type { paths } from '@workspace-chat/shared';
import { type ErrorResponse, RetryAfterException } from '../error-response';
import { PrismaService } from '../prisma.service';
import { accountBackoffKey, type LoginBackoffStore } from './login-backoff';
import { dummySecretHash, verifySecret } from './secret-hash';
import { SessionService } from './session.service';

type LoginOperation = paths['/auth/login']['post'];
export type LoginRequest = LoginOperation['requestBody']['content']['application/json'];
export type LoginResponse = LoginOperation['responses'][200]['content']['application/json'];

/** アカウント単位の制限の保存先を注入するトークン。 */
export const LOGIN_BACKOFF_STORE = Symbol('LOGIN_BACKOFF_STORE');

const INVALID_CREDENTIALS: ErrorResponse = {
  code: 'invalid_credentials',
  message: 'ユーザーID またはパスワードが違います',
};

type UserRow = { id: string; userId: string; displayName: string; passwordHash: string };

@Injectable()
export class LoginService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionService,
    @Inject(LOGIN_BACKOFF_STORE) private readonly backoff: LoginBackoffStore,
  ) {}

  /**
   * ユーザーID とパスワードで認証し、アクセストークンとリフレッシュトークンを発行する（機能一覧 1.2）。
   *
   * - **待ち時間の間は照合しない**（login-backoff.ts）。照合（Argon2id）より前に止める
   * - **利用者は `lower("userId")` と `"deletedAt" IS NULL` で引く**（schema.prisma の loginId の説明。Prisma のクライアントでは書けない）
   * - **利用者が見つからなくても照合を1回行う**——行わないと、応答までの時間で登録済みの ID を見分けられる
   * - 失敗の理由（ID が無い・パスワードが違う・退会済み）は応答で区別しない
   */
  async login(input: LoginRequest): Promise<{ body: LoginResponse; refreshToken: string }> {
    const key = accountBackoffKey('login', input.userId);
    const started = await this.backoff.begin(key, Date.now());
    if (!started.allowed) {
      throw new RetryAfterException(Math.ceil(started.retryAfterMs / 1000));
    }

    const rows = await this.prisma.$queryRaw<UserRow[]>`
      SELECT "id", "userId", "displayName", "passwordHash"
      FROM "User"
      WHERE lower("userId") = lower(${input.userId}) AND "deletedAt" IS NULL
    `;
    const user = rows[0];
    const matched = await verifySecret(
      user?.passwordHash ?? (await dummySecretHash()),
      input.password,
    );
    if (!user || !matched) {
      await this.backoff.recordFailure(key, Date.now());
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }
    await this.backoff.reset(key);

    const tokens = await this.sessions.start(user.id);
    return {
      body: {
        accessToken: tokens.accessToken,
        tokenType: 'Bearer',
        expiresIn: tokens.expiresIn,
        user: { id: user.id, userId: user.userId, displayName: user.displayName },
      },
      refreshToken: tokens.refreshToken,
    };
  }
}
