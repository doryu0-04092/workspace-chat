import { type components, MENTION_PATTERN } from '@workspace-chat/shared';
import { gfmAutolinkLiteralFromMarkdown } from 'mdast-util-gfm-autolink-literal';
import { gfmStrikethroughFromMarkdown } from 'mdast-util-gfm-strikethrough';
import { gfmAutolinkLiteral } from 'micromark-extension-gfm-autolink-literal';
import { gfmStrikethrough } from 'micromark-extension-gfm-strikethrough';
import Markdown from 'react-markdown';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import remarkBreaks from 'remark-breaks';

/**
 * 構文解析の段で読ませない構文（micromark の構文の名前）。**機能一覧 4.3 の記法に含まれないブロックと、生の HTML と定義と、素のメールアドレスの自動リンク**。
 * 山括弧で囲んだ URL とメールアドレス（CommonMark の `autolink`）は読ませる——F-14 のリンクの記法である（機能一覧 4.3）。
 * 読ませなければ、書いた文字はふつうの段落の文字として残る——改行も、引用・箇条書きの中の字下げの扱いも、解析器がそのまま受け持つ。
 * **その文字の中の URL は、自動リンクの構文に拾われてリンクになる**（機能一覧 4.3）。
 * 自動リンクの承認の範囲は URL であり、素のメールアドレスは含まない（提案・承認済・2026-09-13・依頼側。#385）。
 */
const DISABLED_CONSTRUCTS = [
  'headingAtx',
  'setextUnderline',
  'thematicBreak',
  'htmlFlow',
  'htmlText',
  'definition',
  'emailAutolink',
];

/**
 * URL の自動リンクの、構文木への変換（`www.`・`http://`・`https://` の構文の印をリンクの節にする）。
 * **踏むと壊れる: `transforms` を外したまま使う。** 同梱の `transforms` は、構文の印によらず本文の文字から
 * URL とメールアドレスを正規表現で探してリンクにするため、上でメールアドレスの構文を読ませなくても、メールアドレスがリンクになる。
 */
const urlAutolinkFromMarkdown = { ...gfmAutolinkLiteralFromMarkdown(), transforms: [] };

/**
 * 記法として解釈する mdast の節の種類（機能一覧 4.3 の太字・斜体・取り消し線・リンク・引用・箇条書き・インラインコード・コードブロックと、
 * それを入れる段落・文字・改行）。**ここに無い節は、書いた元の文字に置き換える**（`asWrittenText`）。
 * 上の構文を読ませないため、ここに届く集合の外の節は段落の中のもの（画像）だけである。
 */
const F14_NODE_TYPES = new Set([
  'root',
  'paragraph',
  'text',
  'break',
  'strong',
  'emphasis',
  'delete',
  'link',
  'blockquote',
  'list',
  'listItem',
  'inlineCode',
  'code',
]);

/** 描画する要素。上の節から作られるものだけで、描画の手前でもう一度絞る。 */
const ALLOWED_ELEMENTS = [
  'p',
  'br',
  'strong',
  'em',
  'del',
  'a',
  'blockquote',
  'ul',
  'ol',
  'li',
  'code',
  'pre',
  // メンション（F-20）。`mentionSpans` が作るものだけで、class は `MENTION_SCHEMA` が `mention` だけに絞る
  'span',
];

type MarkdownNode = {
  type: string;
  value?: string;
  position?: { start: { offset?: number }; end: { offset?: number } };
  children?: MarkdownNode[];
  data?: { hName?: string; hProperties?: Record<string, unknown> };
};

type Mention = components['schemas']['MessageMention'];

/**
 * 本文のメンション（F-20。機能一覧 9.1）。**応答の `mentions`（投稿時に解決した対象）に載ったユーザーID の `@` だけを**、
 * `@表示名`（退会した対象は `@削除済みの利用者`）の `span.mention` にする。載っていない `@` は書いた文字のまま残す（解決していない）。
 * 照合は大文字小文字によらない（1.1）。**リンクの文字と、コード（`inlineCode`・`code` は文字の節を持たない）の中は置き換えない**。
 * 表示名は文字の節として入れ、HTML として解釈しない。
 * **踏むと壊れる: `asWrittenText` より後に置く**——前に置くと、この節は F-14 の記法の外として書いた文字に戻される。
 */
function mentionSpans(mentions: readonly Mention[]) {
  const byLoginId = new Map(mentions.map((mention) => [mention.userId.toLowerCase(), mention]));
  const split = (text: string): MarkdownNode[] => {
    const nodes: MarkdownNode[] = [];
    let rest = 0;
    for (const match of text.matchAll(MENTION_PATTERN)) {
      const mention = byLoginId.get((match[1] ?? '').toLowerCase());
      if (!mention) continue;
      if (match.index > rest) nodes.push({ type: 'text', value: text.slice(rest, match.index) });
      nodes.push({
        type: 'mention',
        data: { hName: 'span', hProperties: { className: ['mention'] } },
        children: [{ type: 'text', value: `@${mention.user?.displayName ?? '削除済みの利用者'}` }],
      });
      rest = match.index + match[0].length;
    }
    if (rest === 0) return [{ type: 'text', value: text }];
    if (rest < text.length) nodes.push({ type: 'text', value: text.slice(rest) });
    return nodes;
  };
  return () => (tree: MarkdownNode) => {
    if (byLoginId.size === 0) return;
    const walk = (node: MarkdownNode) => {
      if (node.type === 'link' || !node.children) return;
      node.children = node.children.flatMap((child) => {
        if (child.type === 'text') return split(child.value ?? '');
        walk(child);
        return [child];
      });
    };
    walk(tree);
  };
}

/** 既定のスキーマに、メンションの `span` の class（`mention` だけ）を足す。ほかの要素と属性は既定のまま。 */
const MENTION_SCHEMA = {
  ...defaultSchema,
  attributes: { ...defaultSchema.attributes, span: [['className', 'mention']] },
};

/**
 * 構文解析を F-14 の記法に絞る。GFM のうち取り消し線と URL の自動リンクだけを積み（表・タスクリスト・脚注は読ませない）、
 * `DISABLED_CONSTRUCTS` を読ませない。remark-gfm と同じく、構文の拡張を processor の data に積む。
 */
function f14Syntax(this: unknown) {
  const data = (
    this as { data(): { micromarkExtensions?: unknown[]; fromMarkdownExtensions?: unknown[] } }
  ).data();
  (data.micromarkExtensions ??= []).push(gfmStrikethrough(), gfmAutolinkLiteral(), {
    disable: { null: DISABLED_CONSTRUCTS },
  });
  (data.fromMarkdownExtensions ??= []).push(
    gfmStrikethroughFromMarkdown(),
    urlAutolinkFromMarkdown,
  );
}

/** 行頭の引用の記号（前の空白・`>`・続く空白1つ）。 */
const QUOTE_MARKER = /^[ \t]*>[ \t]?/;

/**
 * 記法として解釈しない節を、書いた元の文字（本文のうち、その節の範囲）の `text` に置き換える。
 * **節が引用の中で行をまたぐときは、2行目以降の行頭から、引用の深さの数だけ引用の記号を除く**——
 * 本文の範囲には容器の記号も入るため、除かないと書いていない `>` が本文の文字に出る。
 */
function asWrittenText() {
  return (tree: MarkdownNode, file: { value: unknown }) => {
    const source = String(file.value);
    const walk = (node: MarkdownNode, quoteDepth: number) => {
      node.children?.forEach((child, index, siblings) => {
        if (F14_NODE_TYPES.has(child.type)) {
          walk(child, quoteDepth + (child.type === 'blockquote' ? 1 : 0));
          return;
        }
        const start = child.position?.start.offset;
        const end = child.position?.end.offset;
        siblings[index] = {
          type: 'text',
          value:
            start === undefined || end === undefined
              ? (child.value ?? '')
              : withoutQuoteMarkers(source.slice(start, end), quoteDepth),
        };
      });
    };
    walk(tree, 0);
  };
}

function withoutQuoteMarkers(written: string, quoteDepth: number): string {
  if (quoteDepth === 0) return written;
  return written
    .split('\n')
    .map((line, index) => {
      if (index === 0) return line;
      let rest = line;
      for (let depth = 0; depth < quoteDepth; depth += 1) rest = rest.replace(QUOTE_MARKER, '');
      return rest;
    })
    .join('\n');
}

/**
 * メッセージの本文を Markdown として描画する（F-14・F-15）。
 *
 * - **HTML 文字列を作らず、React の要素を直接組み立てる**（react-markdown）
 * - **記法として解釈するのは機能一覧 4.3 の記法だけで、それ以外は書いた文字のまま出す**（生の HTML も文字のまま出る）。
 *   文字のまま出したものの中の URL は自動リンクになる。画像の記法の中だけは、読んだ後に文字へ替えるためリンクにならない（4.3）
 * - **リンクの URL は http / https / mailto など安全なスキームと相対 URL だけを残す**（react-markdown の既定の `urlTransform`）。
 *   **`urlTransform` と下の rehype-sanitize の両方を残す**——片方だけを外しても `javascript:` の href は残らないが、両方を外すと通る
 * - プラグインが足した要素も、描画の前に rehype-sanitize で落とす（既定のスキーマに、メンションの `span` の class `mention` だけを足したもの。`MENTION_SCHEMA`）
 * - 応答の `mentions` に載ったユーザーID の `@` だけを `@表示名` の `span.mention` にする（F-20。`mentionSpans`。コードとリンクの文字の中は置き換えない）
 * - 段落の中の改行（入力欄の Enter）は改行の要素にする（remark-breaks。Markdown の既定は空白1つに畳む）
 * - **踏むと壊れる: `remarkPlugins` の並びを変えない。** `remarkBreaks` を `asWrittenText` より前に置くと、
 *   `asWrittenText` が後から作る文字の中の改行が、改行の要素にならない
 */
export function MessageBody({
  body,
  mentions = [],
}: {
  body: string;
  mentions?: readonly Mention[];
}) {
  return (
    <div className="break-words">
      <Markdown
        remarkPlugins={[f14Syntax, asWrittenText, remarkBreaks, mentionSpans(mentions)]}
        rehypePlugins={[[rehypeSanitize, MENTION_SCHEMA]]}
        allowedElements={ALLOWED_ELEMENTS}
        unwrapDisallowed
      >
        {body}
      </Markdown>
    </div>
  );
}
