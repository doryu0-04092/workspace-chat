import { type FormEvent, useState } from 'react';
import { errorMessage } from '../api/client';
import { usePostMessage } from './queries';

/**
 * チャンネルへの投稿（F-11）。Enter は改行であり、送信は送信のボタンで行う（改行は本文の改行として描画する。機能一覧 4.3）。
 * 空・空白だけではボタンを押せない（api も 400 で断る。機能一覧 4.1）。失敗したら理由を出し、入力を残す。
 */
export function PostMessageForm({
  workspaceId,
  channelId,
}: {
  workspaceId: string;
  channelId: string;
}) {
  const post = usePostMessage(workspaceId, channelId);
  const [body, setBody] = useState('');

  function submit(event: FormEvent) {
    event.preventDefault();
    post.mutate(body, { onSuccess: () => setBody('') });
  }

  return (
    <form className="mt-4 flex flex-col gap-2" onSubmit={submit}>
      <label htmlFor="message-body">メッセージ</label>
      <textarea
        id="message-body"
        className="rounded border px-2 py-1"
        rows={3}
        value={body}
        onChange={(event) => setBody(event.target.value)}
      />
      {post.isError && (
        <p role="alert" className="text-red-700">
          {errorMessage(post.error)}
        </p>
      )}
      <button
        className="self-start rounded bg-slate-800 px-3 py-2 text-white disabled:opacity-50"
        disabled={post.isPending || body.trim() === ''}
      >
        送信する
      </button>
    </form>
  );
}
