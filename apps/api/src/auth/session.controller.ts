import {
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { paths } from '@workspace-chat/shared';
import { parse } from 'cookie';
import type { Request, Response } from 'express';
import { Public } from './access-token.guard';
import { Throttle } from '@nestjs/throttler';
import { RateLimitGuard } from '../rate-limit/rate-limit.module';
import { CsrfGuard } from './csrf.guard';
import { SessionService } from './session.service';
import {
  REFRESH_TOKEN_CLEAR_COOKIE_OPTIONS,
  REFRESH_TOKEN_COOKIE,
  REFRESH_TOKEN_COOKIE_OPTIONS,
} from './session-tokens';

type RefreshResponse =
  paths['/auth/refresh']['post']['responses'][200]['content']['application/json'];

function readRefreshToken(request: Request): string | undefined {
  const header = request.headers.cookie;
  return header === undefined ? undefined : parse(header)[REFRESH_TOKEN_COOKIE];
}

/**
 * リフレッシュとログアウト（F-02）。Cookie でリフレッシュトークンを受け取る唯一の2つであり、CSRF の対処を掛ける（CsrfGuard）。
 * 本体は受け取らない。
 *
 * **発信元単位で 15 分に 60 回**（決定・2026-09-12・依頼側。#270。サーバーの負荷の歯止め。正規の利用者は 15 分に1回のリフレッシュで足りる）。
 * ガードは CSRF の判定より先に数える（403 も 401 も1回として数える）。超過の記録は ErrorResponseFilter（429 全体の1箇所。ガードには書かない）。
 */
@Public()
@Controller('auth')
@UseGuards(RateLimitGuard, CsrfGuard)
@Throttle({ default: { limit: 60, ttl: 15 * 60 * 1000 } })
export class SessionController {
  constructor(private readonly sessions: SessionService) {}

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(
    @Req() request: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<RefreshResponse> {
    try {
      const tokens = await this.sessions.rotate(readRefreshToken(request));
      res.cookie(REFRESH_TOKEN_COOKIE, tokens.refreshToken, REFRESH_TOKEN_COOKIE_OPTIONS);
      return { accessToken: tokens.accessToken, tokenType: 'Bearer', expiresIn: tokens.expiresIn };
    } catch (error) {
      // 使えないトークンを持ち続けさせない。
      if (error instanceof UnauthorizedException) {
        res.clearCookie(REFRESH_TOKEN_COOKIE, REFRESH_TOKEN_CLEAR_COOKIE_OPTIONS);
      }
      throw error;
    }
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(@Req() request: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    await this.sessions.end(readRefreshToken(request));
    res.clearCookie(REFRESH_TOKEN_COOKIE, REFRESH_TOKEN_CLEAR_COOKIE_OPTIONS);
  }
}
