-- ピン留め（F-33。機能一覧 13.2。#584）。1件のメッセージに1つまで。メッセージと同じチャンネルの組で参照する。
-- CreateTable
CREATE TABLE "MessagePin" (
    "id" UUID NOT NULL,
    "messageId" UUID NOT NULL,
    "channelId" UUID NOT NULL,
    "pinnedById" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MessagePin_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MessagePin_messageId_key" ON "MessagePin"("messageId");

-- CreateIndex
CREATE INDEX "MessagePin_channelId_id_idx" ON "MessagePin"("channelId", "id");

-- AddForeignKey
ALTER TABLE "MessagePin" ADD CONSTRAINT "MessagePin_messageId_channelId_fkey" FOREIGN KEY ("messageId", "channelId") REFERENCES "Message"("id", "channelId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessagePin" ADD CONSTRAINT "MessagePin_pinnedById_fkey" FOREIGN KEY ("pinnedById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
