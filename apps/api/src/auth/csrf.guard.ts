import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
} from '@nestjs/common';
import type { components } from '@workspace-chat/shared';
import type { Request } from 'express';
import { API_CONFIG, type ApiConfig } from '../config/api-config';
import type { ErrorResponse } from '../error-response';
import { isSameOriginRequest } from './same-origin';

/**
 * Cookie を使う要求に求める独自のヘッダーの値。**型を仕様（`components.parameters.RequestedBy` の enum）から取る**——
 * 仕様の値だけを変えると、ここが型検査で落ちる（仕様と実装の2箇所で値が食い違わない）。
 */
export const REQUESTED_BY: components['parameters']['RequestedBy'] = 'workspace-chat';

const CSRF_REJECTED: ErrorResponse = {
  code: 'csrf_rejected',
  message: 'この要求は受け付けられません',
};

/**
 * Cookie でリフレッシュトークンを受け取るエンドポイント（/api/auth/refresh・/api/auth/logout）の CSRF の対処
 * （機能一覧 1.2・要件定義書 4.3 の ② と ③。① は Cookie の SameSite=Strict）。
 *
 * **独自のヘッダーは仕様（openapi-validation.ts）も求めるが、ここでも確かめる**——仕様からヘッダーの宣言が外れても、
 * この2つのエンドポイントの守りが外れないようにする。
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(@Inject(API_CONFIG) private readonly config: ApiConfig) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    if (
      request.headers['x-requested-by'] !== REQUESTED_BY ||
      !isSameOriginRequest(request.headers, this.config.webOrigin)
    ) {
      throw new ForbiddenException(CSRF_REJECTED);
    }
    return true;
  }
}
