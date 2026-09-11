import { describe, expect, it } from 'vitest';
import { isSameOriginRequest } from './same-origin';

const WEB = 'https://chat.example.com';

// 要件定義書 4.3 の CSRF の対処 ③「Origin / Sec-Fetch-Site の検証（未送信時は Referer にフォールバック）」。
// OWASP CSRF Prevention Cheat Sheet: Sec-Fetch-Site を主に見て、無ければ Origin、それも無ければ Referer。どれも無ければ拒否する。
describe('同じ origin からの要求か（isSameOriginRequest）', () => {
  it.each([
    ['Sec-Fetch-Site が same-origin', { 'sec-fetch-site': 'same-origin' }],
    ['Sec-Fetch-Site が無く、Origin が web の origin', { origin: WEB }],
    [
      'Sec-Fetch-Site も Origin も無く、Referer が web の origin の下',
      { referer: `${WEB}/channels/1` },
    ],
  ])('%s なら通す', (_label, headers) => {
    expect(isSameOriginRequest(headers, WEB)).toBe(true);
  });

  it.each([
    ['Sec-Fetch-Site が cross-site', { 'sec-fetch-site': 'cross-site', origin: WEB }],
    [
      'Sec-Fetch-Site が same-site（別のサブドメイン）',
      { 'sec-fetch-site': 'same-site', origin: WEB },
    ],
    ['Sec-Fetch-Site が none（アドレス欄から直接）', { 'sec-fetch-site': 'none', origin: WEB }],
    ['Origin が別の origin', { origin: 'https://evil.example.com' }],
    ['Origin が null', { origin: 'null' }],
    ['Origin がポート違い', { origin: 'https://chat.example.com:8443' }],
    ['Referer が別の origin', { referer: 'https://evil.example.com/chat.example.com' }],
    ['Referer が壊れている', { referer: 'not a url' }],
    ['どれも無い', {}],
  ])('%s なら拒否する', (_label, headers) => {
    expect(isSameOriginRequest(headers, WEB)).toBe(false);
  });

  // Sec-Fetch-Site を送るブラウザでは、それを主に見る。Origin が一致していても same-origin 以外は通さない。
  it('Sec-Fetch-Site があれば、Origin より優先する', () => {
    expect(isSameOriginRequest({ 'sec-fetch-site': 'cross-site', origin: WEB }, WEB)).toBe(false);
    expect(
      isSameOriginRequest(
        { 'sec-fetch-site': 'same-origin', origin: 'https://evil.example.com' },
        WEB,
      ),
    ).toBe(true);
  });

  // Origin を送っているなら Referer には戻らない（Origin が別の origin なのに Referer で通すと、Referer を細工された要求が通る）。
  it('Origin があれば、Referer は見ない', () => {
    expect(
      isSameOriginRequest({ origin: 'https://evil.example.com', referer: `${WEB}/` }, WEB),
    ).toBe(false);
  });
});
