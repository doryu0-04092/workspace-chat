import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { resolvePort } from './port';

async function bootstrap(): Promise<void> {
  // 設定の検証はアプリを組み立てる前に済ませる。後に置くと、
  // 起動処理を一通り走らせてから落ちることになる。
  const port = resolvePort(process.env.PORT);
  const app = await NestFactory.create(AppModule);
  await app.listen(port);
}

void bootstrap();
