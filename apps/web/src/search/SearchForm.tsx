import { type FormEvent, useState } from 'react';
import { useNavigate } from 'react-router';
import { isSearchable } from './queries';

/**
 * 検索の入力（F-30。機能一覧 12.1）。送ると検索の画面 `/workspaces/:workspaceId/search?q=` へ移る。
 * `from:@ユーザーID`・`in:#チャンネル名` はそのまま送る（分けるのは api）。空白だけは送らない。
 */
export function SearchForm({
  workspaceId,
  initial = '',
}: {
  workspaceId: string;
  initial?: string;
}) {
  const navigate = useNavigate();
  const [q, setQ] = useState(initial);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!isSearchable(q)) return;
    navigate(`/workspaces/${workspaceId}/search?q=${encodeURIComponent(q)}`);
  }

  return (
    <form role="search" className="mt-4 flex gap-2" onSubmit={submit}>
      <input
        type="search"
        aria-label="検索"
        placeholder="検索（from:@ユーザーID in:#チャンネル名）"
        className="min-w-0 flex-1 rounded border px-2 py-1"
        value={q}
        onChange={(event) => setQ(event.target.value)}
      />
      <button className="rounded bg-slate-800 px-3 py-1 text-white">検索する</button>
    </form>
  );
}
