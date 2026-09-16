-- 既読位置（F-23。機能一覧 10.1。#504）。未読は、ここからの差分で求める（都度集計しない）。
-- 位置は時刻ではなくメッセージの id で持つ（同じミリ秒の投稿の前後が時刻では決まらない。id は UUIDv7 で作った順に増える）。
-- 参照先は ChannelMember と同じ考え方で Membership である（キック・退出で既読位置も連鎖して消える）。
-- AlterTable
ALTER TABLE "User" ADD COLUMN "threadUnreadIncluded" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "ChannelRead" (
    "id" UUID NOT NULL,
    "channelId" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "lastReadMessageId" UUID NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChannelRead_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ThreadRead" (
    "id" UUID NOT NULL,
    "parentMessageId" UUID NOT NULL,
    "channelId" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "lastReadMessageId" UUID NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ThreadRead_pkey" PRIMARY KEY ("id")
);

-- 未読の集計は ("channelId", "id" > 既読位置) で引く。(channelId, parentId, id) では2列目が parentId のため前方一致にならない。
-- CreateIndex
CREATE INDEX "Message_channelId_id_idx" ON "Message"("channelId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ChannelRead_channelId_userId_key" ON "ChannelRead"("channelId", "userId");

-- CreateIndex
CREATE INDEX "ChannelRead_userId_idx" ON "ChannelRead"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "ThreadRead_parentMessageId_userId_key" ON "ThreadRead"("parentMessageId", "userId");

-- CreateIndex
CREATE INDEX "ThreadRead_userId_idx" ON "ThreadRead"("userId");

-- AddForeignKey
ALTER TABLE "ChannelRead" ADD CONSTRAINT "ChannelRead_channelId_workspaceId_fkey" FOREIGN KEY ("channelId", "workspaceId") REFERENCES "Channel"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChannelRead" ADD CONSTRAINT "ChannelRead_workspaceId_userId_fkey" FOREIGN KEY ("workspaceId", "userId") REFERENCES "Membership"("workspaceId", "userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChannelRead" ADD CONSTRAINT "ChannelRead_lastReadMessageId_channelId_fkey" FOREIGN KEY ("lastReadMessageId", "channelId") REFERENCES "Message"("id", "channelId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ThreadRead" ADD CONSTRAINT "ThreadRead_workspaceId_userId_fkey" FOREIGN KEY ("workspaceId", "userId") REFERENCES "Membership"("workspaceId", "userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ThreadRead" ADD CONSTRAINT "ThreadRead_parentMessageId_channelId_fkey" FOREIGN KEY ("parentMessageId", "channelId") REFERENCES "Message"("id", "channelId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ThreadRead" ADD CONSTRAINT "ThreadRead_lastReadMessageId_channelId_fkey" FOREIGN KEY ("lastReadMessageId", "channelId") REFERENCES "Message"("id", "channelId") ON DELETE NO ACTION ON UPDATE CASCADE;
