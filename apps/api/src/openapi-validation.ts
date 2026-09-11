import { dirname, join } from 'node:path';
import { type ArgumentsHost, Catch, type NestMiddleware } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import type { components } from '@workspace-chat/shared';
import type { NextFunction, Request, Response } from 'express';
import * as OpenApiValidator from 'express-openapi-validator';

type ErrorResponse = components['schemas']['ErrorResponse'];

/**
 * REST の仕様（唯一の正。要件定義書 4.7）。共有パッケージの位置から引く。
 * **共有パッケージの `index.ts` からは出さない**——web も同じパッケージを読み、`node:path` を持ち込めないため。
 */
export const OPENAPI_SPEC_PATH = join(
  dirname(require.resolve('@workspace-chat/shared/package.json')),
  'openapi',
  'openapi.yaml',
);

/**
 * 要求を仕様どおりか確かめる（express-openapi-validator）。**ハンドラより前に走る。**
 *
 * - **仕様に無いパス・メソッドは通さない**（`ignoreUndocumented` は既定の false のまま）。
 *   仕様に載せずにエンドポイントを足すと、ここで落ちる
 * - **`fileUploader: false`**——multer を使わせない。サーバーは multipart を受け取らない
 *   （添付はブラウザから S3 へ直接 PUT する）。multer の advisory を通している前提
 *   （scripts/audit-allowlist.json の until）を、この依存から崩さないため
 * - 応答の検証（`validateResponses`）はしない。応答の形は型（`paths`）で縛る
 *
 * **Nest のミドルウェアとして載せ、失敗を例外として投げ直す。** 素の `next(err)` のままだと、
 * 失敗が Nest の例外フィルタを通らず、Express の既定の応答（HTML）になる。
 */
const validators = OpenApiValidator.middleware({
  apiSpec: OPENAPI_SPEC_PATH,
  validateRequests: true,
  validateResponses: false,
  fileUploader: false,
});

export class OpenApiValidationMiddleware implements NestMiddleware {
  async use(req: Request, res: Response, next: NextFunction): Promise<void> {
    for (const validator of validators) {
      await new Promise<void>((resolve, reject) => {
        void validator(req, res, (error?: unknown) => (error ? reject(error) : resolve()));
      });
    }
    next();
  }
}

const VALIDATOR_ERRORS = Object.values(OpenApiValidator.error);

function isValidatorError(
  exception: unknown,
): exception is InstanceType<(typeof VALIDATOR_ERRORS)[number]> {
  return VALIDATOR_ERRORS.some((ErrorClass) => exception instanceof ErrorClass);
}

const CODES: Record<number, { code: string; message: string }> = {
  400: { code: 'validation_failed', message: '入力が仕様に合いません' },
  404: { code: 'not_found', message: '見つかりません' },
  405: { code: 'method_not_allowed', message: 'このメソッドは使えません' },
  413: { code: 'payload_too_large', message: '要求が大きすぎます' },
  415: { code: 'unsupported_media_type', message: 'この形式の本体は受け付けません' },
};

/**
 * 検証の失敗を ErrorResponse の形で返す。それ以外の例外は Nest の既定の扱いに渡す。
 *
 * **送られた値を応答に載せない。** 返すのは落ちた箇所（`path`）と規則の説明（`message`）だけである。
 * パスワードの検証で落ちたときに、送られたパスワードが応答やログに出ないようにするため。
 */
@Catch()
export class OpenApiValidationErrorFilter extends BaseExceptionFilter {
  override catch(exception: unknown, host: ArgumentsHost): void {
    if (!isValidatorError(exception)) {
      super.catch(exception, host);
      return;
    }
    const known = CODES[exception.status] ?? {
      code: 'request_rejected',
      message: '要求を受け付けられません',
    };
    const body: ErrorResponse = {
      ...known,
      ...(exception.status === 400
        ? { errors: exception.errors.map(({ path, message }) => ({ path, message })) }
        : {}),
    };
    host.switchToHttp().getResponse<Response>().status(exception.status).json(body);
  }
}
