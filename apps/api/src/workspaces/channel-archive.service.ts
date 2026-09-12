import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma.service';
import { CHANNEL_ARCHIVED, CHANNEL_NOT_ARCHIVED } from './channel-errors';
import { MANAGED_CHANNEL_SELECT, type ManagedChannel, toManagedChannel } from './managed-channel';
import { OWNER_ONLY } from './workspace-errors';
import { WorkspacesService } from './workspaces.service';

/** 名前の衝突（同時に同じ名前が作られた）で採番をやり直す回数の上限。 */
const MAX_NUMBERING_ATTEMPTS = 5;

/**
 * チャンネルのアーカイブと復元（F-35。機能一覧 3.2）。**オーナーだけ**（メンバーは 403 `owner_only`、所属していなければ 404）。
 * オーナーの管理の範囲であり、参加していないプライベートチャンネルにも及ぶ（機能一覧 3.1「オーナーには、管理のためのチャンネル一覧を返す」）。
 *
 * - **アーカイブ・採番・改名は同じトランザクションで行う**（検査制約 `Channel_archive_naming_check` も片方だけを拒む）
 * - **番号は、その基底名で名前がまだ空いている最小の番号**（`MAX(archiveSequence) + 1` ではない。利用者が `general-1` を自分で付けられる）
 * - **既に番号を持つ行（復元したもの）を再びアーカイブするときは、採番も改名もしない**（採番し直すと自分自身が塞いでいて番号が進み続ける）
 * - **並行して同じ名前が作られたら、一意制約の違反を捕まえて採番をやり直す**
 * - 基底名は利用者が付けた名前で `'` を含められる。**問い合わせにはプレースホルダで渡す**（REVIEW.md 3 / CWE-89。参照実装 `nextArchiveSequence` の注記）
 */
@Injectable()
export class ChannelArchiveService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly workspaces: WorkspacesService,
  ) {}

  async archive(ownerId: string, workspaceId: string, channelId: string): Promise<ManagedChannel> {
    await this.requireOwner(ownerId, workspaceId);
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.prisma.$transaction(async (tx) => {
          const channel = await tx.channel.findFirst({
            where: { id: channelId, workspaceId },
            select: { baseName: true, archivedAt: true, archiveSequence: true },
          });
          if (!channel) throw new NotFoundException();
          if (channel.archivedAt !== null) throw new ConflictException(CHANNEL_ARCHIVED);

          const now = new Date();
          const data =
            channel.archiveSequence === null
              ? await nextNaming(tx, workspaceId, channel.baseName, now)
              : { archivedAt: now };
          // まだアーカイブされていない行だけを変える（同時のアーカイブの後の側は 0 件になる）。
          const { count } = await tx.channel.updateMany({
            where: { id: channelId, workspaceId, archivedAt: null },
            data,
          });
          if (count !== 1) throw new ConflictException(CHANNEL_ARCHIVED);
          return this.view(tx, channelId);
        });
      } catch (error) {
        const nameTaken =
          error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
        if (nameTaken && attempt < MAX_NUMBERING_ATTEMPTS) continue;
        throw error;
      }
    }
  }

  /** 復元。**名前と番号は外れない**（`general-1` のまま）。アーカイブしていなければ 409 `channel_not_archived`。 */
  async restore(ownerId: string, workspaceId: string, channelId: string): Promise<ManagedChannel> {
    await this.requireOwner(ownerId, workspaceId);
    const channel = await this.prisma.channel.findFirst({
      where: { id: channelId, workspaceId },
      select: { id: true },
    });
    if (!channel) throw new NotFoundException();
    const { count } = await this.prisma.channel.updateMany({
      where: { id: channelId, workspaceId, archivedAt: { not: null } },
      data: { archivedAt: null },
    });
    if (count !== 1) throw new ConflictException(CHANNEL_NOT_ARCHIVED);
    return this.view(this.prisma, channelId);
  }

  private async requireOwner(userId: string, workspaceId: string): Promise<void> {
    const membership = await this.workspaces.membershipOf(userId, workspaceId);
    if (membership.role !== 'OWNER') throw new ForbiddenException(OWNER_ONLY);
  }

  private async view(
    client: Pick<PrismaService, 'channel'>,
    channelId: string,
  ): Promise<ManagedChannel> {
    const row = await client.channel.findUniqueOrThrow({
      where: { id: channelId },
      select: MANAGED_CHANNEL_SELECT,
    });
    return toManagedChannel(row);
  }
}

/**
 * まだ番号を持たない行のアーカイブで書く値。番号は「その基底名で、名前がまだ空いている最小の番号」
 * （`apps/api/src/prisma-schema.test.ts` の `nextArchiveSequence` と同じ選び方。探索の上限はワークスペースのチャンネル数 + 1 で足りる——
 * N 件のチャンネルが塞げる名前は高々 N 個）。
 */
async function nextNaming(
  tx: Pick<PrismaService, '$queryRaw'>,
  workspaceId: string,
  baseName: string,
  now: Date,
): Promise<{ archivedAt: Date; archiveSequence: number; name: string }> {
  const [row] = await tx.$queryRaw<{ nextSequence: number }[]>`
    SELECT COALESCE(MIN(s.n), 1)::int AS "nextSequence"
    FROM generate_series(
      1,
      (SELECT count(*) + 1 FROM "Channel" WHERE "workspaceId" = ${workspaceId}::uuid)
    ) AS s(n)
    WHERE NOT EXISTS (
      SELECT 1 FROM "Channel" c
      WHERE c."workspaceId" = ${workspaceId}::uuid
        AND c."name" = ${baseName} || '-' || s.n
    )
  `;
  const sequence = row?.nextSequence ?? 1;
  return { archivedAt: now, archiveSequence: sequence, name: `${baseName}-${sequence}` };
}
