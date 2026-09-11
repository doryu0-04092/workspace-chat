import {
  type CanActivate,
  createParamDecorator,
  type ExecutionContext,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { Request, Response } from 'express';
import type { ErrorResponse } from '../error-response';
import { PrismaService } from '../prisma.service';
import { INVALID_TOKEN } from './session.service';

const PUBLIC = Symbol('PUBLIC');

/**
 * 認証を要さないルートに付ける（コントローラかハンドラ）。**付けていないルートは、すべてアクセストークンを求める。**
 * REST の仕様で `security: []` を持つ操作と一致させる（access-token.test.ts が仕様を読んで確かめる）。
 */
export const Public = (): ClassDecorator & MethodDecorator => SetMetadata(PUBLIC, true);

/** トークンから解決した利用者。 */
export type AuthenticatedUser = { readonly id: string };

const AUTHENTICATED_USER = Symbol('AUTHENTICATED_USER');
type AuthenticatedRequest = Request & { [AUTHENTICATED_USER]?: AuthenticatedUser };

/** ハンドラの引数に、AccessTokenGuard が解決した利用者を渡す。 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedUser => {
    const user = context.switchToHttp().getRequest<AuthenticatedRequest>()[AUTHENTICATED_USER];
    // Public のルートで使うと、ガードが利用者を解決していない。
    if (user === undefined) throw new Error('CurrentUser は認証を要するルートでだけ使う');
    return user;
  },
);

const AUTHENTICATION_REQUIRED: ErrorResponse = {
  code: 'authentication_required',
  message: 'ログインしてください',
};

/** RFC 6750 2.1 の b64token。 */
const BEARER = /^Bearer +([A-Za-z0-9\-._~+/]+=*)$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * **すべてのルートに既定で掛かる**（AuthModule が APP_GUARD として登録する）。`@Public()` のルートだけを通す。
 *
 * - Authorization ヘッダーに Bearer のトークンが無い → 401（authentication_required。`WWW-Authenticate: Bearer`。
 *   RFC 6750 3.1「If the request lacks any authentication information … SHOULD NOT include an error code」）
 * - トークンの署名・期限・形が合わない、または利用者が退会済み → 401（invalid_token。`Bearer error="invalid_token"`）
 * - **退会済みはトークンから利用者を解決する時点で落とす**（機能一覧 1.4 の2段目。#90）。発行済みのアクセストークンは
 *   退会しても署名も期限も有効なままであり、ここで落とさないと書き込みが通る。問い合わせ側の `deletedAt IS NULL`（1段目）とは別に持つ
 *
 * 要求の検証（openapi-validation.ts のミドルウェア）はガードより前に走るため、入力が仕様に合わない要求はトークンの有無によらず 400 になる。
 */
@Injectable()
export class AccessTokenGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (isPublicRoute(this.reflector, context.getHandler(), context.getClass())) return true;

    const http = context.switchToHttp();
    const request = http.getRequest<AuthenticatedRequest>();
    const response = http.getResponse<Response>();

    const header = request.headers.authorization;
    if (header === undefined || !/^Bearer(\s|$)/i.test(header)) {
      response.setHeader('WWW-Authenticate', 'Bearer');
      throw new UnauthorizedException(AUTHENTICATION_REQUIRED);
    }

    const userId = await this.subject(BEARER.exec(header)?.[1]);
    const user =
      userId === undefined
        ? null
        : await this.prisma.user.findFirst({
            where: { id: userId, deletedAt: null },
            select: { id: true },
          });
    if (!user) {
      response.setHeader('WWW-Authenticate', 'Bearer error="invalid_token"');
      throw new UnauthorizedException(INVALID_TOKEN);
    }
    request[AUTHENTICATED_USER] = { id: user.id };
    return true;
  }

  /** 署名（HS256 だけ。AuthModule の verifyOptions）と期限を確かめ、`sub`（User.id）を返す。使えなければ undefined。 */
  private async subject(token: string | undefined): Promise<string | undefined> {
    if (token === undefined) return undefined;
    try {
      const { sub } = await this.jwt.verifyAsync<{ sub?: unknown }>(token);
      return typeof sub === 'string' && UUID.test(sub) ? sub : undefined;
    } catch {
      return undefined;
    }
  }
}

/** そのルートが `@Public()` か（ハンドラかコントローラのどちらかに付いていればよい）。 */
export function isPublicRoute(
  reflector: Reflector,
  handler: ReturnType<ExecutionContext['getHandler']>,
  controller: ReturnType<ExecutionContext['getClass']>,
): boolean {
  return reflector.getAllAndOverride<boolean | undefined>(PUBLIC, [handler, controller]) === true;
}
