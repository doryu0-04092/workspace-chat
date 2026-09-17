-- 通知（F-26。機能一覧 10.3。#580）。受け取ったメンションを残し、後から一覧で確かめて既読化できるようにする。
-- 参照先は ChannelRead と同じ考え方で Membership である（ワークスペースからのキック・退出で通知も連鎖して消える）。
-- チャンネル単位のキック・退出では消えないため、一覧と既読化は ChannelMember との結合で参加者の行だけを返す。
-- CreateEnum
CREATE TYPE "NotificationKind" AS ENUM ('MENTION');

-- CreateTable
CREATE TABLE "Notification" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "channelId" UUID NOT NULL,
    "messageId" UUID NOT NULL,
    "kind" "NotificationKind" NOT NULL,
    "readAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- 一覧は利用者ごとに新しい順（id の降順）で引く。
-- CreateIndex
CREATE INDEX "Notification_userId_id_idx" ON "Notification"("userId", "id" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "Notification_messageId_userId_kind_key" ON "Notification"("messageId", "userId", "kind");

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_workspaceId_userId_fkey" FOREIGN KEY ("workspaceId", "userId") REFERENCES "Membership"("workspaceId", "userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_channelId_workspaceId_fkey" FOREIGN KEY ("channelId", "workspaceId") REFERENCES "Channel"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_messageId_channelId_fkey" FOREIGN KEY ("messageId", "channelId") REFERENCES "Message"("id", "channelId") ON DELETE NO ACTION ON UPDATE CASCADE;
