import 'reflect-metadata';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installFatalHandlers, reportFatal, start } from './bootstrap';

type LogLine = { level?: string; message?: unknown; stack?: unknown; context?: string };

/** 標準出力と標準エラーに書かれた行を控える。 */
function captureStreams(): { stdout: string[]; stderr: string[] } {
  const written = { stdout: [] as string[], stderr: [] as string[] };
  for (const name of ['stdout', 'stderr'] as const) {
    vi.spyOn(process[name], 'write').mockImplementation(((chunk: unknown) => {
      written[name].push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
  }
  return written;
}

function jsonLines(chunks: string[]): LogLine[] {
  return chunks
    .flatMap((chunk) => chunk.split('\n'))
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line) as LogLine);
}

// 要件定義書 4.6「ログは構造化 JSON を標準出力にのみ出す」を、起動に失敗した場面でも成り立たせる（PR #255 第1巡）。
// createApp の外側（PORT の検証・listen・プロセス全体で捕まえられなかった例外）は、既定では素のスタックトレースが標準エラーに出る。
describe('起動の失敗の報告', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('不正な PORT での起動の失敗を、標準出力に JSON の error で出し、終了コード 1 で終わる', async () => {
    vi.stubEnv('PORT', 'not-a-port');
    const written = captureStreams();
    const exit = vi.fn();

    await start(new EventEmitter() as unknown as NodeJS.Process, (error) =>
      reportFatal(error, exit),
    );

    const errors = jsonLines(written.stdout).filter((line) => line.level === 'error');
    expect(errors).toHaveLength(1);
    expect(String(errors[0]?.message)).toContain('PORT');
    expect(errors[0]?.context).toBe('Bootstrap');
    expect(written.stderr).toHaveLength(0);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('プロセス全体で捕まえられなかった例外と拒否を、同じ報告に渡す', () => {
    const proc = new EventEmitter();
    const report = vi.fn();
    installFatalHandlers(proc as unknown as NodeJS.Process, report);

    const thrown = new Error('uncaught');
    proc.emit('uncaughtException', thrown);
    proc.emit('unhandledRejection', 'rejected');

    expect(report).toHaveBeenNthCalledWith(1, thrown);
    expect(report).toHaveBeenNthCalledWith(2, 'rejected');
  });

  // 本番の起動（main.ts）は start だけを呼ぶ。購読と失敗の報告を start の外で個別に組むと、
  // 当て忘れてもテストが落ちない（app-setup.ts の createApp と同じ理由。PR #255 第2巡）。
  it('start は、起動より前に購読を付け、起動の失敗を報告に渡す', async () => {
    const proc = new EventEmitter();
    const report = vi.fn();
    const failure = new Error('起動に失敗した');
    let listenersAtRun = -1;
    const run = vi.fn(async () => {
      listenersAtRun =
        proc.listenerCount('uncaughtException') + proc.listenerCount('unhandledRejection');
      throw failure;
    });

    await start(proc as unknown as NodeJS.Process, report, run);

    expect(listenersAtRun).toBe(2);
    expect(report).toHaveBeenCalledExactlyOnceWith(failure);
  });

  it('起動に成功したら報告しない', async () => {
    const report = vi.fn();
    await start(new EventEmitter() as unknown as NodeJS.Process, report, async () => undefined);
    expect(report).not.toHaveBeenCalled();
  });
});
