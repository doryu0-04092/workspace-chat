import { type ArgumentsHost, HttpException, Logger, NotFoundException } from '@nestjs/common';
import * as OpenApiValidator from 'express-openapi-validator';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BearerUnauthorizedException,
  ErrorResponseFilter,
  RetryAfterException,
  errorBodyForStatus,
} from './error-response';

/** フィルタに渡す ArgumentsHost の代わり。応答の状態コードと本体を控える。 */
function fakeHost(): {
  host: ArgumentsHost;
  sent: { status?: number; body?: unknown; headers: Record<string, string> };
} {
  const sent: { status?: number; body?: unknown; headers: Record<string, string> } = {
    headers: {},
  };
  const response = {
    setHeader(name: string, value: string) {
      sent.headers[name] = value;
      return this;
    },
    status(code: number) {
      sent.status = code;
      return this;
    },
    json(body: unknown) {
      sent.body = body;
      return this;
    },
  };
  const host = {
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => ({ ip: '198.51.100.7', originalUrl: '/api/auth/login' }),
    }),
  } as unknown as ArgumentsHost;
  return { host, sent };
}

// 5xx は、どの経路で届いても internal_error を返し、例外のメッセージを載せず、error でログに出す（PR #253 第2巡）。
// 経路は3つある: 要求の検証の失敗・HttpException・それ以外（想定外の失敗）。
describe('例外フィルタの 5xx', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ['code を持たない 5xx の HttpException', new HttpException('secret-looking detail', 503)],
    [
      'code を持つ本体で投げた 5xx の HttpException',
      new HttpException({ code: 'user_id_taken', message: 'secret-looking detail' }, 500),
    ],
    [
      '要求の検証の 500（express-openapi-validator の InternalServerError）',
      new OpenApiValidator.error.InternalServerError({
        path: '/x',
        message: 'secret-looking detail',
      }),
    ],
    ['HttpException でない例外', new Error('secret-looking detail')],
  ])('%s は internal_error を返し、ログに error で出す', (_label, exception) => {
    const logged = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { host, sent } = fakeHost();
    new ErrorResponseFilter().catch(exception, host);

    expect(sent.status).toBeGreaterThanOrEqual(500);
    expect((sent.body as { code: string }).code).toBe('internal_error');
    expect(JSON.stringify(sent.body)).not.toContain('secret-looking');
    expect(logged).toHaveBeenCalledTimes(1);
  });

  it('code を持つ本体で投げた 4xx の HttpException は、その本体のまま返し、ログに出さない', () => {
    const logged = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { host, sent } = fakeHost();
    const body = { code: 'user_id_taken', message: 'このユーザーID は使えません' };
    new ErrorResponseFilter().catch(new HttpException(body, 409), host);

    expect(sent.status).toBe(409);
    expect(sent.body).toEqual(body);
    expect(logged).not.toHaveBeenCalled();
  });
});

// 機能一覧 1.4「404 の応答の本体が、存在を漏らさない」「揃えるのは横断的な例外処理であり、各ハンドラは個別に文言を書かない」。
// ハンドラが個別の本体で 404 を投げても、ここで揃える。
describe('例外フィルタの 404', () => {
  it.each([
    [
      '存在を認める文言の本体',
      new NotFoundException({ code: 'not_found', message: '権限がありません' }),
    ],
    ['別の code の本体', new HttpException({ code: 'request_rejected', message: 'x' }, 404)],
    ['文字列のメッセージ', new NotFoundException('チャンネルはあるが参加していない')],
  ])('%s で投げても、本体は「見つかりません」に揃う', (_label, exception) => {
    const { host, sent } = fakeHost();
    new ErrorResponseFilter().catch(exception, host);

    expect(sent.status).toBe(404);
    expect(sent.body).toEqual({ code: 'not_found', message: '見つかりません' });
  });
});

// アカウント単位の制限（ログイン・リカバリーコードの照合）は、どの経路から投げても同じ形で返す（PR #275 第1巡）。
// Bearer のアクセストークンで守るルートの 401 は、入口（ガード）で投げても、入口の後（サービス）で投げても同じ形で返す（#285）。
describe('例外フィルタの BearerUnauthorizedException', () => {
  it.each([
    ['authentication_required', 'ログインしてください', 'Bearer'],
    ['invalid_token', 'ログインし直してください', 'Bearer error="invalid_token"'],
  ] as const)(
    '%s の 401 に WWW-Authenticate: %s を付け、本体をそのまま返す',
    (code, message, challenge) => {
      const { host, sent } = fakeHost();
      new ErrorResponseFilter().catch(new BearerUnauthorizedException({ code, message }), host);

      expect(sent.status).toBe(401);
      expect(sent.body).toEqual({ code, message });
      expect(sent.headers['WWW-Authenticate']).toBe(challenge);
    },
  );
});

// HTTP のレート制限の超過は、投げる経路（発信元単位のガードの 429・アカウント単位の RetryAfterException）によらず、
// フィルタの1箇所で rate_limit_exceeded として記録する（#270 第3巡）。
describe('例外フィルタの 429 の記録', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ['RetryAfterException（アカウント単位）', new RetryAfterException(7), 'account'],
    [
      'HttpException の 429（発信元単位のガード）',
      new HttpException(errorBodyForStatus(429), 429),
      'ip',
    ],
  ])(
    '%s を rate_limit_exceeded として、制限の種類・発信元・パスとともに warn で記録する',
    (_name, exception, limit) => {
      const warned = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const { host } = fakeHost();
      new ErrorResponseFilter().catch(exception, host);
      expect(warned).toHaveBeenCalledWith({
        event: 'rate_limit_exceeded',
        limit,
        ip: '198.51.100.7',
        path: '/api/auth/login',
      });
    },
  );

  it('429 以外は記録しない', () => {
    const warned = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { host } = fakeHost();
    new ErrorResponseFilter().catch(new NotFoundException(), host);
    expect(warned).not.toHaveBeenCalled();
  });
});

describe('例外フィルタの RetryAfterException', () => {
  it('429（too_many_requests）と、秒の Retry-After を返す', () => {
    const { host, sent } = fakeHost();
    new ErrorResponseFilter().catch(new RetryAfterException(7), host);

    expect(sent.status).toBe(429);
    expect((sent.body as { code: string }).code).toBe('too_many_requests');
    expect(sent.headers['Retry-After']).toBe('7');
  });
});
