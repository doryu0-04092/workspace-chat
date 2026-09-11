import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

const storage = new AsyncLocalStorage<{ requestId: string }>();

/** いま処理している要求のリクエスト ID。要求の外（起動時など）では undefined。 */
export function currentRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}

/**
 * 要求ごとにリクエスト ID を振り、その要求の処理の中から `currentRequestId()` で引けるようにする（要件定義書 4.6）。
 * **ID は応答に載せない**（4.6 が決めているのはログへの付与までである）。
 *
 * **送られてきた `X-Request-Id` は使わない。** 利用者が決めた値をログの突き合わせの鍵にすると、
 * 他人の要求と同じ ID を名乗ってログを紛らわせられる。ID は常にサーバーが UUID で振る。
 *
 * **踏むと壊れる: createApp の中で、ほかのどのミドルウェアよりも先に置く。** 後ろに置くと、
 * それより前で起きた失敗（本体の読み取りなど）のログに ID が付かない。
 */
export function requestContext(_req: Request, _res: Response, next: NextFunction): void {
  storage.run({ requestId: randomUUID() }, next);
}
