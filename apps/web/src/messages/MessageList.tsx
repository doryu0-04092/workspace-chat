import { useEffect, useRef } from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import { errorMessage } from '../api/client';
import { MessageBody } from './MessageBody';
import { type Message, useMessages } from './queries';

/**
 * Virtuoso の `firstItemIndex` の起点。
 * **踏むと壊れる: 古いメッセージを上に足したら、足した件数だけ `firstItemIndex` を減らす。** 減らさないと、
 * 上に足した分だけ表示中のメッセージが下へずれる（react-virtuoso の `firstItemIndex`「decrease the value this property
 * in combination with `data` or `totalCount` to prepend items to the top of the list」。機能一覧 4.1「スクロール位置が飛ばない」）。
 * 正の数でなければならないため、遡れる件数より十分大きくとる。
 */
const FIRST_INDEX = 1_000_000_000;

type ListContext = {
  hasOlder: boolean;
  loadingOlder: boolean;
  olderFailed: unknown;
  loadOlder: () => void;
};

/** チャンネルのメッセージの一覧（F-11・F-12）。上が古く下が新しい。古いメッセージは先頭のボタンで遡って読む。 */
export function MessageList({
  workspaceId,
  channelId,
}: {
  workspaceId: string;
  channelId: string;
}) {
  const messages = useMessages(workspaceId, channelId);

  if (!messages.data) {
    return messages.isError ? (
      <p role="alert" className="text-red-700">
        メッセージを読み込めませんでした。{errorMessage(messages.error)}
      </p>
    ) : (
      <p role="status" className="text-slate-600">
        読み込み中…
      </p>
    );
  }

  const { pages } = messages.data;
  // api は新しい順に返す。画面は上を古くするため、ページの並びもページの中も逆にする
  const items = [...pages].reverse().flatMap((page) => [...page.messages].reverse());
  if (items.length === 0) return <p className="text-slate-600">まだメッセージはありません。</p>;
  const olderCount = pages.slice(1).reduce((sum, page) => sum + page.messages.length, 0);

  return (
    <LoadedList
      items={items}
      firstItemIndex={FIRST_INDEX - olderCount}
      context={{
        hasOlder: messages.hasNextPage,
        loadingOlder: messages.isFetchingNextPage,
        olderFailed: messages.isFetchNextPageError ? messages.error : null,
        loadOlder: () => void messages.fetchNextPage(),
      }}
    />
  );
}

/** 読み込めた一覧。開いたときは最新（いちばん下）を見せる。 */
function LoadedList({
  items,
  firstItemIndex,
  context,
}: {
  items: Message[];
  firstItemIndex: number;
  context: ListContext;
}) {
  const list = useRef<VirtuosoHandle>(null);
  // 開いたときに1回だけ最新へ移る。`initialTopMostItemIndex` は使わない——VirtuosoMockContext の下では 0 以外を渡すと行が1つも描かれず、検査できない
  useEffect(() => {
    list.current?.scrollToIndex({ index: 'LAST' });
  }, []);

  return (
    <Virtuoso<Message, ListContext>
      ref={list}
      className="h-[60vh]"
      data={items}
      firstItemIndex={firstItemIndex}
      computeItemKey={(_, message) => message.id}
      followOutput="auto"
      context={context}
      components={{ Header: OlderMessages }}
      itemContent={(_, message) => <MessageItem message={message} />}
    />
  );
}

function OlderMessages({ context }: { context: ListContext }) {
  return (
    <div className="flex flex-col items-center gap-1 py-2">
      {context.olderFailed !== null && (
        <p role="alert" className="text-red-700">
          古いメッセージを読み込めませんでした。{errorMessage(context.olderFailed)}
        </p>
      )}
      {context.hasOlder && (
        <button
          type="button"
          className="rounded border px-2 py-0.5 text-sm disabled:opacity-50"
          disabled={context.loadingOlder}
          onClick={context.loadOlder}
        >
          古いメッセージを読み込む
        </button>
      )}
    </div>
  );
}

/** 1件のメッセージ。退会した投稿者は「削除済みの利用者」（機能一覧 1.5）、削除済みは本文を置き換える（4.2）。 */
function MessageItem({ message }: { message: Message }) {
  return (
    <article className="px-2 py-2">
      <header className="flex items-baseline gap-2 text-sm">
        <span className="font-bold">{message.author?.displayName ?? '削除済みの利用者'}</span>
        <time dateTime={message.createdAt} className="text-slate-500">
          {new Date(message.createdAt).toLocaleString('ja-JP')}
        </time>
        {message.editedAt !== null && message.body !== null && (
          <span className="text-slate-500">（編集済み）</span>
        )}
      </header>
      {message.body === null ? (
        <p className="text-slate-500">このメッセージは削除されました</p>
      ) : (
        <MessageBody body={message.body} />
      )}
    </article>
  );
}
