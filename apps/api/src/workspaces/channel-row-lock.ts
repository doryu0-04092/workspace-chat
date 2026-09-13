import { Prisma } from '../generated/prisma/client';
import type { PrismaService } from '../prisma.service';

/** 行を掴む強さ。**利用者の入力から作らない**——SQL の句をそのまま埋め込むため、閉じた対応表からだけ引く。 */
const LOCK_CLAUSES = {
  share: Prisma.raw('FOR SHARE'),
  update: Prisma.raw('FOR UPDATE'),
} as const;

/**
 * チャンネルの行を、トランザクションの終わりまで掴む（`(id, workspaceId)` で引く。無ければ何も掴まない）。
 *
 * **読んだ値で書く値を決める前に、チャンネルの行を掴んでから読む**——掴まずに読むと、読みと書き込みのあいだに
 * 別の要求の更新が確定し、古い読みに基づいて書く。READ COMMITTED では、ロックを待った後の次の文は確定後の行を見る。
 *
 * - `share`（参加・招待）: アーカイブ・復元と同時に来ても、その確定を待ってから読み、アーカイブの後に人を増やさない（機能一覧 3.2）。
 *   アーカイブは先に `update` で掴むため `FOR KEY SHARE` とも衝突するが、復元は行を掴まずに `archivedAt` だけを書き
 *   （名前を変えない更新は `FOR NO KEY UPDATE` しか取らない）、`FOR KEY SHARE` とは衝突しない。`FOR KEY SHARE` に下げると、
 *   復元と同時に来た参加・招待は確定前の値（アーカイブ済み）を読んで 409 を返す。`FOR SHARE` なら復元の確定を待ってから読む
 * - `update`（アーカイブ）: 読みと更新のあいだに採番と復元が確定して、番号を持つ行を採番し直すことを防ぐ（検査制約はこれを止めない）。
 *   `FOR SHARE` では、同時の2つのアーカイブが両方とも掴んだまま更新に進み、互いを待って行き詰まる
 */
export async function lockChannelRow(
  tx: Pick<PrismaService, '$queryRaw'>,
  workspaceId: string,
  channelId: string,
  strength: keyof typeof LOCK_CLAUSES,
): Promise<void> {
  await tx.$queryRaw`
    SELECT 1 FROM "Channel"
    WHERE "id" = ${channelId}::uuid AND "workspaceId" = ${workspaceId}::uuid
    ${LOCK_CLAUSES[strength]}
  `;
}
