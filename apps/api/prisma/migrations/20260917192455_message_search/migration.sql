-- 全文検索（F-30。機能一覧 12.1。#582）。日本語は単語の区切りが無く標準の索引が効かないため、pg_bigm の 2-gram の GIN 索引で `LIKE '%…%'` を引く（技術スタック 難-5）。
-- **拡張は条件付きにしない**——無い環境で黙って通すと、本番だけ索引が無い状態が生まれる。pg_bigm は shared_preload_libraries に入っていることを前提とする
-- （開発環境は compose.yaml、テストは apps/api/src/testing/postgres.ts、本番は infra/production/database.tf が渡す）。
CREATE EXTENSION IF NOT EXISTS pg_bigm;

-- CreateIndex
CREATE INDEX "Message_body_bigm_idx" ON "Message" USING GIN ("body" gin_bigm_ops);
