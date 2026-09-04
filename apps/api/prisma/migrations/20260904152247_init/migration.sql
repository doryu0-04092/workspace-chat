-- CreateEnum
CREATE TYPE "WorkspaceRole" AS ENUM ('OWNER', 'MEMBER');

-- CreateEnum
CREATE TYPE "ChannelVisibility" AS ENUM ('PUBLIC', 'PRIVATE');

-- CreateTable
CREATE TABLE "User" (
    "id" UUID NOT NULL,
    "userId" VARCHAR(30) NOT NULL,
    "displayName" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "avatarUrl" TEXT,
    "statusEmoji" TEXT,
    "statusText" VARCHAR(100),
    "deletedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecoveryCode" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "codeHash" TEXT NOT NULL,
    "usedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecoveryCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Workspace" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Workspace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Membership" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "role" "WorkspaceRole" NOT NULL,
    "joinedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Membership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Channel" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "baseName" TEXT NOT NULL,
    "visibility" "ChannelVisibility" NOT NULL,
    "archivedAt" TIMESTAMPTZ(3),
    "archiveSequence" INTEGER,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Channel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChannelMember" (
    "id" UUID NOT NULL,
    "channelId" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "joinedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChannelMember_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_userId_key" ON "User"("userId");

-- CreateIndex
CREATE INDEX "RecoveryCode_userId_idx" ON "RecoveryCode"("userId");

-- CreateIndex
CREATE INDEX "Membership_userId_idx" ON "Membership"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Membership_workspaceId_userId_key" ON "Membership"("workspaceId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "Channel_workspaceId_name_key" ON "Channel"("workspaceId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Channel_id_workspaceId_key" ON "Channel"("id", "workspaceId");

-- CreateIndex
CREATE INDEX "ChannelMember_userId_idx" ON "ChannelMember"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "ChannelMember_channelId_userId_key" ON "ChannelMember"("channelId", "userId");

-- AddForeignKey
ALTER TABLE "RecoveryCode" ADD CONSTRAINT "RecoveryCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Channel" ADD CONSTRAINT "Channel_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChannelMember" ADD CONSTRAINT "ChannelMember_channelId_workspaceId_fkey" FOREIGN KEY ("channelId", "workspaceId") REFERENCES "Channel"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChannelMember" ADD CONSTRAINT "ChannelMember_workspaceId_userId_fkey" FOREIGN KEY ("workspaceId", "userId") REFERENCES "Membership"("workspaceId", "userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================================
-- ここから下は Prisma のスキーマ言語で表せない制約である。
--
-- 部分一意索引（WHERE 付き）と検査制約（CHECK）は Prisma のスキーマ言語に無い。
-- そのため **schema.prisma を読んでもこの3つは見えない。**
-- `prisma migrate dev` で次のマイグレーションを作るときも自動では復元されない。
--
-- 3つとも apps/api/src/prisma-schema.test.ts が実際の PostgreSQL に対して
-- 検証している。名前を変えるならテストも併せて直すこと。
-- ============================================================================

-- 1つのワークスペースにオーナーは1人だけ（要件定義書 3.5.1）。
--
-- オーナーを Workspace 側の列として持たず、Membership の役割だけを根拠にするため、
-- 「1人だけ」はこの索引が担保する。**部分索引にするのは、MEMBER の行はいくつあっても
-- よいためである。** 全体に一意制約を掛けると、2人目のメンバーが入れなくなる。
--
-- 代償: 索引が止められるのは重複であって不在ではない。
-- **「オーナーが0人のワークスペース」は、この索引では防げない。**
-- ワークスペースの作成時にオーナーの Membership を同一トランザクションで作ること。
CREATE UNIQUE INDEX "Membership_single_owner_per_workspace"
    ON "Membership" ("workspaceId")
    WHERE "role" = 'OWNER';

-- 未使用のリカバリーコードは1人につき1つだけ（機能一覧 1.1）。
--
-- 「使用したコードは無効化し、再設定の完了時に新しいコードを発行する」を、
-- **古いコードを無効にしない限り新しく発行できない**形にして担保する。
-- これが無いと、再発行の実装が古い行を消し忘れたときに、有効なコードが2つ残る。
-- 復旧手段が増えることは、そのまま総当たりの的が増えることである。
--
-- 代償: **1人に複数のコードをまとめて配る方式には、この索引のままでは変更できない。**
-- 変更するならこの索引を落とす必要がある。
CREATE UNIQUE INDEX "RecoveryCode_single_unused_per_user"
    ON "RecoveryCode" ("userId")
    WHERE "usedAt" IS NULL;

-- チャンネルのアーカイブ・採番・改名が不可分であること（F-35。2026-09-04 承認）。
--
-- アーカイブすると name を `baseName-<archiveSequence>` に変える。**この3つは
-- 必ず同時に起きなければならない。** どれか1つだけが行われた状態を DB が受け入れると、
--
--   - 採番だけ  → 名前と番号が食い違い、名前から採番を辿れなくなる
--   - 改名だけ  → 名前が baseName とも採番とも合わなくなる
--   - アーカイブだけ → 名前が空かず、同じ名前で作り直せない（この機能の目的が失われる）
--
-- **アプリ側の実装に委ねると、片方だけ実行された状態が作れてしまう。**
-- 検査制約は行ごとに評価されるため、同一の UPDATE 文で揃えない限り通らない。
--
-- **条件を archivedAt で場合分けしない。** 採番と名前の対応は
-- **アーカイブ中かどうかに関わらず常に成り立つ**必要がある。
-- 場合分けすると、復元（archivedAt を null に戻す操作）が
-- 「採番を外して名前を baseName に戻すこと」まで要求してしまい、
-- **承認済みの「復元しても番号は外れない」（機能一覧 3.2）が成立しない。**
-- さらに、その名前で作り直された新しいチャンネルがあれば、
-- 復元そのものが Channel_workspaceId_name_key と衝突して失敗する。
--
-- 代償: **アーカイブ済みチャンネルの名前を、後から自由に変えられない。**
-- 名前は baseName と採番から機械的に決まる。
ALTER TABLE "Channel"
    ADD CONSTRAINT "Channel_archive_naming_check" CHECK (
        -- 採番と名前は常に対応する（採番だけ・改名だけを禁じる）。
        CASE
            WHEN "archiveSequence" IS NULL THEN "name" = "baseName"
            ELSE "name" = "baseName" || '-' || "archiveSequence"
        END
        -- アーカイブするなら採番済みでなければならない（アーカイブだけを禁じる）。
        -- 逆向きは要求しない。**採番済みだが現役の行は、復元されたチャンネルである。**
        AND ("archivedAt" IS NULL OR "archiveSequence" IS NOT NULL)
    );
