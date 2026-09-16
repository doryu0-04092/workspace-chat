-- スレッド（F-17。機能一覧 6。#488）。返信は親と同じチャンネルのメッセージで、返信件数はカウンタ列に持つ（要件定義書 4.1）。
-- AlterTable
ALTER TABLE "Message" ADD COLUMN "parentId" UUID,
ADD COLUMN "replyCount" INTEGER NOT NULL DEFAULT 0;

-- 返信件数は負にならない。Prisma のスキーマは検査制約を表せないため、ここに置く。
ALTER TABLE "Message"
    ADD CONSTRAINT "Message_replyCount_check" CHECK ("replyCount" >= 0);

-- DropIndex
DROP INDEX "Message_channelId_id_idx";

-- CreateIndex
CREATE UNIQUE INDEX "Message_id_channelId_key" ON "Message"("id", "channelId");

-- CreateIndex
CREATE INDEX "Message_channelId_parentId_id_idx" ON "Message"("channelId", "parentId", "id" DESC);

-- CreateIndex
CREATE INDEX "Message_parentId_id_idx" ON "Message"("parentId", "id" DESC);

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_parentId_channelId_fkey" FOREIGN KEY ("parentId", "channelId") REFERENCES "Message"("id", "channelId") ON DELETE NO ACTION ON UPDATE CASCADE;
