import { Module } from '@nestjs/common';

/**
 * 雛形の段階では何も持たない。
 *
 * **公開するエンドポイントを、要件に記録しないまま足さない**（CLAUDE.md 1）。
 * 死活確認のエンドポイントは ALB の構成に必要になる。区分と根拠は
 * F-39 として記録済み（機能一覧 14.1。#15）。実装（本体とテスト）は
 * API の最初の PR で足す。
 */
@Module({})
export class AppModule {}
