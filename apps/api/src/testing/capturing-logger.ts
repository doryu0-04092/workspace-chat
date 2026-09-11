import type { LoggerService } from '@nestjs/common';

/**
 * アプリのログをすべて控える。パスワード・トークンがログの経路に渡っていないかを見るため。
 * **製品コードから読み込まない**（tsconfig.build.json が外す）。
 */
export class CapturingLogger implements LoggerService {
  readonly lines: string[] = [];
  private capture(level: string, message: unknown, rest: unknown[]): void {
    this.lines.push(`${level} ${JSON.stringify([message, ...rest], errorReplacer)}`);
  }
  log(message: unknown, ...rest: unknown[]): void {
    this.capture('log', message, rest);
  }
  error(message: unknown, ...rest: unknown[]): void {
    this.capture('error', message, rest);
  }
  warn(message: unknown, ...rest: unknown[]): void {
    this.capture('warn', message, rest);
  }
  debug(message: unknown, ...rest: unknown[]): void {
    this.capture('debug', message, rest);
  }
  verbose(message: unknown, ...rest: unknown[]): void {
    this.capture('verbose', message, rest);
  }
}

/** Error はそのままでは JSON にならない。メッセージとスタックを残す。 */
function errorReplacer(_key: string, value: unknown): unknown {
  return value instanceof Error ? { message: value.message, stack: value.stack } : value;
}
