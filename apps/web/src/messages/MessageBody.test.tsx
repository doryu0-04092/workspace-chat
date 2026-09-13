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

    it('画像は描画せず（外部への読み込みを起こさない）、書いた文字（代わりの文字と URL）を残す', () => {
      const withAlt = renderBody('![画像の説明](https://example.com/a.png)');
      expect(withAlt.querySelector('img')).toBeNull();
      expect(withAlt.textContent).toContain('画像の説明');

      const withoutAlt = renderBody('![](https://example.com/b.png)');
      expect(withoutAlt.querySelector('img')).toBeNull();
      expect(withoutAlt.textContent).toContain('https://example.com/b.png');
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

    it('段落の中の改行（入力欄の Enter の改行）は、改行の要素になる', () => {
      const paragraph = renderBody('一行目\n二行目').querySelector('p');
      expect(paragraph?.querySelector('br')).not.toBeNull();
      expect(paragraph?.textContent).toContain('一行目');
      expect(paragraph?.textContent).toContain('二行目');
    });

    it('URL をそのまま書いても、リンクにせず文字のまま残す（GFM の自動リンクは F-14 の記法に含まない）', () => {
      const container = renderBody('https://example.com/x を見て');
      expect(container.querySelector('a')).toBeNull();
      expect(container.textContent).toContain('https://example.com/x を見て');
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

  describe('対応しない記法は、記法として解釈せず、書いた文字のまま残す', () => {
    it.each([
      ['見出し', '# 見出し', 'h1, h2, h3, h4, h5, h6', '# 見出し'],
      ['表', '| a | b |\n| - | - |\n| 1 | 2 |', 'table, td, th', '| 1 | 2 |'],
      ['水平線', '上\n\n---\n\n下', 'hr', '---'],
      ['タスクリスト', '- [x] 買い物', 'input', '[x] 買い物'],
      [
        '参照形式の画像と定義',
        '![][logo]\n\n[logo]: https://example.com/logo.png',
        'img',
        '[logo]: https://example.com/logo.png',
      ],
      ['参照形式のリンク', '[例][ref]\n\n[ref]: https://example.com/', 'a', '[例][ref]'],
      ['脚注', '本文[^1]\n\n[^1]: 注', 'sup, section', '[^1]: 注'],
    ])('%s', (_name, body, selector, text) => {
      const container = renderBody(body);
      expect(container.querySelector(selector)).toBeNull();
      expect(container.textContent).toContain(text);
    });

    it('書いていない文字を足さない（脚注の見出しなど）', () => {
      const container = renderBody('本文[^1]\n\n[^1]: 注');
      expect(container.textContent).not.toContain('Footnotes');
    });
  });
});
