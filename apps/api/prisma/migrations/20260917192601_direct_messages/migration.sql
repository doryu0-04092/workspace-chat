-- ダイレクトメッセージ（F-19。機能一覧 8）と、その既読位置（「利用者 × DM」。F-23。機能一覧 10.1。#574）。
-- DM はチャンネルではない（機能一覧 5.2）ため、Channel / Message とは別の表に持つ。
-- 当事者は User を参照する（Membership を参照すると、キック・退出で DM とメッセージが連鎖して消え、過去のメッセージが残らない）。
-- CreateTable
CREATE TABLE "Dm" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "lowUserId" UUID NOT NULL,
    "highUserId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Dm_pkey" PRIMARY KEY ("id"),
    -- 当事者は User.id の小さい方が先で、自分自身ではない（Prisma の記法に無い。schema.prisma の冒頭の7）。
    -- 順を縛らないと、同じ2人の行が逆の順でもう1つ入り、下の一意索引をすり抜ける（機能一覧 8「同じ相手との DM は1つに集約される」）。
    CONSTRAINT "Dm_participants_check" CHECK ("lowUserId" < "highUserId")
);

-- CreateTable
CREATE TABLE "DmMessage" (
    "id" UUID NOT NULL,
    "dmId" UUID NOT NULL,
    "authorId" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "editedAt" TIMESTAMPTZ(3),
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "DmMessage_pkey" PRIMARY KEY ("id"),
    -- 本文は 1〜4000 文字で、空白だけではない（チャンネルのメッセージの Message_body_check と同じ。schema.prisma の冒頭の8）。
    CONSTRAINT "DmMessage_body_check" CHECK (char_length("body") BETWEEN 1 AND 4000 AND "body" ~ '\S')
);

-- CreateTable
CREATE TABLE "DmRead" (
    "id" UUID NOT NULL,
    "dmId" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "lastReadMessageId" UUID NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DmRead_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Dm_workspaceId_highUserId_idx" ON "Dm"("workspaceId", "highUserId");

-- CreateIndex
CREATE UNIQUE INDEX "Dm_workspaceId_lowUserId_highUserId_key" ON "Dm"("workspaceId", "lowUserId", "highUserId");

-- CreateIndex
CREATE UNIQUE INDEX "Dm_id_workspaceId_key" ON "Dm"("id", "workspaceId");

-- CreateIndex
CREATE INDEX "DmMessage_dmId_id_idx" ON "DmMessage"("dmId", "id" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "DmMessage_id_dmId_key" ON "DmMessage"("id", "dmId");

-- CreateIndex
CREATE INDEX "DmRead_userId_idx" ON "DmRead"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "DmRead_dmId_userId_key" ON "DmRead"("dmId", "userId");

-- AddForeignKey
ALTER TABLE "Dm" ADD CONSTRAINT "Dm_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Dm" ADD CONSTRAINT "Dm_lowUserId_fkey" FOREIGN KEY ("lowUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Dm" ADD CONSTRAINT "Dm_highUserId_fkey" FOREIGN KEY ("highUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DmMessage" ADD CONSTRAINT "DmMessage_dmId_fkey" FOREIGN KEY ("dmId") REFERENCES "Dm"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DmMessage" ADD CONSTRAINT "DmMessage_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DmRead" ADD CONSTRAINT "DmRead_dmId_workspaceId_fkey" FOREIGN KEY ("dmId", "workspaceId") REFERENCES "Dm"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DmRead" ADD CONSTRAINT "DmRead_workspaceId_userId_fkey" FOREIGN KEY ("workspaceId", "userId") REFERENCES "Membership"("workspaceId", "userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DmRead" ADD CONSTRAINT "DmRead_lastReadMessageId_dmId_fkey" FOREIGN KEY ("lastReadMessageId", "dmId") REFERENCES "DmMessage"("id", "dmId") ON DELETE NO ACTION ON UPDATE CASCADE;
