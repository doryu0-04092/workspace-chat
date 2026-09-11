import { Global, Inject, Injectable, Module, type OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { API_CONFIG, type ApiConfig } from './config/api-config';
import { PrismaClient } from './generated/prisma/client';

/**
 * API から DB に繋ぐ入口。
 *
 * **Prisma 7 のクライアントはドライバアダプタを必須とする**（`@prisma/adapter-pg`）。
 * 接続先は環境変数 `DATABASE_URL` で渡す（api は .env を読まない。.env.example の冒頭。検証は config/api-config.ts）。
 * 接続は最初の問い合わせで張られる。
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  constructor(@Inject(API_CONFIG) config: ApiConfig) {
    super({
      adapter: new PrismaPg({ connectionString: config.databaseUrl }),
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
