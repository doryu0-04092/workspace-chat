import { Injectable } from '@nestjs/common';
import type { components } from '@workspace-chat/shared';
import { PrismaService } from '../prisma.service';

export type UserSettings = components['schemas']['UserSettings'];
export type UpdateUserSettingsRequest = components['schemas']['UpdateUserSettingsRequest'];

/**
 * 利用者ごとの設定（F-23。機能一覧 10.1）。**プロフィールとは別に持つ**——プロフィールは他の利用者にも見える形で返すが、
 * 設定は本人にしか返さない。**この経路だけが `threadUnreadIncluded` を変える**（schema.prisma の注記と揃える）。
 *
 * **切り替えても既読位置は動かさない**（一括で既読扱いにしない。要件定義書 3.5.2）。
 */
@Injectable()
export class SettingsService {
  constructor(private readonly prisma: PrismaService) {}

  async get(userId: string): Promise<UserSettings> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { threadUnreadIncluded: true },
    });
    return { threadUnreadIncluded: user.threadUnreadIncluded };
  }

  async update(userId: string, body: UpdateUserSettingsRequest): Promise<UserSettings> {
    const user = await this.prisma.user.update({
      where: { id: userId },
      // 渡されなかった項目は変えない（部分更新。openapi の UpdateUserSettingsRequest はすべて任意）
      data: { threadUnreadIncluded: body.threadUnreadIncluded },
      select: { threadUnreadIncluded: true },
    });
    return { threadUnreadIncluded: user.threadUnreadIncluded };
  }
}
