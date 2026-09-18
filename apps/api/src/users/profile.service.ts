import { BadRequestException, Injectable } from '@nestjs/common';
import type { paths } from '@workspace-chat/shared';
import {
  BearerUnauthorizedException,
  type ErrorResponse,
  errorBodyForStatus,
} from '../error-response';
import { INVALID_TOKEN } from '../auth/session.service';
import { isSingleEmoji } from '../emoji';
import { PrismaService } from '../prisma.service';

type GetOperation = paths['/users/me']['get'];
type PatchOperation = paths['/users/me']['patch'];
export type Profile = GetOperation['responses'][200]['content']['application/json'];
export type UpdateProfileRequest = PatchOperation['requestBody']['content']['application/json'];

const PROFILE_SELECT = {
  id: true,
  loginId: true,
  displayName: true,
  avatarUrl: true,
  statusEmoji: true,
  statusText: true,
} as const;

@Injectable()
export class ProfileService {
  constructor(private readonly prisma: PrismaService) {}

  /** 自分のプロフィール。**退会済みは引かない**（入口の判定とは別に、問い合わせ側にも条件を置く。機能一覧 1.4 の1段目）。 */
  async get(userId: string): Promise<Profile> {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: PROFILE_SELECT,
    });
    if (!user) throw new BearerUnauthorizedException(INVALID_TOKEN);
    return toProfile(user);
  }

  /**
   * 送った項目だけを変える。ユーザーID は変えない（本体の形は仕様が縛り、`userId` を含む本体は検証で 400 になる）。
   * **書き込みも `deletedAt IS NULL` の行だけに当てる**——入口の確認と書き込みの間に退会した場合に、退会済みの行を書き換えない
   * （そのときは続く get が 401 を返す）。
   */
  async update(userId: string, input: UpdateProfileRequest): Promise<Profile> {
    if (input.status != null && !isSingleEmoji(input.status.emoji)) {
      throw new BadRequestException({
        ...errorBodyForStatus(400),
        errors: [{ path: '/body/status/emoji', message: '絵文字1つにしてください' }],
      } satisfies ErrorResponse);
    }
    // ステータスは絵文字とテキストの1セット（機能一覧 1.3。#283）。null なら両方消し、送らなければ両方触らない。
    const status =
      input.status === undefined
        ? {}
        : { statusEmoji: input.status?.emoji ?? null, statusText: input.status?.text ?? null };
    await this.prisma.user.updateMany({
      where: { id: userId, deletedAt: null },
      data: { displayName: input.displayName, ...status },
    });
    return this.get(userId);
  }
}

function toProfile(user: {
  id: string;
  loginId: string;
  displayName: string;
  avatarUrl: string | null;
  statusEmoji: string | null;
  statusText: string | null;
}): Profile {
  return {
    id: user.id,
    userId: user.loginId,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    // 列は2つだが、値は1セット（機能一覧 1.3）。両方入っているときだけステータスがある。
    status:
      user.statusEmoji !== null && user.statusText !== null
        ? { emoji: user.statusEmoji, text: user.statusText }
        : null,
  };
}
