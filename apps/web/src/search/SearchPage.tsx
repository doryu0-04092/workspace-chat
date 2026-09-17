import type { ReactNode } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { errorMessage } from '../api/client';
import { type SearchResult, useSearch } from './queries';
import { SearchForm } from './SearchForm';

type SearchMessage = SearchResult['messages'][number];
type SearchChannel = SearchResult['channels'][number];

function channelLabel(channel: SearchChannel): string {
  return `# ${channel.name}`;
}

/**
 * 検索の画面（F-30。機能一覧 12.1）。`?q=` の文字列で検索し、メッセージ・チャンネル・ユーザーのセクションに分けて出す。
 * **何を返すか（参加しているチャンネルだけ等）の判定は api にある**（CLAUDE.md 2）。画面は返ったものを並べるだけである。
 * DM（F-19）とファイル（F-27）のセクションは、api がそれぞれを返すようになったときに足す。
 */
export function SearchPage() {
  const { workspaceId = '' } = useParams();
  const [searchParams] = useSearchParams();
  const q = searchParams.get('q') ?? '';
  const search = useSearch(workspaceId, q);

  return (
    <main className="mx-auto max-w-xl p-6">
      <Link to={`/workspaces/${workspaceId}`} className="text-sm underline">
        チャンネルの一覧へ
      </Link>
      <h1 className="mt-2 text-2xl font-bold">検索</h1>
      {/* URL の q が変わったら入力欄も合わせる（入力欄は自分の状態を持つため、作り直す） */}
      <SearchForm key={q} workspaceId={workspaceId} initial={q} />
      {search.fetchStatus === 'fetching' && !search.data && (
        <p role="status" className="mt-4 text-slate-600">
          検索しています…
        </p>
      )}
      {search.isError && (
        <p role="alert" className="mt-4 text-red-700">
          検索できませんでした。{errorMessage(search.error)}
        </p>
      )}
      {search.data && <Results workspaceId={workspaceId} result={search.data} />}
    </main>
  );
}

function Results({ workspaceId, result }: { workspaceId: string; result: SearchResult }) {
  return (
    <>
      <Section
        title="メッセージ"
        empty="当たるメッセージはありません。"
        count={result.messages.length}
      >
        {result.messages.map((message) => (
          <li key={message.id}>
            <MessageHit workspaceId={workspaceId} message={message} />
          </li>
        ))}
      </Section>
      <Section
        title="チャンネル"
        empty="当たるチャンネルはありません。"
        count={result.channels.length}
      >
        {result.channels.map((channel) => (
          <li key={channel.id} className="flex items-baseline gap-2">
            {/* **参加していないチャンネルの画面は開けない**ため、参加の操作があるワークスペースの画面へ移る */}
            <Link
              to={
                channel.joined
                  ? `/workspaces/${workspaceId}/channels/${channel.id}`
                  : `/workspaces/${workspaceId}`
              }
              className="underline"
            >
              {channelLabel(channel)}
            </Link>
            {channel.visibility === 'PRIVATE' && <span className="text-sm">（プライベート）</span>}
            {channel.archived && <span className="text-sm text-slate-600">（アーカイブ済み）</span>}
            {!channel.joined && <span className="text-sm text-slate-600">（未参加）</span>}
          </li>
        ))}
      </Section>
      <Section title="ユーザー" empty="当たるユーザーはありません。" count={result.users.length}>
        {result.users.map((user) => (
          <li key={user.id}>{`${user.displayName}（@${user.userId}）`}</li>
        ))}
      </Section>
    </>
  );
}

function Section({
  title,
  empty,
  count,
  children,
}: {
  title: string;
  empty: string;
  count: number;
  children: ReactNode;
}) {
  return (
    <section aria-label={title} className="mt-6">
      <h2 className="font-bold">{title}</h2>
      {count === 0 ? (
        <p className="mt-1 text-sm text-slate-600">{empty}</p>
      ) : (
        <ul className="mt-2 flex flex-col gap-3">{children}</ul>
      )}
    </section>
  );
}

/**
 * 当たったメッセージ。**本文は文字として出す**（Markdown として描かない。一部だけを描くと記法が途中で切れるため、検索の結果では描かない）。
 * 返信なら、親のスレッドを開いた状態でチャンネルの画面へ移る（チャンネルの画面の `?thread=`）。
 */
function MessageHit({ workspaceId, message }: { workspaceId: string; message: SearchMessage }) {
  const channelPath = `/workspaces/${workspaceId}/channels/${message.channel.id}`;
  return (
    <article className="rounded border px-3 py-2">
      <header className="flex flex-wrap items-baseline gap-2 text-sm">
        <Link
          to={
            message.parentId === null
              ? channelPath
              : `${channelPath}?thread=${encodeURIComponent(message.parentId)}`
          }
          className="text-sky-700 underline"
        >
          {`${channelLabel(message.channel)} ${message.parentId === null ? 'で開く' : 'のスレッドで開く'}`}
        </Link>
        {message.channel.archived && <span className="text-slate-600">（アーカイブ済み）</span>}
        <span className="font-bold">{message.author?.displayName ?? '削除済みの利用者'}</span>
        <time dateTime={message.createdAt} className="text-slate-500">
          {new Date(message.createdAt).toLocaleString('ja-JP')}
        </time>
      </header>
      <p className="mt-1 whitespace-pre-wrap break-words">{message.body}</p>
    </article>
  );
}
