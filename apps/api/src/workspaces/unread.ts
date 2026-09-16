import type { UnreadUpdatedPayload } from '@workspace-chat/shared';
import { Prisma } from '../generated/prisma/client';
import { isUniqueViolation } from '../prisma-errors';
import type { PrismaService } from '../prisma.service';
import type { RealtimeEmitter } from '../realtime/realtime.emitter';

/**
 * **その人の未読しか変わらないとき**に、その人の部屋へ1件だけ配る（F-23。機能一覧 5.2・10.1）。
 * 既読を進めた経路（チャンネル・スレッドの2つ）が使う。
 *
 * **参加者全員を数え直さない**——1要求が人数分の集計と配信に増幅する（#505 第0巡の 🔴3）。
 * **1箇所に置く**——payload の組み立てと宛先の決め方が2箇所に分かれると、片方だけが変わりうる（#505 第1巡の 🟡3）。
 * **資格の確認は呼ぶ側にある**（既読を進められたのは、参加の2段階を通った本人だけである。5.2）。
 */
export async function announceUnreadTo(
  emitter: RealtimeEmitter,
  prisma: PrismaService,
  channelId: string,
  userId: string,
): Promise<void> {
  const unread = await unreadOfChannels(prisma, userId, [channelId]);
  const payload: UnreadUpdatedPayload = {
    channelId,
    unread: unread.get(channelId)?.unread ?? 0,
    sentAt: new Date().toISOString(),
  };
  emitter.toUsers([userId], 'unread:updated', payload);
}

/**
 * そのチャンネルの既読位置（チャンネル・スレッドの両方）を消す（F-23。機能一覧 10.1）。
 * **チャンネルから抜けるとき（退出 F-10・キックの F-09）に、参加を消すのと同じトランザクションで呼ぶ。**
 *
 * **踏むと壊れる: 既読位置は `ChannelMember` と同じ寿命にする。** 参照先が `Membership` なので、
 * **ワークスペース単位のキック・退出では DB が連鎖して消すが、チャンネル単位では消えない**。
 * 残すと、再参加した利用者に**抜ける前の位置**が返り、「ここから未読」の線が参加前に引かれて
 * 未読数と食い違う（未読数の側は `m."createdAt" >= cm."joinedAt"` が守るため。#505 第2巡の 🔴1）。
 */
export async function forgetReadPositions(
  tx: Pick<PrismaService, 'channelRead' | 'threadRead'>,
  channelId: string,
  userId: string,
): Promise<void> {
  await tx.channelRead.deleteMany({ where: { channelId, userId } });
  await tx.threadRead.deleteMany({ where: { channelId, userId } });
}

/**
 * 既読位置を**進めるだけ**で書く（F-23。機能一覧 10.1）。チャンネルとスレッドで同じ形を使う。
 *
 * **主キーは Prisma に作らせる**——`schema.prisma` が `@default(uuid(7))` と宣言しており、
 * **要件定義書 3.5.2 が「主キーはすべて UUIDv7」と決めている**。生の SQL の `gen_random_uuid()` は UUIDv4 であり、
 * 宣言と実態が食い違ううえ、索引の局所性（UUIDv7 を選んだ理由）もその表だけ失われる。
 * PostgreSQL 17 には組み込みの `uuidv7()` が無いため、**DB 側の関数では作れない**（`schema.prisma` 冒頭の決め）。
 *
 * **踏むと壊れる: 読んでから書く形にしない。** 同時に2つ来ると、古い方が後に書いて位置が戻る。
 * ここでは (1) 「いまの位置がこれより古い行」だけを更新し、(2) 更新できなければ作る、という順にしている。
 * (2) で一意違反になるのは「その間に誰かが作った」ときで、**その行は自分と同じか新しい位置を持つ**ため、
 * 何もしないのが正しい（進めるだけの性質は保たれる）。
 */
export async function advanceReadPosition<
  Where extends object,
  Create extends { lastReadMessageId: string },
>(
  table: {
    updateMany: (args: {
      where: Where & { lastReadMessageId: { lt: string } };
      data: { lastReadMessageId: string };
    }) => Promise<{ count: number }>;
    create: (args: { data: Create }) => Promise<unknown>;
  },
  { where, create, lastReadMessageId }: { where: Where; create: Create; lastReadMessageId: string },
): Promise<void> {
  const { count } = await table.updateMany({
    where: { ...where, lastReadMessageId: { lt: lastReadMessageId } },
    data: { lastReadMessageId },
  });
  if (count > 0) return;
  try {
    await table.create({ data: create });
  } catch (error) {
    // 既に行がある（同じか新しい位置を持つ）。進めるだけなので何もしない。
    if (!isUniqueViolation(error)) throw error;
  }
}

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
  COUNT(m."id") FILTER (WHERE m."parentId" IS NULL OR u."threadUnreadIncluded")
`;

/**
 * 既読位置より後か（機能一覧 10.1）。**本体はチャンネルの既読位置（`cr`）、返信はスレッドの既読位置（`tr`）で決める。**
 *
 * **踏むと壊れる: 返信に `cr` を当てない。** チャンネルの一覧は本体だけを返すため、
 * **返信より新しい本体を読んだだけで、スレッドを一度も開いていない返信まで既読になる**。
 * そうなると 10.1 の受け入れ条件「設定を『含めない』→『含める』に切り替えると、過去のスレッド返信のうち
 * 未読のものが未読として現れる」も満たせない（#505 第1巡の 🔴1）。
 *
 * **代償**: `ThreadRead` を持たない利用者の返信は、**スレッドを開くまで未読のまま残る**（10.1 に代償として記録した）。
 * 返信の下限を「`tr` があればそれ、無ければ `cr`」にすれば未読は早く減るが、上の受け入れ条件を満たせなくなる。
 */
const AFTER_READ_POSITION = Prisma.sql`
  CASE WHEN m."parentId" IS NULL
    THEN m."id" > COALESCE(cr."lastReadMessageId", '00000000-0000-0000-0000-000000000000'::uuid)
    ELSE TRUE
  END
`;

/**
 * 未読を数える結合（利用者・既読位置・メッセージ・スレッドの既読位置）。上の `UNREAD_COUNT` と対で使う。
 *
 * **踏むと壊れる: メッセージを絞る条件は、この `ON` 側に置く。** `FILTER` 句へ移すと、
 * **プランナが結合まで押し下げられず**（集約の段でしか評価できない）、参加者数 × そのチャンネルの全メッセージを
 * 作ってから捨てる形になる。それは「既読位置からの差分で求め、都度の全走査をしない」（要件定義書 4.1）を、
 * 形だけ満たして実行では破ることになる（#505 第0巡の 🔴2）。
 * **`LEFT JOIN` のままなので「1参加者1行（未読が0件でも行が残る）」の意味は変わらない。**
 *
 * `tr`（スレッドの既読位置）に依存する条件だけは、この `ON` ではなく**問い合わせの `WHERE`**（`THREAD_READ_FILTER`）に置く
 * ——`tr` は `m` を引いた後にしか結合できないためである。**`FILTER` 句には置かない**（同じ理由で押し下げが効かない）。
 */
const UNREAD_JOINS = Prisma.sql`
  FROM "ChannelMember" cm
  JOIN "User" u ON u."id" = cm."userId"
  LEFT JOIN "ChannelRead" cr ON cr."channelId" = cm."channelId" AND cr."userId" = cm."userId"
  LEFT JOIN "Message" m
    ON m."channelId" = cm."channelId"
   AND ${AFTER_READ_POSITION}
   AND m."deletedAt" IS NULL
   AND m."authorId" <> cm."userId"
   AND m."createdAt" >= cm."joinedAt"
  LEFT JOIN "ThreadRead" tr
    ON tr."parentMessageId" = m."parentId" AND tr."userId" = cm."userId"
`;

/**
 * **返信を、スレッドの既読位置より後のものに絞る**（機能一覧 10.1）。`tr` は `m` を引いた後にしか結合できないため、
 * `UNREAD_JOINS` の `ON` ではなく、**それを使う問い合わせの `WHERE`** に置く。
 *
 * **踏むと壊れる: 返信も「既読位置より後」で切る。** 切らないと、
 * **参加者1人につき「参加した時点より後のそのチャンネルの全返信」の行を作り、集約で捨てる**ことになり、
 * 「都度の全走査をしない」（要件定義書 4.1）を返信の側で破る（#505 第2巡の 🔴2）。
 *
 * **本体はここでは絞らない**（`ON` 側の `AFTER_READ_POSITION` で既に切れている）。
 * **`m."id" IS NULL` を通すのは、未読が0件の参加者の行を `LEFT JOIN` のまま残すためである**——
 * これを落とすと「1参加者1行」が崩れ、未読0のチャンネルが一覧から消える。
 *
 * **`ThreadRead` を持たないスレッドは、参加以降の返信をすべて見る**——これは第1巡で採った形の代償であり
 * （スレッドを開くまで未読が減らない）、**ここで消せる性質ではない**。10.1 に代償として記録してある。
 */
const THREAD_READ_FILTER = Prisma.sql`
  (
    m."id" IS NULL
    OR m."parentId" IS NULL
    OR m."id" > COALESCE(tr."lastReadMessageId", '00000000-0000-0000-0000-000000000000'::uuid)
  )
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
      AND ${THREAD_READ_FILTER}
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
      AND ${THREAD_READ_FILTER}
    GROUP BY cm."userId"
  `;
  return new Map(rows.map(({ userId, unread }) => [userId, Number(unread)]));
}
