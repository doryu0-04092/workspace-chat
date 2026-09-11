import type { NextFunction, Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { bodyReadErrorHandler } from './body-read-error';

/** 応答の状態コードと本体を控える、Express の Response の代わり。 */
function fakeResponse(): { res: Response; sent: { status?: number; body?: unknown } } {
  const sent: { status?: number; body?: unknown } = {};
  const res = {
    status(code: number) {
      sent.status = code;
      return this;
    },
    json(body: unknown) {
      sent.body = body;
      return this;
    },
  } as unknown as Response;
  return { res, sent };
}

/** body-parser / raw-body が投げる失敗の形（http-errors。status と type を持つ）。 */
function bodyError(status: number, type: string): Error {
  return Object.assign(new Error('secret-looking message with the body'), { status, type });
}

// 状態コードと code の対応は、仕様（openapi.yaml）がその状態に宣言した値に揃える（PR #253 第1巡）。
// 本体の読み取りの 400 だけは、入力の検証（validation_failed）と分けて invalid_body にする。
describe('本体の読み取りの失敗の応答', () => {
  it.each([
    [400, 'entity.parse.failed', 'invalid_body'],
    [400, 'request.aborted', 'invalid_body'],
    [413, 'entity.too.large', 'payload_too_large'],
    [413, 'parameters.too.many', 'payload_too_large'],
    [415, 'charset.unsupported', 'unsupported_media_type'],
    [415, 'encoding.unsupported', 'unsupported_media_type'],
    [500, 'stream.not.readable', 'internal_error'],
  ])('%d（%s）は %s を返し、例外のメッセージを載せない', (status, type, code) => {
    const { res, sent } = fakeResponse();
    const next = vi.fn();
    bodyReadErrorHandler(bodyError(status, type), {} as Request, res, next as NextFunction);

    expect(sent.status).toBe(status);
    expect((sent.body as { code: string }).code).toBe(code);
    expect(JSON.stringify(sent.body)).not.toContain('secret-looking');
    expect(next).not.toHaveBeenCalled();
  });

  it('本体の読み取りの失敗でない例外は、次へ渡す', () => {
    const { res, sent } = fakeResponse();
    const next = vi.fn();
    const other = new Error('other');
    bodyReadErrorHandler(other, {} as Request, res, next as NextFunction);

    expect(next).toHaveBeenCalledWith(other);
    expect(sent.status).toBeUndefined();
  });
});
