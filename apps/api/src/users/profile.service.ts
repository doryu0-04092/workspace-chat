import { BadRequestException, Injectable } from '@nestjs/common';
import type { paths } from '@workspace-chat/shared';
import {
  BearerUnauthorizedException,
  type ErrorResponse,
  errorBodyForStatus,
} from '../error-response';
import { INVALID_TOKEN } from '../auth/session.service';
import { PrismaService } from '../prisma.service';

type GetOperation = paths['/users/me']['get'];
type PatchOperation = paths['/users/me']['patch'];
export type Profile = GetOperation['responses'][200]['content']['application/json'];
export type UpdateProfileRequest = PatchOperation['requestBody']['content']['application/json'];

/**
 * 絵文字1つ（Unicode の RGI_Emoji に当たる列1つ。肌の色・ZWJ で繋いだ列・国旗も1つ）。
 * JSON Schema の pattern（Unicode の `u` フラグ）では文字列の性質を書けないため、仕様ではなくここで確かめる。
 * 文字列の性質には `v` フラグが要る。tsconfig.base.json の target（ES2022）ではリテラルに書けないため、コンストラクタで作る（実行する Node 24 は扱える）。
 */
const SINGLE_EMOJI = new RegExp('^\\p{RGI_Emoji}$', 'v');

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
    if (input.status != null && !SINGLE_EMOJI.test(input.status.emoji)) {
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
