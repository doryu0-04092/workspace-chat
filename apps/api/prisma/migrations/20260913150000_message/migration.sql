-- チャンネルのメッセージ（F-11。機能一覧 4.1。#371）。
-- CreateTable
CREATE TABLE "Message" (
    "id" UUID NOT NULL,
    "channelId" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "authorId" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- 本文は 1〜4000 文字で、空白だけではない（機能一覧 4.1）。Prisma のスキーマは検査制約を表せないため、ここに置く。
ALTER TABLE "Message"
    ADD CONSTRAINT "Message_body_check" CHECK (char_length("body") BETWEEN 1 AND 4000 AND "body" ~ '\S');

-- CreateIndex
CREATE INDEX "Message_channelId_id_idx" ON "Message"("channelId", "id" DESC);

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_channelId_workspaceId_fkey" FOREIGN KEY ("channelId", "workspaceId") REFERENCES "Channel"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
