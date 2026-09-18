-- DM の添付ファイルのアップロード（F-27・F-28・F-19。#239。決定・2026-09-11・依頼側）。発行した署名付き URL 1つに1行。
-- チャンネルの Attachment と表を分ける（チャンネルの参加者判定と DM の当事者判定を1つの経路に混ぜない）。
-- 確定に成功したものだけを、同じ DM の投稿に結び付ける。
-- CreateTable
CREATE TABLE "DmAttachment" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "dmId" UUID NOT NULL,
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

    CONSTRAINT "DmAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DmAttachment_uploaderId_idx" ON "DmAttachment"("uploaderId");

-- CreateIndex
CREATE INDEX "DmAttachment_dmId_idx" ON "DmAttachment"("dmId");

-- CreateIndex
CREATE INDEX "DmAttachment_messageId_idx" ON "DmAttachment"("messageId");

-- AddForeignKey
ALTER TABLE "DmAttachment" ADD CONSTRAINT "DmAttachment_dmId_workspaceId_fkey" FOREIGN KEY ("dmId", "workspaceId") REFERENCES "Dm"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DmAttachment" ADD CONSTRAINT "DmAttachment_uploaderId_fkey" FOREIGN KEY ("uploaderId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DmAttachment" ADD CONSTRAINT "DmAttachment_messageId_dmId_fkey" FOREIGN KEY ("messageId", "dmId") REFERENCES "DmMessage"("id", "dmId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- DM の本文の検査制約を「4000 文字まで」に緩める（チャンネルの #614 と同じ）。
-- 添付が1件以上ある投稿は本文が空・空白だけでもよい。空・空白だけを断るのは REST の仕様（CreateDmMessageRequest の if/else）が持つ。
ALTER TABLE "DmMessage" DROP CONSTRAINT "DmMessage_body_check";
ALTER TABLE "DmMessage"
    ADD CONSTRAINT "DmMessage_body_check" CHECK (char_length("body") <= 4000);
