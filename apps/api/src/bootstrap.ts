import type { INestApplication } from '@nestjs/common';
import { createApp } from './app-setup';
import { JsonLogger } from './logging/json-logger';
import { resolvePort } from './port';

/**
 * api を起動する（start が呼ぶ）。
 */
export async function bootstrap(): Promise<INestApplication> {
  // 設定の検証はアプリを組み立てる前に済ませる。後に置くと、
  // 起動処理を一通り走らせてから落ちることになる。
  const port = resolvePort(process.env.PORT);
  const app = await createApp();
  await app.listen(port);
  return app;
}

/**
 * 起動の失敗と、プロセス全体で捕まえられなかった例外を報告して終わる。
 *
 * **createApp の外側の失敗も、要件定義書 4.6「ログは構造化 JSON を標準出力にのみ出す」の対象である。**
 * 既定では、不正な PORT・listen の失敗（EADDRINUSE など）・捕まえられなかった例外は、Node が素のスタックトレースを
 * 標準エラーへ複数行で出す。起動できずにタスクが落ちた場面こそ、他のログと同じ形で引ける必要がある。
 */
export function reportFatal(error: unknown, exit: (code: number) => void = process.exit): void {
  const failure = error instanceof Error ? error : new Error(String(error));
  new JsonLogger().error(failure.message, failure.stack, 'Bootstrap');
  exit(1);
}

/** プロセス全体で捕まえられなかった例外と拒否を、reportFatal に渡す。 */
export function installFatalHandlers(
  proc: NodeJS.Process = process,
  report: (error: unknown) => void = reportFatal,
): void {
  proc.on('uncaughtException', (error) => report(error));
  proc.on('unhandledRejection', (reason) => report(reason));
}

/**
 * 本番の起動の入口（main.ts はこれだけを呼ぶ）。**購読と失敗の報告をここで組む**——main.ts で個別に組むと、
 * 当て忘れてもテストが落ちない（app-setup.ts の createApp と同じ理由）。
 */
export async function start(
  proc: NodeJS.Process = process,
  report: (error: unknown) => void = reportFatal,
  run: () => Promise<unknown> = bootstrap,
): Promise<void> {
  installFatalHandlers(proc, report);
  try {
    await run();
  } catch (error) {
    report(error);
  }
}
