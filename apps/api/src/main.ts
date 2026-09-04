import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  // 待ち受けポートは環境変数で変えられるようにする。値そのものは持たない。
  await app.listen(Number(process.env.PORT ?? 3000));
}

void bootstrap();
