import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import type { components } from '@workspace-chat/shared';
import type { Request, Response } from 'express';
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

/** 429 と `Retry-After`（秒）を返す例外。**ヘッダーは ErrorResponseFilter が付ける**（投げる経路ごとに付けない）。 */
export class RetryAfterException extends HttpException {
  constructor(readonly retryAfterSeconds: number) {
    super(errorBodyForStatus(HttpStatus.TOO_MANY_REQUESTS), HttpStatus.TOO_MANY_REQUESTS);
  }
}

/**
 * 401 の本体のうち、`code` を `authentication_required` / `invalid_token` の2つに限ったもの（RFC 6750 3.1 の2つの形に対応する）。
 * Bearer の経路（AccessTokenGuard・プロフィール）と Cookie の経路（リフレッシュ・ログアウトの `INVALID_TOKEN`）の両方が使う。
 */
export type BearerErrorResponse = ErrorResponse & {
  code: 'authentication_required' | 'invalid_token';
};

/**
 * Bearer のアクセストークンで守るルートの 401。**`WWW-Authenticate` は ErrorResponseFilter が付ける**（投げる経路ごとに付けない。
 * RFC 6750 3）。入口（AccessTokenGuard）で投げても、入口の後（退会したばかりの利用者をサービスが引けなかった）で投げても同じ形になる。
 * トークンが無い → `Bearer`（RFC 6750 3.1「SHOULD NOT include an error code」）、使えない → `Bearer error="invalid_token"`。
 */
export class BearerUnauthorizedException extends UnauthorizedException {
  readonly challenge: string;

  constructor(body: BearerErrorResponse) {
    super(body);
    this.challenge =
      body.code === 'authentication_required' ? 'Bearer' : 'Bearer error="invalid_token"';
  }
}

/**
 * **すべての例外を ErrorResponse で返す**（横断的な例外処理で揃える。機能一覧 1.4）。
 *
 * - 要求の検証の失敗（express-openapi-validator）→ 状態コードごとの本体。400 には落ちた箇所（`path`）と
 *   規則の説明（`message`）だけを `errors` に載せる。**送られた値は載せない**
 * - `code` を持つ本体で投げた HttpException（登録の 403・409、レート制限の 429 など）→ その本体のまま。
 *   **ただし 404 だけは、何を載せても状態コードの本体にする**（機能一覧 1.4。ハンドラごとの文言で存在を認めさせない）
 * - `code` を持たない HttpException（前置き /api の外の Nest の既定の 404 など）→ 状態コードごとの本体。
 *   **例外のメッセージは載せない**（Nest の既定の 404 は「Cannot GET /…」とパスを述べる）
 * - それ以外（想定外の失敗）→ 500（internal_error）。**例外のメッセージを応答に載せない**
 *   （Prisma のメッセージは呼び出し箇所のソースの抜き出しを含む）。ログには今までどおり error で出す
 * - **429 は、投げた経路（発信元単位のガード・アカウント単位の RetryAfterException）によらず、ここで `rate_limit_exceeded` として記録する**
 *   （発信元とパス。決定・2026-09-12・依頼側。#270。1件では鳴らさない——閾値は Terraform 側。要件定義書 4.2）。
 *   **制限の種類を `limit` に載せる**（`account`: RetryAfterException、`ip`: それ以外の 429＝発信元単位のガード。#324）。
 *   ログイン・リカバリーコードの照合では2種類が同じパスで出るため、パスでは分けられない。**踏むと壊れる: 429 を投げる経路を足したら、ここで種類を分ける**
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
      // 404 は、投げた側が何を載せても「見つかりません」にする（機能一覧 1.4。本体の文言で存在を認めない）。
      const body = status !== 404 && isErrorResponse(given) ? given : errorBodyForStatus(status);
      if (status === HttpStatus.TOO_MANY_REQUESTS) {
        const request = host.switchToHttp().getRequest<Request>();
        this.logger.warn({
          event: 'rate_limit_exceeded',
          limit: exception instanceof RetryAfterException ? 'account' : 'ip',
          ip: request.ip,
          path: request.originalUrl,
        });
      }
      if (exception instanceof RetryAfterException) {
        response.setHeader('Retry-After', String(exception.retryAfterSeconds));
      }
      if (exception instanceof BearerUnauthorizedException) {
        response.setHeader('WWW-Authenticate', exception.challenge);
      }
      response.status(status).json(body);
      return;
    }

    const error = exception instanceof Error ? exception : new Error(String(exception));
    this.logger.error(error.message, error.stack);
    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json(INTERNAL);
  }
}
