import { describe, expect, it } from 'vitest';
import { errorKind } from './error-kind';

function withCode(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

describe('ログに書く失敗の種類', () => {
  it('code があれば、代わりに何を書く指定でも code だけを書く（メッセージの接続先を残さない）', () => {
    const error = withCode('connect ECONNREFUSED 127.0.0.1:6379', 'ECONNREFUSED');

    expect(errorKind(error, 'name')).toBe('ECONNREFUSED');
    expect(errorKind(error, 'message')).toBe('ECONNREFUSED');
  });

  it('code が無ければ、指定に従って名前かメッセージを書く', () => {
    const error = new TypeError('Connection is closed.');

    expect(errorKind(error, 'name')).toBe('TypeError');
    expect(errorKind(error, 'message')).toBe('Connection is closed.');
  });

  it('Error でなければ unknown と書く', () => {
    expect(errorKind('失敗', 'name')).toBe('unknown');
    expect(errorKind({ code: 'X', message: 'y' }, 'message')).toBe('unknown');
  });
});
