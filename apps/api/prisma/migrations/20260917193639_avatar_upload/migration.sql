-- アバター画像のアップロード（F-04。機能一覧 1.3・11.1。#585）。発行した署名付き URL 1つに1行。
-- キーは列に持たず行から組み立てる。確定は識別子ごとに1回だけ行い、結果の列を2回目以降に返す。
-- CreateEnum
CREATE TYPE "UploadState" AS ENUM ('ISSUED', 'COMPLETING', 'SUCCEEDED', 'REJECTED');

-- CreateTable
CREATE TABLE "AvatarUpload" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "fileName" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "state" "UploadState" NOT NULL DEFAULT 'ISSUED',
    "deliveredFileName" TEXT,
    "rejectedStatus" INTEGER,
    "rejectedCode" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMPTZ(3),

    CONSTRAINT "AvatarUpload_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AvatarUpload_userId_idx" ON "AvatarUpload"("userId");

-- AddForeignKey
ALTER TABLE "AvatarUpload" ADD CONSTRAINT "AvatarUpload_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
