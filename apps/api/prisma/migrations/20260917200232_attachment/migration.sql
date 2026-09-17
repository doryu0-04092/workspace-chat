-- チャンネルの添付ファイルのアップロード（F-27・F-28。機能一覧 11.1。#586）。発行した署名付き URL 1つに1行。
-- キーと、確定でやり直す参加者判定の対象チャンネルは、この行から組み立てる。確定に成功したものだけを、同じチャンネルの投稿に結び付ける。
-- CreateTable
CREATE TABLE "Attachment" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "channelId" UUID NOT NULL,
    "uploaderId" UUID NOT NULL,
    "originalName" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "state" "UploadState" NOT NULL DEFAULT 'ISSUED',
    "formatId" TEXT,
    "deliveredFileName" TEXT,
    "size" INTEGER,
    "rejectedStatus" INTEGER,
    "rejectedCode" TEXT,
    "messageId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMPTZ(3),

    CONSTRAINT "Attachment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Attachment_uploaderId_idx" ON "Attachment"("uploaderId");

-- CreateIndex
CREATE INDEX "Attachment_channelId_idx" ON "Attachment"("channelId");

-- CreateIndex
CREATE INDEX "Attachment_messageId_idx" ON "Attachment"("messageId");

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_channelId_workspaceId_fkey" FOREIGN KEY ("channelId", "workspaceId") REFERENCES "Channel"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_uploaderId_fkey" FOREIGN KEY ("uploaderId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_messageId_channelId_fkey" FOREIGN KEY ("messageId", "channelId") REFERENCES "Message"("id", "channelId") ON DELETE NO ACTION ON UPDATE CASCADE;
