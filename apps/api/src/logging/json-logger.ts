import { ConsoleLogger } from '@nestjs/common';
import { currentRequestId } from './request-context';

type JsonLogOptions = Parameters<ConsoleLogger['getJsonLogObject']>[1];

/**
 * api の既定のロガー（createApp が組み立てる）。要件定義書 4.6「ログは構造化 JSON を標準出力にのみ出す」
 * 「リクエストごとに ID を発行し、そのリクエスト中の全ログに付与する」。
 *
 * - NestJS 11 の `ConsoleLogger` の `json: true` を使う（1行1件の JSON。依存を足さない）
 * - 要求の中で出たログには `requestId` を足す（request-context.ts）
 * - **error も標準出力に書く**——`ConsoleLogger` は既定で error を標準エラーへ書くため、書き先を固定する
 *
 * **ログに渡す値は、ここでは伏せない。** パスワード・トークン・本体を渡さないのは呼ぶ側の規約であり
 * （CLAUDE.md 禁止事項）、ここで伏せる仕組みに寄りかかると、伏せ漏れた形がそのまま出る。
 */
export class JsonLogger extends ConsoleLogger {
  constructor() {
    super({ json: true });
  }

  protected override getJsonLogObject(
    message: unknown,
    options: JsonLogOptions,
  ): ReturnType<ConsoleLogger['getJsonLogObject']> & { requestId?: string } {
    const logObject = super.getJsonLogObject(message, options);
    const requestId = currentRequestId();
    return requestId === undefined ? logObject : { ...logObject, requestId };
  }

  protected override printAsJson(message: unknown, options: JsonLogOptions): void {
    super.printAsJson(message, { ...options, writeStreamType: 'stdout' });
  }
}
