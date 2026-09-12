import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import type { paths } from '@workspace-chat/shared';
import { type ErrorResponse, RetryAfterException } from '../error-response';
import { PrismaService } from '../prisma.service';
import { accountBackoffKey, type LoginBackoffStore } from './login-backoff';
import { LOGIN_BACKOFF_STORE } from './login.service';
import { canonicalRecoveryCode, generateRecoveryCode } from './recovery-code';
import { dummySecretHash, hashSecret, verifySecret } from './secret-hash';

type RecoveryOperation = paths['/auth/recovery']['post'];
export type RecoveryRequest = RecoveryOperation['requestBody']['content']['application/json'];
export type RecoveryResponse = RecoveryOperation['responses'][200]['content']['application/json'];

const INVALID_CREDENTIALS: ErrorResponse = {
  code: 'invalid_credentials',
  message: 'ユーザーID またはリカバリーコードが違います',
};

type UserCodeRow = { id: string; codeId: string | null; codeHash: string | null };

@Injectable()
export class RecoveryService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(LOGIN_BACKOFF_STORE) private readonly backoff: LoginBackoffStore,
  ) {}

  /**
   * リカバリーコードでパスワードを再設定する（F-37。機能一覧 1.1）。
   *
   * - **アカウント単位の制限はログインとは別のキーで数える**（`accountBackoffKey('recovery', …)`）。**成功したら両方を数え直す**（#280）
   * - 利用者は `lower("userId")` と `"deletedAt" IS NULL` で引き、未使用のコードは1つ（`RecoveryCode_single_unused_per_user`）
   * - **利用者やコードが見つからなくても照合を1回行う**（応答時間で登録済みの ID を見分けさせない）
   * - **コードの無効化・パスワードの入れ替え・新しいコードの発行・リフレッシュトークンの失効を1つのトランザクションで行う。**
   *   無効化は「まだ使われていない行」だけに当て、0 件（同時の再設定・退会の処理と重なった）なら何も変えずに 401
   */
  async recover(input: RecoveryRequest): Promise<RecoveryResponse> {
    const key = accountBackoffKey('recovery', input.userId);
    const started = await this.backoff.begin(key, Date.now());
    if (!started.allowed) {
      throw new RetryAfterException(Math.ceil(started.retryAfterMs / 1000));
    }

    const rows = await this.prisma.$queryRaw<UserCodeRow[]>`
      SELECT u."id", rc."id" AS "codeId", rc."codeHash"
      FROM "User" u
      LEFT JOIN "RecoveryCode" rc ON rc."userId" = u."id" AND rc."usedAt" IS NULL
      WHERE lower(u."userId") = lower(${input.userId}) AND u."deletedAt" IS NULL
    `;
    const row = rows[0];
    const matched = await verifySecret(
      row?.codeHash ?? (await dummySecretHash()),
      canonicalRecoveryCode(input.recoveryCode),
    );
    if (!row || row.codeId === null || !matched) {
      await this.backoff.recordFailure(key, Date.now());
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }
    // 成功は本人の正規の切り替えであり、それ以前のログインの失敗は新しいパスワードへの総当たりの証拠にならない（#280）。
    await Promise.all([
      this.backoff.reset(key),
      this.backoff.reset(accountBackoffKey('login', input.userId)),
    ]);

    const { id: userId, codeId } = row;
    const recoveryCode = generateRecoveryCode();
    const [passwordHash, codeHash] = await Promise.all([
      hashSecret(input.newPassword),
      hashSecret(canonicalRecoveryCode(recoveryCode)),
    ]);
    const now = new Date();
    const recovered = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.recoveryCode.updateMany({
        where: { id: codeId, usedAt: null },
        data: { usedAt: now },
      });
      if (count !== 1) return false;
      await tx.user.update({ where: { id: userId }, data: { passwordHash } });
      await tx.recoveryCode.create({ data: { userId, codeHash } });
      await tx.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: now },
      });
      return true;
    });
    if (!recovered) throw new UnauthorizedException(INVALID_CREDENTIALS);
    return { recoveryCode };
  }
}
