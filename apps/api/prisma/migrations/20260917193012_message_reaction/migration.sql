-- 絵文字リアクション（F-18。機能一覧 7。#583）。誰がどの絵文字を付けたかの行と、メッセージと絵文字の組ごとの件数（カウンタ列。要件定義書 4.1）。
-- CreateTable
CREATE TABLE "MessageReaction" (
    "id" UUID NOT NULL,
    "messageId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "emoji" TEXT NOT NULL,

    CONSTRAINT "MessageReaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MessageReactionCount" (
    "id" UUID NOT NULL,
    "messageId" UUID NOT NULL,
    "emoji" TEXT NOT NULL,
    "count" INTEGER NOT NULL,

    CONSTRAINT "MessageReactionCount_pkey" PRIMARY KEY ("id")
);

-- 件数は 1 以上（0 になった絵文字の行は消す）。Prisma のスキーマは検査制約を表せないため、ここに置く。
ALTER TABLE "MessageReactionCount"
    ADD CONSTRAINT "MessageReactionCount_count_check" CHECK ("count" >= 1);

-- CreateIndex
CREATE UNIQUE INDEX "MessageReaction_messageId_userId_emoji_key" ON "MessageReaction"("messageId", "userId", "emoji");

-- CreateIndex
CREATE UNIQUE INDEX "MessageReactionCount_messageId_emoji_key" ON "MessageReactionCount"("messageId", "emoji");

-- AddForeignKey
ALTER TABLE "MessageReaction" ADD CONSTRAINT "MessageReaction_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageReaction" ADD CONSTRAINT "MessageReaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageReactionCount" ADD CONSTRAINT "MessageReactionCount_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;
