import 'reflect-metadata';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installFatalHandlers, installWarningLog, reportFatal, start } from './bootstrap';
import { captureOutput } from './testing/captured-output';

type LogLine = { level?: string; message?: unknown; stack?: unknown; context?: string };

/** 標準出力と標準エラーに書かれた行を控える。**通さない**——起動の失敗のスタックをテストの出力に混ぜない。 */
function captureStreams() {
  return {
    stdout: captureOutput('stdout', { passThrough: false }),
    stderr: captureOutput('stderr', { passThrough: false }),
  };
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

    const errors = written.stdout.jsonLines<LogLine>().filter((line) => line.level === 'error');
    expect(errors).toHaveLength(1);
    expect(String(errors[0]?.message)).toContain('PORT');
    expect(errors[0]?.context).toBe('Bootstrap');
    expect(written.stderr.chunks).toHaveLength(0);
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

// 要件定義書 4.6「ログは構造化 JSON を標準出力にのみ出す」を、Node 自身の警告にも当てる（決定・2026-09-13・依頼側。#258）。
// Node は既定で警告を素のテキストで標準エラーへ書く。起動のコマンドの --no-warnings で既定の出力を止め、'warning' を受けて構造化ログに残す。
describe('Node の警告', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('警告を、名前・コード・メッセージ・スタックを持つ JSON の warn として標準出力に出し、標準エラーには書かない', () => {
    const proc = new EventEmitter();
    const written = captureStreams();
    installWarningLog(proc as unknown as NodeJS.Process);

    const warning = Object.assign(new Error('Buffer() is deprecated'), {
      name: 'DeprecationWarning',
      code: 'DEP0005',
    });
    proc.emit('warning', warning);

    const warns = written.stdout.jsonLines<LogLine>().filter((line) => line.level === 'warn');
    expect(warns).toHaveLength(1);
    expect(warns[0]?.context).toBe('NodeWarning');
    expect(warns[0]?.message).toMatchObject({
      name: 'DeprecationWarning',
      code: 'DEP0005',
      message: 'Buffer() is deprecated',
    });
    expect(String((warns[0]?.message as { stack?: unknown }).stack)).toContain(
      'Buffer() is deprecated',
    );
    expect(written.stderr.chunks).toHaveLength(0);
  });

  it('start は、起動より前に警告の購読を付ける', async () => {
    const proc = new EventEmitter();
    let listenersAtRun = -1;

    await start(proc as unknown as NodeJS.Process, vi.fn(), async () => {
      listenersAtRun = proc.listenerCount('warning');
    });

    expect(listenersAtRun).toBe(1);
  });

  // 既定の出力を止めるのは起動のコマンドの --no-warnings だけである（'warning' を購読しても止まらない）。
  // 起動のコマンドは名前ではなく中身（dist/main.js を起動するもの）で数え上げる。
  it('api を起動するコマンド（コンテナの実行段・npm のスクリプト）は、すべて --no-warnings を付ける', () => {
    const apiRoot = join(__dirname, '..');
    const dockerfile = readFileSync(join(apiRoot, 'Dockerfile'), 'utf8');
    const { scripts } = JSON.parse(readFileSync(join(apiRoot, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };

    const commands = [
      ...[...dockerfile.matchAll(/^CMD (\[.*\])$/gm)]
        .map((match) => JSON.parse(match[1] ?? '[]') as string[])
        .filter((args) => args.some((arg) => arg.endsWith('dist/main.js'))),
      ...Object.values(scripts)
        .filter((script) => script.includes('dist/main.js'))
        .map((script) => script.split(/\s+/)),
    ];

    expect(commands.length).toBeGreaterThanOrEqual(3);
    for (const args of commands) expect(args).toContain('--no-warnings');
  });
});
