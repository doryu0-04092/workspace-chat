import { Prisma } from '../generated/prisma/client';
import type { PrismaService } from '../prisma.service';

/**
 * 未読数の数え方（F-23。機能一覧 10.1）。**既読位置からの差分で数え、都度の全走査をしない**。
 * 数える単位は「利用者 × チャンネル」であり、**呼ぶ側の向きが2つある**——
 * 一覧は「1人ぶんを、参加しているチャンネル全部」（`unreadOfChannels`）、配信は「1チャンネルぶんを、参加者全員」（`unreadOfMembers`）。
 * **どちらも同じ `FILTER` 句を通す**（数え方が2箇所に分かれると、片方だけが仕様とずれる）。
 *
 * 不変条件は4つである。
 * - **自分の投稿は数えない**（`m."authorId" <> cm."userId"`）
 * - **削除済みは数えない**（`m."deletedAt" IS NULL`）
 * - **既読位置を持たない利用者は、参加した時点（`ChannelMember.joinedAt`）より後だけを数える**（参加する前の履歴を未読にしない）
 * - **スレッドの返信を数えるかは利用者の設定**（`User.threadUnreadIncluded`。既定は数える）。数えるときは `ThreadRead` の差分で、
 *   数えないときは本体（`parentId IS NULL`）だけで数える
 *
 * **踏むと壊れる: 位置の比較はメッセージの id で行う**（`>`）。id は UUIDv7 で作った順に増えるため、これが「その位置より後」と同じ意味になる。
 * 時刻の列で比べる形に変えると、同じミリ秒に入った投稿の前後が決まらない。
 *
 * **踏むと壊れる: 既読位置が無い場合の下限に、UUID の最小値を使っている。** `COALESCE` の既定値を変えるなら、
 * 「参加した時点より後だけを数える」条件（`m."createdAt" >= cm."joinedAt"`）と合わせて見直すこと——
 * どちらか一方だけを外すと、参加する前の履歴が未読になる。
 */
const UNREAD_COUNT = Prisma.sql`
  COUNT(m."id") FILTER (
    WHERE m."authorId" <> cm."userId"
      AND m."deletedAt" IS NULL
      AND m."id" > COALESCE(cr."lastReadMessageId", '00000000-0000-0000-0000-000000000000'::uuid)
      AND m."createdAt" >= cm."joinedAt"
      AND (
        m."parentId" IS NULL
        OR (u."threadUnreadIncluded"
            AND m."id" > COALESCE(tr."lastReadMessageId", '00000000-0000-0000-0000-000000000000'::uuid))
      )
  )
`;

/** 未読を数える結合（利用者・既読位置・メッセージ・スレッドの既読位置）。上の `UNREAD_COUNT` と対で使う。 */
const UNREAD_JOINS = Prisma.sql`
  FROM "ChannelMember" cm
  JOIN "User" u ON u."id" = cm."userId"
  LEFT JOIN "ChannelRead" cr ON cr."channelId" = cm."channelId" AND cr."userId" = cm."userId"
  LEFT JOIN "Message" m ON m."channelId" = cm."channelId"
  LEFT JOIN "ThreadRead" tr ON tr."parentMessageId" = m."parentId" AND tr."userId" = cm."userId"
`;

/** 一覧が1つのチャンネルについて出す値（機能一覧 10.1）。 */
export type ChannelUnread = { unread: number; lastReadMessageId: string | null };

/**
 * 1人ぶんの未読数と既読位置を、参加しているチャンネルごとに返す（一覧。`Channel.unread` と `Channel.lastReadMessageId`）。
 *
 * **既読位置も一緒に返す**——「ここから未読」の区切り線は、この位置の次のメッセージの上に出す（10.1）。
 * **未読数から位置を数えてはならない**: 自分の投稿と削除済みは未読に数えないが、一覧には並ぶため必ずずれる。
 * 位置は `ChannelRead` を結合済みなので、同じ問い合わせで返せる（`MIN` は、行が1つしか無い `cr` を集約の外へ出さないためだけに使う）。
 */
export async function unreadOfChannels(
  prisma: PrismaService,
  userId: string,
  channelIds: readonly string[],
): Promise<Map<string, ChannelUnread>> {
  if (channelIds.length === 0) return new Map();
  const ids = Prisma.join(channelIds.map((id) => Prisma.sql`${id}::uuid`));
  const rows = await prisma.$queryRaw<
    { channelId: string; unread: bigint; lastReadMessageId: string | null }[]
  >`
    SELECT cm."channelId" AS "channelId",
           ${UNREAD_COUNT} AS "unread",
           MIN(cr."lastReadMessageId"::text) AS "lastReadMessageId"
    ${UNREAD_JOINS}
    WHERE cm."userId" = ${userId}::uuid AND cm."channelId" IN (${ids})
    GROUP BY cm."channelId"
  `;
  return new Map(
    rows.map(({ channelId, unread, lastReadMessageId }) => [
      channelId,
      { unread: Number(unread), lastReadMessageId },
    ]),
  );
}

/**
 * 1チャンネルぶんの未読数を、そのチャンネルの参加者ごとに返す（配信。`unread:updated`）。
 * **返すのは参加者だけである**——`unread:updated` の宛先を、この結果からそのまま作ってよい（5.2 の資格の確認がここで済む）。
 */
export async function unreadOfMembers(
  prisma: PrismaService,
  channelId: string,
): Promise<Map<string, number>> {
  const rows = await prisma.$queryRaw<{ userId: string; unread: bigint }[]>`
    SELECT cm."userId" AS "userId", ${UNREAD_COUNT} AS "unread"
    ${UNREAD_JOINS}
    WHERE cm."channelId" = ${channelId}::uuid AND u."deletedAt" IS NULL
    GROUP BY cm."userId"
  `;
  return new Map(rows.map(({ userId, unread }) => [userId, Number(unread)]));
}
