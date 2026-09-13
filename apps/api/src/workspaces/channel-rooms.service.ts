import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { assertChannelParticipant } from './channel-access';
import { WorkspacesService } from './workspaces.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 入室要求・退室要求の本体からチャンネルの ID を取り出す。UUID の文字列でなければ 400（本体は REST の検証の失敗と同じ）。 */
export function channelIdOf(body: unknown): string {
  const channelId = (body as { channelId?: unknown } | null | undefined)?.channelId;
  if (typeof channelId !== 'string' || !UUID.test(channelId)) throw new BadRequestException();
  return channelId;
}

/**
 * チャンネルの部屋に入れてよいか（機能一覧 9.2。**入室が認可の関門である**——CLAUDE.md 2）。
 *
 * - **コードは参加者一覧と同じ2段階**: 所属していなければ種別によらず 404（`WorkspacesService.membershipOf`。退会していない）。
 *   所属していて参加していなければ、パブリックは 403 `not_a_channel_member`・プライベートは 404。無いチャンネルも 404
 * - **オーナーの例外は及ばない**（例外は一覧・取得 API だけ。9.2「参加していないオーナーには届かない」）
 * - アーカイブ済みでも参加者は入れる（参加者は読める。3.2）
 */
@Injectable()
export class ChannelRoomsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly workspaces: WorkspacesService,
  ) {}

  async assertCanEnter(userId: string, channelId: string): Promise<void> {
    const channel = await this.prisma.channel.findFirst({
      where: { id: channelId },
      select: {
        workspaceId: true,
        visibility: true,
        members: { where: { userId }, select: { id: true } },
      },
    });
    if (!channel) throw new NotFoundException();
    await this.workspaces.membershipOf(userId, channel.workspaceId);
    assertChannelParticipant({
      visibility: channel.visibility,
      joined: channel.members.length > 0,
    });
  }
}
