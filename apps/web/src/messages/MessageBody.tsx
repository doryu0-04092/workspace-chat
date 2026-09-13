import Markdown from 'react-markdown';
import rehypeSanitize from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';

/**
 * 要素にする記法（機能一覧 4.3 の太字・斜体・取り消し線・リンク・引用・箇条書き・インラインコード・コードブロック）。
 * **ここに無い記法（見出し・表・画像など）は要素にせず、中の文字を残す**（`unwrapDisallowed`）。
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

type MarkdownNode = { type: string; children?: MarkdownNode[] };

/**
 * 本文の中の生の HTML（mdast の `html`）を、ただの文字（`text`）に替える。
 * react-markdown の既定は生の HTML を捨てるため、替えないと「`<div>` 要素」と書いた部分が黙って消える。
 */
function htmlAsText() {
  return (tree: MarkdownNode) => {
    const walk = (node: MarkdownNode) => {
      if (node.type === 'html') node.type = 'text';
      node.children?.forEach(walk);
    };
    walk(tree);
  };
}

/**
 * メッセージの本文を Markdown として描画する（F-14・F-15）。
 *
 * - **HTML 文字列を作らず、React の要素を直接組み立てる**（react-markdown）。本文の中の生の HTML は文字のまま出る（`htmlAsText`）
 * - **リンクの URL は http / https / mailto など安全なスキームと相対 URL だけを残す**（react-markdown の既定の `urlTransform`）。
 *   **`urlTransform` を差し替えない**——`javascript:` のリンクが通る
 * - プラグインが足した要素も、描画の前に rehype-sanitize の既定のスキーマで落とす
 * - 取り消し線は GFM の記法であり、remark-gfm が要る
 */
export function MessageBody({ body }: { body: string }) {
  return (
    <div className="break-words">
      <Markdown
        remarkPlugins={[remarkGfm, htmlAsText]}
        rehypePlugins={[rehypeSanitize]}
        allowedElements={ALLOWED_ELEMENTS}
        unwrapDisallowed
      >
        {body}
      </Markdown>
    </div>
  );
}
