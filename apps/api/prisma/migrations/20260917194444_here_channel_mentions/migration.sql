-- 一斉メンション（F-21。機能一覧 9.2。#579）。本文の `@channel` / `@here` を持つかと、`@here` の送った宛先と受け取り（受け取りを返した利用者は receivedAt を持つ）。
-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "mentionsChannel" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "mentionsHere" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "HereMentionRecipient" (
    "id" UUID NOT NULL,
    "messageId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "receivedAt" TIMESTAMPTZ(3),

    CONSTRAINT "HereMentionRecipient_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "HereMentionRecipient_messageId_userId_key" ON "HereMentionRecipient"("messageId", "userId");

-- AddForeignKey
ALTER TABLE "HereMentionRecipient" ADD CONSTRAINT "HereMentionRecipient_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HereMentionRecipient" ADD CONSTRAINT "HereMentionRecipient_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

