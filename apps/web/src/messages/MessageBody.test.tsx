import { render } from '@testing-library/react';
import rehypeSanitize from 'rehype-sanitize';
import { describe, expect, it } from 'vitest';
import { MessageBody, SANITIZE_SCHEMA } from './MessageBody';
import type { Message } from './queries';

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
      expect(container.querySelector('script, img, iframe, b')).toBeNull();
      // 文字のまま出した HTML の中の URL は自動リンクになりうる（#385）。そのリンクも http / https だけである
      for (const link of container.querySelectorAll('a')) {
        expect(link.getAttribute('href') ?? '').toMatch(/^https?:\/\//);
      }
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

    it('画像は描画せず（外部への読み込みを起こさない）、書いた文字のまま残す', () => {
      const withAlt = renderBody('![画像の説明](https://example.com/a.png)');
      expect(withAlt.querySelector('img')).toBeNull();
      expect(withAlt.textContent).toContain('![画像の説明](https://example.com/a.png)');

      const withoutAlt = renderBody('![](https://example.com/b.png)');
      expect(withoutAlt.querySelector('img')).toBeNull();
      expect(withoutAlt.textContent).toContain('![](https://example.com/b.png)');
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

    // 自動リンク（提案・承認済・2026-09-13・依頼側。#385）。承認の範囲は URL であり、素のメールアドレスは含まない。
    it.each([
      ['https', 'https://example.com/x を見て', 'https://example.com/x', 'https://example.com/x'],
      [
        'http',
        'http://example.com/a?b=1 です',
        'http://example.com/a?b=1',
        'http://example.com/a?b=1',
      ],
      ['www. で始まる', 'www.example.com を見て', 'http://www.example.com', 'www.example.com'],
    ])('URL をそのまま書くと、その URL へのリンクになる（%s）', (_name, body, href, text) => {
      const container = renderBody(body);
      const links = container.querySelectorAll('a');
      expect(links).toHaveLength(1);
      expect(links[0]?.getAttribute('href')).toBe(href);
      expect(links[0]?.textContent).toBe(text);
      expect(container.textContent).toBe(body);
    });

    it.each([
      ['メールアドレス', '<alice@example.com>', 'mailto:alice@example.com'],
      ['URL', '<https://example.com/a>', 'https://example.com/a'],
    ])(
      '山括弧で囲んだ%sは、Markdown の自動リンクの記法としてリンクになる（素の形とは別）',
      (_name, body, href) => {
        const links = [...renderBody(body).querySelectorAll('a')].map((link) =>
          link.getAttribute('href'),
        );
        expect(links).toEqual([href]);
      },
    );

    it('素のメールアドレスはリンクにせず、文字のまま残す（承認の範囲は URL）', () => {
      const container = renderBody('alice@example.com に連絡する');
      expect(container.querySelector('a')).toBeNull();
      expect(container.textContent).toBe('alice@example.com に連絡する');
    });

    it.each([
      ['javascript', 'javascript:alert(1) を押す'],
      ['data', 'data:text/html;base64,PHNjcmlwdD4= を開く'],
      ['vbscript', 'vbscript:msgbox(1) を押す'],
    ])('危険なスキームは、そのまま書いてもリンクにならない（%s）', (_name, body) => {
      const container = renderBody(body);
      expect(container.querySelector('a')).toBeNull();
      expect(container.textContent).toBe(body);
    });

    it('コードの中の URL はリンクにせず、記法のリンクの中の URL を重ねてリンクにしない', () => {
      const inCode = renderBody('`https://example.com/code`');
      expect(inCode.querySelector('a')).toBeNull();
      expect(inCode.querySelector('code')?.textContent).toBe('https://example.com/code');

      const inLink = renderBody('[https://example.com/a](https://example.com/b)');
      const links = inLink.querySelectorAll('a');
      expect(links).toHaveLength(1);
      expect(links[0]?.getAttribute('href')).toBe('https://example.com/b');
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

  // 機能一覧 13.1（F-32）: バッククォート3つで囲んだ範囲の色付けと、言語指定。#581。
  // CLAUDE.md「必ずテストを書く箇所」: 色付けを足しても Markdown が HTML として解釈されないこと（XSS）。
  describe('コードブロックの色付け（F-32）', () => {
    it('言語を指定したコードブロックは、字句を色付けの class を持つ span に分ける（書いた文字は変えない）', () => {
      const container = renderBody("```ts\nconst a = 'x';\n```");

      const code = container.querySelector('pre > code');
      expect(code?.classList.contains('hljs')).toBe(true);
      expect(code?.classList.contains('language-ts')).toBe(true);
      expect(code?.querySelector('span.hljs-keyword')?.textContent).toBe('const');
      expect(code?.querySelector('span.hljs-string')?.textContent).toBe("'x'");
      expect(code?.textContent).toBe("const a = 'x';\n");
    });

    it('複数の段の字句（`title.class_` など）も、色付けの class を残す', () => {
      const code = renderBody('```js\nclass Foo extends Bar {}\n```').querySelector('pre > code');

      const title = code?.querySelector('span.hljs-title');
      expect(title?.classList.contains('class_')).toBe(true);
    });

    it.each([
      ['言語の指定が無い', '```\nconst a = 1;\n```'],
      ['登録されていない言語を指定した', '```nosuchlanguage\nconst a = 1;\n```'],
    ])('%sコードブロックは色付けせず、書いた文字のまま出す', (_name, body) => {
      const code = renderBody(body).querySelector('pre > code');

      expect(code?.querySelector('span')).toBeNull();
      expect(code?.textContent).toBe('const a = 1;\n');
    });

    it('インラインコードは色付けしない', () => {
      const code = renderBody('`const a = 1`').querySelector('code');

      expect(code?.querySelector('span')).toBeNull();
      expect(code?.textContent).toBe('const a = 1');
    });

    it('色付けした HTML のコードも、要素にならず書いた文字のまま出す', () => {
      const source = '<script>alert(1)</script>\n<img src=x onerror="alert(1)">';
      const container = renderBody(`\`\`\`html\n${source}\n\`\`\``);

      expect(container.querySelector('script, img')).toBeNull();
      expect(container.querySelector('pre > code span.hljs-tag')).not.toBeNull();
      expect(container.querySelector('pre > code')?.textContent).toBe(`${source}\n`);
    });

    it('言語の指定に書いた HTML は、要素にも属性にもならない', () => {
      const container = renderBody('```"><img src=x onerror=alert(1)>\nconst a = 1;\n```');

      expect(container.querySelector('img')).toBeNull();
      const code = container.querySelector('pre > code');
      expect(code?.getAttribute('onerror')).toBeNull();
      expect(code?.textContent).toBe('const a = 1;\n');
    });

    // 描画の手前の sanitize は、色付けのプラグインが足した要素も通す（MessageBody.tsx の SANITIZE_SCHEMA）。
    // **許可に足すのは色付けの class の名前だけ**——それより広げると、プラグインが属性や class を混ぜたときに素通りする。
    it('sanitize は、色付けとメンションの class だけを残し、ほかの class・属性・要素を落とす', () => {
      const tree = {
        type: 'root',
        children: [
          {
            type: 'element',
            tagName: 'pre',
            properties: {},
            children: [
              {
                type: 'element',
                tagName: 'code',
                properties: {
                  className: ['hljs', 'language-ts', 'evil'],
                  style: 'color:red',
                  onClick: 'alert(1)',
                },
                children: [
                  {
                    type: 'element',
                    tagName: 'span',
                    properties: {
                      className: ['hljs-title', 'class_', 'mention', 'evil', 'hljs-<x>', 'x_y'],
                      style: 'background:url(https://example.com/)',
                      onMouseOver: 'alert(1)',
                    },
                    children: [{ type: 'text', value: 'Foo' }],
                  },
                  {
                    type: 'element',
                    tagName: 'script',
                    properties: {},
                    children: [{ type: 'text', value: 'alert(1)' }],
                  },
                ],
              },
            ],
          },
        ],
      };
      type Tree = Parameters<ReturnType<typeof rehypeSanitize>>[0];

      const sanitized = rehypeSanitize(SANITIZE_SCHEMA)(tree as unknown as Tree);

      const code = (sanitized.children[0] as unknown as (typeof tree.children)[0]).children[0];
      expect(code?.properties).toEqual({ className: ['hljs', 'language-ts'] });
      expect(code?.children.map((child) => child.tagName)).toEqual(['span']);
      expect(code?.children[0]?.properties).toEqual({
        className: ['hljs-title', 'class_', 'mention'],
      });
    });
  });

  // 機能一覧 9.1（F-20）: 本文のメンションは、応答の mentions（投稿時に解決した対象）に載っているユーザーID だけを表示名で出す。#494。
  describe('メンション（F-20）', () => {
    type Mention = Message['mentions'][number];
    /** テストで使う利用者（実在の人物ではない）。 */
    const ALICE = {
      id: '01920000-0000-7000-8000-000000000001',
      userId: 'Alice_1',
      displayName: 'アリス',
      avatarUrl: null,
    };

    function renderWith(body: string, mentions: Mention[]): HTMLElement {
      return render(<MessageBody body={body} mentions={mentions} />).container;
    }

    it('対象のユーザーID の `@` を、大文字小文字によらず `@表示名` に置き換える', () => {
      const container = renderWith('こんにちは @alice_1 さん', [
        { userId: 'Alice_1', user: ALICE },
      ]);

      const mentions = container.querySelectorAll('span.mention');
      expect([...mentions].map((mention) => mention.textContent)).toEqual(['@アリス']);
      expect(container.textContent).toBe('こんにちは @アリス さん');
    });

    it('退会した対象は「@削除済みの利用者」と出す', () => {
      const container = renderWith('@Alice_1 へ', [{ userId: 'Alice_1', user: null }]);

      expect(container.querySelector('span.mention')?.textContent).toBe('@削除済みの利用者');
    });

    it('対象に無い `@` と、英数字に続く `@` は書いた文字のまま残す', () => {
      const body = '@nobody と mail@alice_1';
      const container = renderWith(body, [{ userId: 'Alice_1', user: ALICE }]);

      expect(container.querySelector('span.mention')).toBeNull();
      expect(container.textContent).toBe(body);
    });

    it('インラインコード・コードブロック・リンクの文字の中の `@` は置き換えない', () => {
      const mentions = [{ userId: 'Alice_1', user: ALICE }];
      const inCode = renderWith('`@alice_1`', mentions);
      expect(inCode.querySelector('span.mention')).toBeNull();
      expect(inCode.querySelector('code')?.textContent).toBe('@alice_1');

      const inBlock = renderWith('```\n@alice_1\n```', mentions);
      expect(inBlock.querySelector('span.mention')).toBeNull();

      const inLink = renderWith('[@alice_1](https://example.com/)', mentions);
      expect(inLink.querySelector('span.mention')).toBeNull();
      expect(inLink.querySelector('a')?.textContent).toBe('@alice_1');
    });

    it('本文に書いた `<span class="mention">` は要素にならず、書いた文字のまま残す', () => {
      // 描画してよい要素に span を、sanitize のスキーマに class `mention` を足したため、
      // 守っているのは「生の HTML を構文解析で読ませない」ことだけになった（DISABLED_CONSTRUCTS の htmlText / htmlFlow）。
      // 壊れると、届いていない相手へのメンションを本物と同じ見た目で書けてしまう（機能一覧 4.3・9.1）。
      const body = '<span class="mention">@alice_1</span> と書く';

      const container = renderWith(body, []);

      expect(container.querySelector('span')).toBeNull();
      expect(container.textContent).toBe(body);
    });

    it('表示名は文字として出し、HTML として解釈しない', () => {
      const container = renderWith('@alice_1', [
        { userId: 'Alice_1', user: { ...ALICE, displayName: '<img src=x onerror="alert(1)">' } },
      ]);

      expect(container.querySelector('img')).toBeNull();
      expect(container.querySelector('span.mention')?.textContent).toBe(
        '@<img src=x onerror="alert(1)">',
      );
    });
  });

  describe('対応しない記法は、記法として解釈せず、書いた文字のまま残す', () => {
    it.each([
      ['見出し', '# 見出し', 'h1, h2, h3, h4, h5, h6', '# 見出し'],
      ['下線で書く見出し', '見出し\n===', 'h1, h2', '==='],
      ['表', '| a | b |\n| - | - |\n| 1 | 2 |', 'table, td, th', '| 1 | 2 |'],
      ['水平線', '上\n\n---\n\n下', 'hr', '---'],
      ['タスクリスト', '- [x] 買い物', 'input', '[x] 買い物'],
      [
        '参照形式の画像と定義',
        '![][logo]\n\n[logo]: https://example.com/logo.png',
        'img',
        '[logo]: https://example.com/logo.png',
      ],
      ['脚注', '本文[^1]\n\n[^1]: 注', 'sup, section', '[^1]: 注'],
    ])('%s', (_name, body, selector, text) => {
      const container = renderBody(body);
      expect(container.querySelector(selector)).toBeNull();
      expect(container.textContent).toContain(text);
    });

    it('画像の中の URL はリンクにしない（画像は読んだ後に書いた文字へ替える。#385）', () => {
      const container = renderBody('![代わり](https://example.com/a.png)');
      expect(container.querySelector('a')).toBeNull();
      expect(container.textContent).toContain('![代わり](https://example.com/a.png)');
    });

    it.each([
      ['定義', '[ref]: https://example.com/def', 'https://example.com/def'],
      ['見出し', '# https://example.com/h', 'https://example.com/h'],
    ])('構文として読ませない%sの中の URL はリンクになる（#385）', (_name, body, href) => {
      const links = [...renderBody(body).querySelectorAll('a')].map((link) =>
        link.getAttribute('href'),
      );
      expect(links).toEqual([href]);
    });

    it('参照形式のリンク（参照の側はリンクにしない。定義の行の URL は自動リンクになりうる。#385）', () => {
      const container = renderBody('[例][ref]\n\n[ref]: https://example.com/');
      const texts = [...container.querySelectorAll('a')].map((link) => link.textContent);
      expect(texts).not.toContain('例');
      expect(container.textContent).toContain('[例][ref]');
      expect(container.textContent).toContain('[ref]: https://example.com/');
    });

    it.each([
      ['見出し', '# 今日の予定\n## 午前'],
      ['下線で書く見出し', '見出し\n===\n次\n==='],
      ['水平線', '***\n***'],
      ['定義', '[a]: https://example.com/a\n[b]: https://example.com/b'],
    ])(
      '対応しない記法（%s）が続けて書かれても、書いた改行をすべて改行として残す',
      (_name, body) => {
        const container = renderBody(body);
        const lines = body.split('\n');
        expect(container.querySelectorAll('br')).toHaveLength(lines.length - 1);
        for (const line of lines) expect(container.textContent).toContain(line);
      },
    );

    it('引用の中で行をまたぐ生の HTML のタグも、引用の記号を本文の文字に足さない', () => {
      const quote = renderBody('> <span\n> title="x">').querySelector('blockquote');
      expect(quote).not.toBeNull();
      expect(quote?.textContent).toContain('title="x">');
      expect(quote?.textContent).not.toContain('> title');
    });

    it('引用の中の複数行の生の HTML は、引用の記号を本文の文字に足さない', () => {
      const quote = renderBody('> <div>\n> こんにちは\n> </div>').querySelector('blockquote');
      expect(quote).not.toBeNull();
      expect(quote?.textContent).toContain('<div>');
      expect(quote?.textContent).toContain('こんにちは');
      // 書いた `<div>` 自体は `>` を含むため、行頭に引用の記号が付いた形が出ないことを見る。
      expect(quote?.textContent).not.toContain('> こんにちは');
      expect(quote?.textContent).not.toContain('> </div>');
    });

    // 画像は構文を読ませたまま、書いた元の文字に替える唯一の節である（MessageBody.tsx の asWrittenText）。
    it.each([
      ['引用', '> ![画像の\n> 説明](https://example.com/x.png)', 'blockquote'],
      [
        '入れ子の引用',
        '> > ![画像の\n> > 説明](https://example.com/x.png)',
        'blockquote blockquote',
      ],
      ['箇条書き', '- ![画像の\n  説明](https://example.com/x.png)', 'li'],
    ])(
      '%sの中で行をまたぐ画像も、容器の記号と字下げを本文の文字に足さない',
      (_name, body, selector) => {
        const container = renderBody(body).querySelector(selector);
        expect(container).not.toBeNull();
        expect(container?.textContent).toContain('![画像の');
        expect(container?.textContent).toContain('説明](https://example.com/x.png)');
        expect(container?.textContent).not.toMatch(/>\s*説明/);
        expect(container?.textContent).not.toMatch(/[ \t]説明/);
      },
    );

    it('書いていない文字を足さない（脚注の見出しなど）', () => {
      const container = renderBody('本文[^1]\n\n[^1]: 注');
      expect(container.textContent).not.toContain('Footnotes');
    });
  });
});

// 機能一覧 4.3。記法の解釈を固定する検査の不足（#383・#387・#391・#429）。
describe('メッセージの本文の描画（解釈を固定する検査）', () => {
  it.each([
    ['mailto', '[メール](mailto:a@example.com)', 'mailto:a@example.com'],
    ['相対 URL', '[画面](/workspaces/x)', '/workspaces/x'],
    ['山括弧で囲んだ URL', '<https://example.com/a>', 'https://example.com/a'],
  ])('%s のリンクは href を残す（#387）', (_name, body, href) => {
    const links = [...renderBody(body).querySelectorAll('a')].map((link) =>
      link.getAttribute('href'),
    );
    expect(links).toEqual([href]);
  });

  it('生の HTML の中の URL もリンクになる（#429）', () => {
    const links = [
      ...renderBody('<iframe src="https://example.com/x"></iframe>').querySelectorAll('a'),
    ];
    expect(links).toHaveLength(1);
    expect(links[0]?.getAttribute('href')).toMatch(/^https:\/\/example\.com\/x/);
  });

  it('書いた文字に戻す節（画像）の中の改行も、改行の要素にする（remarkPlugins の並び。#383）', () => {
    const container = renderBody('![あ\nい](https://example.com/x.png)');
    expect(container.querySelectorAll('br')).toHaveLength(1);
    expect(container.textContent).toContain('![あ');
  });

  it('箇条書きの中の複数行の生の HTML は、字下げを本文の文字に足さない（#391）', () => {
    const item = renderBody('- <div>\n  あ\n  </div>').querySelector('li');
    expect(item?.textContent).toBe('<div>\nあ\n</div>');
  });
});
