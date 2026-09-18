import { Injectable, NotFoundException } from '@nestjs/common';
import type { paths } from '@workspace-chat/shared';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma.service';
import { toUserSummary, type UserSummaryRow, userSummaryColumns } from '../users/user-summary';
import { assertChannelParticipant, channelFor } from './channel-access';
import { parseSearchQuery } from './search-query';
import { WorkspacesService } from './workspaces.service';

export type SearchResult =
  paths['/workspaces/{id}/search']['get']['responses'][200]['content']['application/json'];

/**
 * 種別ごとの件数の上限（機能一覧 12.1。実装時に決めた値）。
 * **踏むと壊れる: 変えるなら `packages/shared/openapi/openapi.yaml` の `SearchResult` の `maxItems` と `search` の description も同じ値にする**
 * ——応答は仕様で検証しない（openapi-validation.ts の `validateResponses: false`）ため、片方だけ変えても何も落ちない。
 */
const SECTION_LIMIT = 20;

/**
 * 語をすべて含む条件（語が無ければ真）。**語は `likequery` に値として渡す**——`%`・`_`・`\` をエスケープし、前後に `%` を付ける（pg_bigm の関数）。
 * 語を文字列に埋め込まない（REVIEW.md 3 / CWE-89）。`match` は、このファイルで書いた列の断片とパターンから条件を組み立てる。
 */
function containsAll(terms: string[], match: (pattern: Prisma.Sql) => Prisma.Sql): Prisma.Sql {
  if (terms.length === 0) return Prisma.sql`TRUE`;
  return Prisma.join(
    terms.map((term) => match(Prisma.sql`likequery(${term})`)),
    ' AND ',
  );
}

type MessageRow = {
  id: string;
  parentId: string | null;
  body: string;
  createdAt: Date;
  editedAt: Date | null;
  channelId: string;
  channelName: string;
  channelVisibility: 'PUBLIC' | 'PRIVATE';
  channelArchived: boolean;
  authorId: string;
  authorLoginId: string;
  authorDisplayName: string;
  authorAvatarUrl: string | null;
  authorDeleted: boolean;
};

type ChannelRow = {
  id: string;
  name: string;
  visibility: 'PUBLIC' | 'PRIVATE';
  archived: boolean;
  joined: boolean;
};

/**
 * 検索（F-30）と検索の認可（F-31。機能一覧 12.1）。1回の要求で、メッセージ・チャンネル・ユーザーのセクションを並行して引く。
 *
 * - **要求する側の所属（退会していない）を最初に確かめ、無ければ存在の有無を区別せず 404**（`WorkspacesService.membershipOf`）
 * - **メッセージは、要求する側が `ChannelMember` を持つチャンネルのものだけ**（プライベートの可視性の根拠。CLAUDE.md 2）。
 *   パブリックでも参加していなければ返さない。**オーナーの例外は及ばない**。削除済みは返さない。アーカイブ済みのチャンネルのものは参加者に返す（3.2）
 * - `in:#チャンネル名` は参加の2段階（無い・参加していないプライベートは 404、参加していないパブリックは 403 `not_a_channel_member`）。
 *   `from:@ユーザーID` は大文字小文字によらず投稿者で絞り、**退会した投稿者も指せる**（1.5 が過去のメッセージを残すため）。演算子はメッセージだけを絞る
 * - チャンネルは一般の一覧とアーカイブ済みの一覧で見えるもの（パブリックでアーカイブされていないもの・参加しているもの）。ユーザーは参加者一覧と同じ（メンバーで退会していない）
 * - **本文の照合は大文字小文字を区別する**（pg_bigm の索引が効くのは `LIKE` だけ）。チャンネル名とユーザーは件数が小さいため `lower()` で区別しない
 * - **DM（F-19）とファイル（F-27）のセクションは、それぞれの実装で足す**（ここに問い合わせを1つ足し、`SearchResult` に配列を足す）
 */
@Injectable()
export class SearchService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly workspaces: WorkspacesService,
  ) {}

  async search(userId: string, workspaceId: string, q: string): Promise<SearchResult> {
    await this.workspaces.membershipOf(userId, workspaceId);
    const query = parseSearchQuery(q);
    const channelId =
      query.in === null ? null : await this.channelOf(userId, workspaceId, query.in);
    const [messages, channels, users] = await Promise.all([
      this.messages(userId, workspaceId, query.terms, query.from, channelId),
      this.channels(userId, workspaceId, query.terms),
      this.users(workspaceId, query.terms),
    ]);
    return { messages, channels, users };
  }

  /** `in:#` のチャンネル。**参加の2段階を当てる**（無いチャンネルは、参加していないプライベートと同じ 404）。 */
  private async channelOf(userId: string, workspaceId: string, name: string): Promise<string> {
    const channel = await this.prisma.channel.findFirst({
      where: { workspaceId, name },
      select: { id: true },
    });
    if (!channel) throw new NotFoundException();
    assertChannelParticipant(await channelFor(this.prisma, userId, workspaceId, channel.id));
    return channel.id;
  }

  private async messages(
    userId: string,
    workspaceId: string,
    terms: string[],
    from: string | null,
    channelId: string | null,
  ): Promise<SearchResult['messages']> {
    const rows = await this.prisma.$queryRaw<MessageRow[]>`
      SELECT m."id", m."parentId", m."body", m."createdAt", m."editedAt",
        c."id" AS "channelId", c."name" AS "channelName", c."visibility"::text AS "channelVisibility",
        c."archivedAt" IS NOT NULL AS "channelArchived",
        a."id" AS "authorId", a."userId" AS "authorLoginId", a."displayName" AS "authorDisplayName",
        a."avatarUrl" AS "authorAvatarUrl", a."deletedAt" IS NOT NULL AS "authorDeleted"
      FROM "Message" m
      -- **検索の認可（F-31）: 要求する側が参加しているチャンネルだけ。** 役割も種別も見ない（オーナーの例外は及ばない）
      JOIN "ChannelMember" cm ON cm."channelId" = m."channelId" AND cm."userId" = ${userId}::uuid
      JOIN "User" viewer ON viewer."id" = cm."userId" AND viewer."deletedAt" IS NULL
      JOIN "Channel" c ON c."id" = m."channelId"
      -- 投稿者は退会していても引く（author は null として返す。機能一覧 1.5）
      JOIN "User" a ON a."id" = m."authorId"
      WHERE m."workspaceId" = ${workspaceId}::uuid
        AND m."deletedAt" IS NULL
        AND ${containsAll(terms, (pattern) => Prisma.sql`m."body" LIKE ${pattern}`)}
        AND ${from === null ? Prisma.sql`TRUE` : Prisma.sql`lower(a."userId") = lower(${from})`}
        AND ${channelId === null ? Prisma.sql`TRUE` : Prisma.sql`m."channelId" = ${channelId}::uuid`}
      ORDER BY m."id" DESC
      LIMIT ${SECTION_LIMIT}
    `;
    return rows.map((row) => ({
      id: row.id,
      channel: {
        id: row.channelId,
        name: row.channelName,
        visibility: row.channelVisibility,
        archived: row.channelArchived,
        joined: true,
      },
      parentId: row.parentId,
      author: row.authorDeleted
        ? null
        : toUserSummary({
            id: row.authorId,
            loginId: row.authorLoginId,
            displayName: row.authorDisplayName,
            avatarUrl: row.authorAvatarUrl,
            deletedAt: null,
          }),
      body: row.body,
      createdAt: row.createdAt.toISOString(),
      editedAt: row.editedAt?.toISOString() ?? null,
    }));
  }

  /** 名前に語をすべて含むチャンネル。**見えるのは、パブリックでアーカイブされていないものと、参加しているもの（アーカイブ済みを含む）だけ。** */
  private async channels(
    userId: string,
    workspaceId: string,
    terms: string[],
  ): Promise<ChannelRow[]> {
    if (terms.length === 0) return [];
    return this.prisma.$queryRaw<ChannelRow[]>`
      SELECT c."id", c."name", c."visibility"::text AS "visibility",
        c."archivedAt" IS NOT NULL AS "archived", cm."id" IS NOT NULL AS "joined"
      FROM "Channel" c
      LEFT JOIN "ChannelMember" cm ON cm."channelId" = c."id" AND cm."userId" = ${userId}::uuid
      WHERE c."workspaceId" = ${workspaceId}::uuid
        AND (cm."id" IS NOT NULL OR (c."visibility" = 'PUBLIC' AND c."archivedAt" IS NULL))
        AND ${containsAll(terms, (pattern) => Prisma.sql`lower(c."name") LIKE lower(${pattern})`)}
      ORDER BY c."name"
      LIMIT ${SECTION_LIMIT}
    `;
  }

  /**
   * ユーザーID か表示名に語を含む、そのワークスペースのメンバーで退会していない利用者（参加者一覧と同じ範囲。機能一覧 2.1）。
   * **踏むと壊れる: 生の SQL は schema.prisma の列名の写し（`@map`）を通らない**——`User.loginId` の列は `"userId"` である。
   */
  private async users(workspaceId: string, terms: string[]): Promise<SearchResult['users']> {
    if (terms.length === 0) return [];
    const rows = await this.prisma.$queryRaw<UserSummaryRow[]>`
      SELECT ${userSummaryColumns('u')}
      FROM "Membership" mb
      JOIN "User" u ON u."id" = mb."userId" AND u."deletedAt" IS NULL
      WHERE mb."workspaceId" = ${workspaceId}::uuid
        AND ${containsAll(
          terms,
          (pattern) =>
            Prisma.sql`(lower(u."userId") LIKE lower(${pattern}) OR lower(u."displayName") LIKE lower(${pattern}))`,
        )}
      ORDER BY lower(u."userId")
      LIMIT ${SECTION_LIMIT}
    `;
    return rows.map(toUserSummary);
  }
}
