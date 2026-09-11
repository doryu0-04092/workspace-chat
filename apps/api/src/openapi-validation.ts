import { dirname, join } from 'node:path';
import type { NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import * as OpenApiValidator from 'express-openapi-validator';

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
 * 失敗は error-response.ts の ErrorResponseFilter が ErrorResponse にする。
 *
 * **Nest のミドルウェアとして載せ、失敗を例外として投げ直す。** 素の `next(err)` のままだと、
 * 失敗が Nest の例外フィルタを通らず、Express の既定の応答（HTML）になる。
 */
const validators = OpenApiValidator.middleware({
  apiSpec: OPENAPI_SPEC_PATH,
  validateRequests: true,
  validateResponses: false,
  fileUploader: false,
  // 認証は auth/access-token.guard.ts の1箇所で判定する。ここで Bearer の有無を見させると、401 の本体と
  // WWW-Authenticate が仕様（Unauthorized）と違う形になる。
  validateSecurity: false,
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
