import Markdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import rehypeSanitize from 'rehype-sanitize';

/**
 * 要素にする記法（機能一覧 4.3 の太字・斜体・取り消し線・リンク・引用・箇条書き・インラインコード・コードブロック）と段落・改行。
 * **ここに無い記法（見出し・表など）は要素にせず、中の文字を残す**（`unwrapDisallowed`）。
 */
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
  alt?: string | null;
  url?: string;
  children?: MarkdownNode[];
};

/**
 * 描かない記法のうち、中身が子ではなく節そのものにあるものを、ただの文字（mdast の `text`）に替える。
 * 替えないと、`unwrapDisallowed` でも中身が残らず、書いた部分が黙って消える。
 * - 生の HTML（`html`）は、その文字のまま（react-markdown の既定は生の HTML を捨てる）
 * - 画像（`image` / `imageReference`）は代わりの文字（alt）、無ければ URL（alt は子ではなく属性にある）
 */
function asPlainText() {
  return (tree: MarkdownNode) => {
    const walk = (node: MarkdownNode) => {
      if (node.type === 'html') node.type = 'text';
      else if (node.type === 'image' || node.type === 'imageReference') {
        node.value = node.alt || node.url || '';
        node.type = 'text';
      }
      node.children?.forEach(walk);
    };
    walk(tree);
  };
}

/**
 * メッセージの本文を Markdown として描画する（F-14・F-15）。
 *
 * - **HTML 文字列を作らず、React の要素を直接組み立てる**（react-markdown）。本文の中の生の HTML は文字のまま出る（`asPlainText`）
 * - **リンクの URL は http / https / mailto など安全なスキームと相対 URL だけを残す**（react-markdown の既定の `urlTransform`）。
 *   **`urlTransform` を差し替えない**——`javascript:` のリンクが通る
 * - プラグインが足した要素も、描画の前に rehype-sanitize の既定のスキーマで落とす
 * - 取り消し線は GFM の記法であり、remark-gfm が要る
 * - 段落の中の改行（入力欄の Enter）は改行の要素にする（remark-breaks。Markdown の既定は空白1つに畳む）
 */
export function MessageBody({ body }: { body: string }) {
  return (
    <div className="break-words">
      <Markdown
        remarkPlugins={[remarkGfm, asPlainText, remarkBreaks]}
        rehypePlugins={[rehypeSanitize]}
        allowedElements={ALLOWED_ELEMENTS}
        unwrapDisallowed
      >
        {body}
      </Markdown>
    </div>
  );
}
