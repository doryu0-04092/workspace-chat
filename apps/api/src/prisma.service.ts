import { Global, Injectable, Module, type OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client';

/**
 * DB の接続先を決める。**未設定・空は起動時に落とす。**
 * 見逃すと最初の問い合わせで原因の分かりにくいエラーになる。
 * **例外のメッセージに値を載せない**——接続先には資格情報が入り、起動の失敗はログに出る。
 */
export function resolveDatabaseUrl(raw: string | undefined): string {
  if (raw === undefined || raw === '') {
    throw new Error(
      'DATABASE_URL が設定されていません（開発用データベースの接続 URL を環境変数で渡す）',
    );
  }
  return raw;
}

/**
 * API から DB に繋ぐ入口。
 *
 * **Prisma 7 のクライアントはドライバアダプタを必須とする**（`@prisma/adapter-pg`）。
 * 接続先は環境変数 `DATABASE_URL` で渡す（api は .env を読まない。.env.example の冒頭）。
 * 接続は最初の問い合わせで張られる。
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  constructor() {
    super({
      adapter: new PrismaPg({ connectionString: resolveDatabaseUrl(process.env.DATABASE_URL) }),
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}

/** 接続を1つにするため、全モジュールで同じ PrismaService を使う。 */
@Global()
@Module({ providers: [PrismaService], exports: [PrismaService] })
export class PrismaModule {}
