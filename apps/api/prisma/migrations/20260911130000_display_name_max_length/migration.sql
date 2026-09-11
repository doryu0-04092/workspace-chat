-- 表示名の上限（50文字）を列の型に入れる（機能一覧 1.1 / 1.3。決定・2026-09-11・依頼側。#245）。
-- 既に 50 文字を超える行があると、この変更は失敗する（本番のデータはまだ無い）。
ALTER TABLE "User" ALTER COLUMN "displayName" SET DATA TYPE VARCHAR(50);
