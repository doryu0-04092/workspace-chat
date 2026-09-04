import { Module } from '@nestjs/common';

/**
 * 雛形の段階では何も持たない。
 *
 * **公開するエンドポイントを、要件に記録しないまま足さない**（CLAUDE.md 1）。
 * 死活確認のエンドポイントは ALB の構成に必要になるが、それは
 * 機能一覧に区分と根拠を記録してから足す（#15）。
 */
@Module({})
export class AppModule {}
