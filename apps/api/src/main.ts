import 'reflect-metadata';
import { createApp } from './app-setup';
import { resolvePort } from './port';

async function bootstrap(): Promise<void> {
  // 設定の検証はアプリを組み立てる前に済ませる。後に置くと、
  // 起動処理を一通り走らせてから落ちることになる。
  const port = resolvePort(process.env.PORT);
  const app = await createApp();
  await app.listen(port);
}

void bootstrap();
