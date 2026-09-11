import { Logger } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { type ErrorResponse, errorBodyForStatus } from './error-response';

/** 本体の読み取り（body-parser）の失敗。`http-errors` の形で、`type` に種類が入る。 */
type BodyReadError = { status: number; type: string };

function isBodyReadError(error: unknown): error is BodyReadError {
  if (typeof error !== 'object' || error === null) return false;
  const { status, type } = error as { status?: unknown; type?: unknown };
  return (
    typeof status === 'number' &&
    typeof type === 'string' &&
    /^(entity|encoding|charset|request|stream|parameters)\./.test(type)
  );
}

/**
 * 本体の読み取りの 400（壊れた JSON・途中で切れた本体など）は、入力の検証の失敗（validation_failed）と分けて invalid_body。
 * それ以外の状態（413 の大きすぎる本体・415 の扱えない文字集合や内容符号化・5xx のストリームの異常）は、
 * 状態コードごとの既定の本体（error-response.ts）を引く——仕様がその状態に宣言した `code` と揃えるため。
 */
const INVALID_BODY: ErrorResponse = { code: 'invalid_body', message: '本体を読めません' };

const logger = new Logger('BodyRead');

/**
 * 本体の読み取りの失敗を、送られた値を載せない ErrorResponse で返す Express のエラーミドルウェア。
 * **JSON の body-parser の直後に置く**（app-setup.ts）。
 *
 * **Nest の例外フィルタでは受けられない。** Nest は body-parser の SyntaxError を
 * `new BadRequestException(err.message)` に作り直してからフィルタに渡す（@nestjs/core の routes-resolver.js）。
 * そのとき失敗の種類（`type`）は消え、**`JSON.parse` の失敗のメッセージは入力の断片を含む**
 * （`Unexpected token 'l', ..."password":leaky-secr"...`。Node 24.16.0 で実測）。既定の扱いはそれを応答の本文に入れる。
 * body-parser は例外の `body` に生の本体も付ける。**ここではメッセージも本体もログにも応答にも出さない。**
 *
 * 引数が4つであることが Express のエラーミドルウェアの印である。減らさないこと。
 */
export function bodyReadErrorHandler(
  error: unknown,
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!isBodyReadError(error)) {
    next(error);
    return;
  }
  // 5xx は想定外の失敗としてログに残す。出すのは種類と状態コードだけ（メッセージは入力の断片を含みうる）。
  if (error.status >= 500)
    logger.error(`本体の読み取りに失敗した: ${error.type}（${error.status}）`);
  res
    .status(error.status)
    .json(error.status === 400 ? INVALID_BODY : errorBodyForStatus(error.status));
}
