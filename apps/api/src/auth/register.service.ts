import { ConflictException, Injectable } from '@nestjs/common';
import type { paths } from '@workspace-chat/shared';
import type { ErrorResponse } from '../error-response';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma.service';
import { canonicalRecoveryCode, generateRecoveryCode } from './recovery-code';
import { hashSecret } from './secret-hash';

type RegisterOperation = paths['/auth/register']['post'];
export type RegisterRequest = RegisterOperation['requestBody']['content']['application/json'];
export type RegisterResponse = RegisterOperation['responses'][201]['content']['application/json'];

@Injectable()
export class RegisterService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 利用者を作り、リカバリーコードを1つ発行する。
   *
   * - パスワードの NFC への正規化は hashSecret が行う（照合の verifySecret も同じ正規化を通る。secret-hash.ts）
   * - **利用者とコードは1つの書き込み（ネストした create）で作る。** Prisma はこれを1トランザクションで行う。
   *   分けると、コードの無い利用者が残りうる——コードは唯一の復旧手段である（機能一覧 1.1）
   * - **ユーザーID の重複の判定は DB に任せる**（`User_userId_lower_key`。大文字小文字を区別しない）。
   *   先に SELECT で確かめる形にすると、同時の登録で両方が通る
   */
  async register(input: RegisterRequest): Promise<RegisterResponse> {
    const passwordHash = await hashSecret(input.password);
    const recoveryCode = generateRecoveryCode();
    const codeHash = await hashSecret(canonicalRecoveryCode(recoveryCode));

    try {
      const user = await this.prisma.user.create({
        data: {
          loginId: input.userId,
          displayName: input.displayName,
          passwordHash,
          recoveryCodes: { create: { codeHash } },
        },
        select: { id: true, loginId: true, displayName: true },
      });
      return {
        user: { id: user.id, userId: user.loginId, displayName: user.displayName },
        recoveryCode,
      };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException({
          code: 'user_id_taken',
          message: 'このユーザーID は使えません',
        } satisfies ErrorResponse);
      }
      throw error;
    }
  }
}
