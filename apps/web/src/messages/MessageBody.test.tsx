import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MessageBody } from './MessageBody';

function renderBody(body: string): HTMLElement {
  return render(<MessageBody body={body} />).container;
}

// src の中のソース（テストを除く）。dangerouslySetInnerHTML を使っていないことを見る。
const SOURCES = import.meta.glob<string>(['../**/*.{ts,tsx}', '!../**/*.test.{ts,tsx}'], {
  query: '?raw',
  import: 'default',
  eager: true,
});

// 機能一覧 4.3（F-14・F-15）。CLAUDE.md「必ずテストを書く箇所」: Markdown が HTML として解釈されないこと（XSS）。
describe('メッセージの本文の描画（F-14・F-15）', () => {
  describe('XSS', () => {
    it.each([
      '<script>alert(1)</script>',
      '<img src=x onerror="alert(1)">',
      '<iframe src="https://example.com"></iframe>',
      '<a href="javascript:alert(1)">押す</a>',
      '<b onmouseover="alert(1)">太字</b>',
    ])('生の HTML は要素にならず、文字のまま表示する（%s）', (body) => {
      const container = renderBody(body);
      expect(container.querySelector('script, img, iframe, a, b')).toBeNull();
      expect(container.textContent).toContain(body);
    });

    it.each([
      'javascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      'vbscript:msgbox(1)',
      'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
    ])('危険なスキームのリンクは href を持たない（%s）', (url) => {
      const container = renderBody(`[押す](${url})`);
      expect(container.textContent).toContain('押す');
      for (const link of container.querySelectorAll('a')) {
        expect(link.getAttribute('href') ?? '').not.toMatch(/^\s*(javascript|vbscript|data):/i);
      }
    });

    it('画像は描画しない（F-14 の記法に含まない。外部への読み込みを起こさない）', () => {
      const container = renderBody('![画像](https://example.com/a.png)');
      expect(container.querySelector('img')).toBeNull();
    });

    it('src のソースに dangerouslySetInnerHTML を使う箇所が無い', () => {
      expect(Object.keys(SOURCES)).toContain('./MessageBody.tsx');
      const offenders = Object.entries(SOURCES)
        .filter(([, source]) => source.includes('dangerouslySetInnerHTML'))
        .map(([path]) => path);
      expect(offenders).toEqual([]);
    });
  });

  describe('対応する記法', () => {
    it.each([
      ['太字', '**強い**', 'strong', '強い'],
      ['斜体', '*傾き*', 'em', '傾き'],
      ['取り消し線', '~~消す~~', 'del', '消す'],
      ['引用', '> 引く', 'blockquote', '引く'],
      ['箇条書き', '- 一つ目\n- 二つ目', 'ul > li', '一つ目'],
      ['番号付きの箇条書き', '1. 一つ目\n2. 二つ目', 'ol > li', '一つ目'],
      ['インラインコード', '`const a = 1`', 'code', 'const a = 1'],
      ['コードブロック', '```\nconst a = 1\n```', 'pre > code', 'const a = 1'],
    ])('%s', (_name, body, selector, text) => {
      const element = renderBody(body).querySelector(selector);
      expect(element).not.toBeNull();
      expect(element?.textContent).toContain(text);
    });

    it('リンクは http / https の URL を href に持つ', () => {
      const link = renderBody('[例](https://example.com/path?q=1)').querySelector('a');
      expect(link?.getAttribute('href')).toBe('https://example.com/path?q=1');
      expect(link?.textContent).toBe('例');
    });

    it('コードブロックの中の Markdown と HTML は解釈しない', () => {
      const container = renderBody('```\n**太字ではない** <b>要素ではない</b>\n```');
      expect(container.querySelector('strong, b')).toBeNull();
      expect(container.querySelector('pre')?.textContent).toContain(
        '**太字ではない** <b>要素ではない</b>',
      );
    });
  });

  describe('対応しない記法は、要素にせず中の文字を残す', () => {
    it.each([
      ['見出し', '# 見出し', 'h1', '見出し'],
      ['表', '| a | b |\n| - | - |\n| 1 | 2 |', 'table', '1'],
    ])('%s', (_name, body, selector, text) => {
      const container = renderBody(body);
      expect(container.querySelector(selector)).toBeNull();
      expect(container.textContent).toContain(text);
    });
  });
});
