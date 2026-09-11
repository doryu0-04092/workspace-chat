import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { components } from '@workspace-chat/shared';
import type { Response } from 'express';
import * as OpenApiValidator from 'express-openapi-validator';

/**
 * エラーの応答の本体（REST の仕様の ErrorResponse）。**`code` は仕様の列挙から生成した型であり、
 * 綴りを誤ると型検査で落ちる。** api が返すエラーの本体は、すべてこの形にする。
 */
export type ErrorResponse = components['schemas']['ErrorResponse'];

/**
 * 状態コードごとの既定の本体。**同じ状態コードの本体はここにだけ書く**（仕様がその状態に宣言した `code` に揃える）。
 * `code` を持たない例外（Nest の既定の 404 など）・要求の検証の失敗・本体の読み取りの失敗・レート制限が引く。
 */
const BY_STATUS: Partial<Record<number, ErrorResponse>> = {
  400: { code: 'validation_failed', message: '入力が仕様に合いません' },
  404: { code: 'not_found', message: '見つかりません' },
  405: { code: 'method_not_allowed', message: 'このメソッドは使えません' },
  413: { code: 'payload_too_large', message: '要求が大きすぎます' },
  415: { code: 'unsupported_media_type', message: 'この形式の本体は受け付けません' },
  429: {
    code: 'too_many_requests',
    message: '要求が多すぎます。しばらく待ってからやり直してください',
  },
};
const REJECTED: ErrorResponse = { code: 'request_rejected', message: '要求を受け付けられません' };
const INTERNAL: ErrorResponse = { code: 'internal_error', message: '想定外のエラーが起きました' };

/** 状態コードに対応する本体。5xx は internal_error、表に無い 4xx は request_rejected。 */
export function errorBodyForStatus(status: number): ErrorResponse {
  if (status >= 500) return INTERNAL;
  return BY_STATUS[status] ?? REJECTED;
}

const VALIDATOR_ERRORS = Object.values(OpenApiValidator.error);

function isValidatorError(
  exception: unknown,
): exception is InstanceType<(typeof VALIDATOR_ERRORS)[number]> {
  return VALIDATOR_ERRORS.some((ErrorClass) => exception instanceof ErrorClass);
}

/** 例外に載せた本体が、すでに ErrorResponse の形（`code` と `message` を持つ）か。 */
function isErrorResponse(value: unknown): value is ErrorResponse {
  if (typeof value !== 'object' || value === null) return false;
  const { code, message } = value as { code?: unknown; message?: unknown };
  return typeof code === 'string' && typeof message === 'string';
}

/**
 * **すべての例外を ErrorResponse で返す**（横断的な例外処理で揃える。機能一覧 1.4）。
 *
 * - 要求の検証の失敗（express-openapi-validator）→ 状態コードごとの本体。400 には落ちた箇所（`path`）と
 *   規則の説明（`message`）だけを `errors` に載せる。**送られた値は載せない**
 * - `code` を持つ本体で投げた HttpException（登録の 403・409、レート制限の 429 など）→ その本体のまま
 * - `code` を持たない HttpException（前置き /api の外の Nest の既定の 404 など）→ 状態コードごとの本体。
 *   **例外のメッセージは載せない**（Nest の既定の 404 は「Cannot GET /…」とパスを述べる）
 * - それ以外（想定外の失敗）→ 500（internal_error）。**例外のメッセージを応答に載せない**
 *   （Prisma のメッセージは呼び出し箇所のソースの抜き出しを含む）。ログには今までどおり error で出す
 *
 * **本体の読み取りの失敗（壊れた JSON・大きすぎる本体）は、ここに届く前に body-read-error.ts が返す**
 * （Nest がメッセージから例外を作り直すため、ここでは見分けられない）。
 */
@Catch()
export class ErrorResponseFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionsHandler');

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();

    if (isValidatorError(exception)) {
      if (exception.status >= 500) this.logger.error(exception.message, exception.stack);
      const body: ErrorResponse = {
        ...errorBodyForStatus(exception.status),
        ...(exception.status === 400
          ? { errors: exception.errors.map(({ path, message }) => ({ path, message })) }
          : {}),
      };
      response.status(exception.status).json(body);
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const given = exception.getResponse();
      // 5xx は、本体に何を載せて投げても internal_error にし、想定外の失敗としてログに残す。
      if (status >= 500) {
        this.logger.error(exception.message, exception.stack);
        response.status(status).json(errorBodyForStatus(status));
        return;
      }
      response.status(status).json(isErrorResponse(given) ? given : errorBodyForStatus(status));
      return;
    }

    const error = exception instanceof Error ? exception : new Error(String(exception));
    this.logger.error(error.message, error.stack);
    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json(INTERNAL);
  }
}
