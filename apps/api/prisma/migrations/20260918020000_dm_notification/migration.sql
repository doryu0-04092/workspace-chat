-- DM の通知（F-26・F-19。機能一覧 10.3。#623）。チャンネルの通知（Notification）と参照先が違うため表を分ける。
-- schema.prisma から prisma migrate diff で作った。
-- CreateTable
CREATE TABLE "DmNotification" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "dmId" UUID NOT NULL,
    "messageId" UUID NOT NULL,
    "readAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DmNotification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DmNotification_userId_id_idx" ON "DmNotification"("userId", "id" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "DmNotification_messageId_userId_key" ON "DmNotification"("messageId", "userId");

-- AddForeignKey
ALTER TABLE "DmNotification" ADD CONSTRAINT "DmNotification_workspaceId_userId_fkey" FOREIGN KEY ("workspaceId", "userId") REFERENCES "Membership"("workspaceId", "userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DmNotification" ADD CONSTRAINT "DmNotification_dmId_workspaceId_fkey" FOREIGN KEY ("dmId", "workspaceId") REFERENCES "Dm"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DmNotification" ADD CONSTRAINT "DmNotification_messageId_dmId_fkey" FOREIGN KEY ("messageId", "dmId") REFERENCES "DmMessage"("id", "dmId") ON DELETE NO ACTION ON UPDATE CASCADE;

