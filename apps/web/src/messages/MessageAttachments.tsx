import { useEffect, useRef, useState } from 'react';
import type { Attachment } from './attachment-drafts';

/**
 * メッセージの添付（F-27。機能一覧 11.1）。**画像は表示し、動画は 30 秒の位置を表示し、それ以外はファイル名のリンクにする**
 * （テキスト系・pdf・Office・zip はアプリ内で描画しない。配信の Content-Disposition は attachment）。
 * 配信 URL（`/files/...`）の取得の認可は CloudFront の署名付き Cookie である（11.2）。
 */
export function MessageAttachments({ attachments }: { attachments: readonly Attachment[] }) {
  if (attachments.length === 0) return null;
  return (
    <ul className="mt-1 flex flex-wrap gap-2">
      {attachments.map((attachment) => (
        <li key={attachment.id}>
          {attachment.kind === 'image' ? (
            <img
              src={attachment.url}
              alt={attachment.fileName}
              loading="lazy"
              className="max-h-60 max-w-xs rounded border object-contain"
            />
          ) : attachment.kind === 'video' ? (
            <LazyVideo attachment={attachment} />
          ) : (
            <a href={attachment.url} className="text-sky-700 underline">
              {attachment.fileName}
              <span className="ml-1 text-xs text-slate-500">{`（${formatSize(attachment.size)}）`}</span>
            </a>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * 動画。**画面に入るまで `<video>` を作らない**（Intersection Observer で遅延読み込みする。機能一覧 11.1）——
 * `#t=30` の表示にはブラウザが 30 秒の位置までシークするため、画面外の分まで作るとスクロールのたびに読み込みが走る。
 * サムネイルは生成せず、`#t=30` で 30 秒の位置の映像を出す（要件定義書 3.5.2）。
 */
function LazyVideo({ attachment }: { attachment: Attachment }) {
  const placeholder = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const target = placeholder.current;
    if (visible || !target) return;
    // Intersection Observer を持たない環境では、遅延させずに出す（出さないと動画を見る手段が無い）
    if (typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setVisible(true);
        observer.disconnect();
      }
    });
    observer.observe(target);
    return () => observer.disconnect();
  }, [visible]);

  if (visible) {
    return (
      <video
        src={`${attachment.url}#t=30`}
        controls
        preload="metadata"
        aria-label={attachment.fileName}
        className="max-h-60 max-w-xs rounded border"
      />
    );
  }
  return (
    <div
      ref={placeholder}
      className="flex h-40 w-64 items-center justify-center rounded border bg-slate-100 text-sm text-slate-600"
    >
      {attachment.fileName}
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${bytes} バイト`;
}
