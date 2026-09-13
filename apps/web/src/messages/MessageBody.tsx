import { gfmStrikethroughFromMarkdown } from 'mdast-util-gfm-strikethrough';
import { gfmStrikethrough } from 'micromark-extension-gfm-strikethrough';
import Markdown from 'react-markdown';
import rehypeSanitize from 'rehype-sanitize';
import remarkBreaks from 'remark-breaks';

/**
 * 記法として解釈する mdast の節の種類（機能一覧 4.3 の太字・斜体・取り消し線・リンク・引用・箇条書き・インラインコード・コードブロックと、
 * それを入れる段落・文字・改行）。**ここに無い節は、書いた元の文字に置き換える**（`asWrittenText`）——
 * 見出し・水平線・画像・参照形式のリンクと定義・生の HTML など、種類を列挙しなくても文字のまま残る。
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
];

type MarkdownNode = {
  type: string;
  value?: string;
  position?: { start: { offset?: number }; end: { offset?: number } };
  children?: MarkdownNode[];
};

/**
 * GFM のうち、取り消し線だけを解釈させる。**表・タスクリスト・脚注・URL の自動リンクは記法として読ませない**
 * （F-14 の記法に含まれない）。remark-gfm と同じく、構文の拡張を processor の data に積む。
 */
function strikethrough(this: unknown) {
  const data = (
    this as { data(): { micromarkExtensions?: unknown[]; fromMarkdownExtensions?: unknown[] } }
  ).data();
  (data.micromarkExtensions ??= []).push(gfmStrikethrough());
  (data.fromMarkdownExtensions ??= []).push(gfmStrikethroughFromMarkdown());
}

/** 記法として解釈しない節を、書いた元の文字（本文のうち、その節の範囲）の `text` に置き換える。 */
function asWrittenText() {
  return (tree: MarkdownNode, file: { value: unknown }) => {
    const source = String(file.value);
    const walk = (node: MarkdownNode) => {
      node.children?.forEach((child, index, siblings) => {
        if (F14_NODE_TYPES.has(child.type)) {
          walk(child);
          return;
        }
        const start = child.position?.start.offset;
        const end = child.position?.end.offset;
        siblings[index] = {
          type: 'text',
          value:
            start === undefined || end === undefined
              ? (child.value ?? '')
              : source.slice(start, end),
        };
      });
    };
    walk(tree);
  };
}

/**
 * メッセージの本文を Markdown として描画する（F-14・F-15）。
 *
 * - **HTML 文字列を作らず、React の要素を直接組み立てる**（react-markdown）
 * - **記法として解釈するのは機能一覧 4.3 の記法だけで、それ以外は書いた文字のまま出す**（生の HTML も文字のまま出る）
 * - **リンクの URL は http / https / mailto など安全なスキームと相対 URL だけを残す**（react-markdown の既定の `urlTransform`）。
 *   **`urlTransform` を差し替えない**——`javascript:` のリンクが通る
 * - プラグインが足した要素も、描画の前に rehype-sanitize の既定のスキーマで落とす
 * - 段落の中の改行（入力欄の Enter）は改行の要素にする（remark-breaks。Markdown の既定は空白1つに畳む）
 * - **踏むと壊れる: `remarkPlugins` の並びを変えない。** `remarkBreaks` を `asWrittenText` より前に置くと、
 *   `asWrittenText` が後から作る文字（表・複数行の生の HTML など）の中の改行が、改行の要素にならない
 */
export function MessageBody({ body }: { body: string }) {
  return (
    <div className="break-words">
      <Markdown
        remarkPlugins={[strikethrough, asWrittenText, remarkBreaks]}
        rehypePlugins={[rehypeSanitize]}
        allowedElements={ALLOWED_ELEMENTS}
        unwrapDisallowed
      >
        {body}
      </Markdown>
    </div>
  );
}
