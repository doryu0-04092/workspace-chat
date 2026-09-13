-- メッセージの編集と論理削除（F-13。機能一覧 4.2。#371）。削除しても本文は残す（要件定義書 3.4）。
-- AlterTable
ALTER TABLE "Message" ADD COLUMN "editedAt" TIMESTAMPTZ(3),
ADD COLUMN "deletedAt" TIMESTAMPTZ(3);
