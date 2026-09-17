import { useEffect, useRef, useState } from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import { errorMessage } from '../api/client';
import { useSession } from '../auth/session-context';
import { EditMessageForm, MessageActions } from './MessageActions';
import { MessageAttachments } from './MessageAttachments';
import { MessageBody } from './MessageBody';
import { useMessageChannel } from './message-channel';
import { type Message, useMessages } from './queries';

/**
 * Virtuoso の `firstItemIndex` の起点。
 * **踏むと壊れる: 古いメッセージを上に足したら、足した件数だけ `firstItemIndex` を減らす。** 減らさないと、
 * 上に足した分だけ表示中のメッセージが下へずれる（react-virtuoso の `firstItemIndex`「decrease the value this property
 * in combination with `data` or `totalCount` to prepend items to the top of the list」。機能一覧 4.1「スクロール位置が飛ばない」）。
 * 正の数でなければならないため、遡れる件数より十分大きくとる。
 */
const FIRST_INDEX = 1_000_000_000;

/** 一覧ごとに変わる文言。 */
type Labels = { failed: string; empty: string; olderFailed: string; loadOlder: string };

const CHANNEL_LABELS: Labels = {
  failed: 'メッセージを読み込めませんでした。',
  empty: 'まだメッセージはありません。',
  olderFailed: '古いメッセージを読み込めませんでした。',
  loadOlder: '古いメッセージを読み込む',
};

export const REPLY_LABELS: Labels = {
  failed: '返信を読み込めませんでした。',
  empty: 'まだ返信はありません。',
  olderFailed: '古い返信を読み込めませんでした。',
  loadOlder: '古い返信を読み込む',
};

type Pages = ReturnType<typeof useMessages>;

type ListContext = {
  labels: Labels;
  hasOlder: boolean;
  loadingOlder: boolean;
  olderFailed: unknown;
  loadOlder: () => void;
};

/** チャンネルのメッセージの一覧（F-11・F-12）。返信のあるメッセージからスレッドを開く（F-17）。 */
export function MessageList({
  workspaceId,
  channelId,
  onOpenThread,
  lastReadMessageId = null,
  joinedAt = null,
}: {
  workspaceId: string;
  channelId: string;
  onOpenThread: (message: Message) => void;
  lastReadMessageId?: string | null;
  joinedAt?: string | null;
}) {
  const messages = useMessages(workspaceId, channelId);
  return (
    <PagedMessages
      pages={messages}
      labels={CHANNEL_LABELS}
      onOpenThread={onOpenThread}
      lastReadMessageId={lastReadMessageId}
      joinedAt={joinedAt}
    />
  );
}

/** 新しい順のページを、上が古く下が新しい一覧にする。古いものは先頭のボタンで遡って読む。 */
export function PagedMessages({
  pages: query,
  labels,
  onOpenThread,
  lastReadMessageId = null,
  joinedAt = null,
}: {
  pages: Pages;
  labels: Labels;
  onOpenThread?: (message: Message) => void;
  lastReadMessageId?: string | null;
  joinedAt?: string | null;
}) {
  if (!query.data) {
    return query.isError ? (
      <p role="alert" className="text-red-700">
        {labels.failed}
        {errorMessage(query.error)}
      </p>
    ) : (
      <p role="status" className="text-slate-600">
        読み込み中…
      </p>
    );
  }

  const { pages } = query.data;
  // api は新しい順に返す。画面は上を古くするため、ページの並びもページの中も逆にする
  const items = [...pages].reverse().flatMap((page) => [...page.messages].reverse());
  if (items.length === 0) return <p className="text-slate-600">{labels.empty}</p>;
  const olderCount = pages.slice(1).reduce((sum, page) => sum + page.messages.length, 0);
  // **線は既読位置より後の最初の1件の上にだけ出す。**
  // id は UUIDv7 で、文字の並びが時刻の順になる（機能一覧 10.1。同じミリ秒の前後が決まらない時刻では比べない）。
  // **既読位置をまだ持たないチャンネルでは、参加した時点より後の最初の1件の上に出す**（10.1・openapi の Channel.lastReadMessageId）。
  // **未読数から位置を数えてはならない**——自分の投稿と削除済みは未読に数えないが、一覧には並ぶため必ずずれる。
  // 参加していないチャンネルはどちらも null になり、線は出ない（そもそも開けない）
  const unreadFromId = firstUnreadId(items, lastReadMessageId, joinedAt);

  return (
    <LoadedList
      items={items}
      firstItemIndex={FIRST_INDEX - olderCount}
      onOpenThread={onOpenThread}
      unreadFromId={unreadFromId}
      context={{
        labels,
        hasOlder: query.hasNextPage,
        loadingOlder: query.isFetchingNextPage,
        olderFailed: query.isFetchNextPageError ? query.error : null,
        loadOlder: () => void query.fetchNextPage(),
      }}
    />
  );
}

/** 読み込めた一覧。開いたときは最新（いちばん下）を見せる。 */
function LoadedList({
  items,
  firstItemIndex,
  onOpenThread,
  unreadFromId,
  context,
}: {
  items: Message[];
  firstItemIndex: number;
  onOpenThread?: (message: Message) => void;
  unreadFromId: string | null;
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
      itemContent={(_, message) => (
        <>
          {message.id === unreadFromId && <UnreadDivider />}
          <MessageItem message={message} onOpenThread={onOpenThread} />
        </>
      )}
    />
  );
}

/**
 * 「ここから未読」の線を出す1件（古い順に並んだ `items` から選ぶ）。無ければ null。
 *
 * - 既読位置があれば、**その id より後**の最初の1件（id は UUIDv7 で、文字の並びが時刻の順になる）
 * - 既読位置がまだ無ければ、**参加した時刻より後**の最初の1件（参加する前の履歴は未読にしない。機能一覧 10.1）
 * - どちらも無ければ出さない（参加していないチャンネル）
 */
function firstUnreadId(
  items: Message[],
  lastReadMessageId: string | null,
  joinedAt: string | null,
): string | null {
  if (lastReadMessageId !== null) {
    return items.find((message) => message.id > lastReadMessageId)?.id ?? null;
  }
  if (joinedAt === null) return null;
  return items.find((message) => message.createdAt >= joinedAt)?.id ?? null;
}

/**
 * 「ここから未読」の区切り線（F-23。機能一覧 10.1）。
 * **線は装飾ではなく境目である**ため、`separator` として支援技術にも渡す（`separator` は中の文から名前を取らないので `aria-label` を付ける）。
 */
function UnreadDivider() {
  return (
    <div
      role="separator"
      aria-label="ここから未読"
      className="my-2 flex items-center gap-2 text-sm text-red-700"
    >
      <span className="h-px flex-1 bg-red-300" />
      ここから未読
      <span className="h-px flex-1 bg-red-300" />
    </div>
  );
}

function OlderMessages({ context }: { context: ListContext }) {
  return (
    <div className="flex flex-col items-center gap-1 py-2">
      {context.olderFailed !== null && (
        <p role="alert" className="text-red-700">
          {context.labels.olderFailed}
          {errorMessage(context.olderFailed)}
        </p>
      )}
      {context.hasOlder && (
        <button
          type="button"
          className="rounded border px-2 py-0.5 text-sm disabled:opacity-50"
          disabled={context.loadingOlder}
          onClick={context.loadOlder}
        >
          {context.labels.loadOlder}
        </button>
      )}
    </div>
  );
}

/**
 * 1件のメッセージ。退会した投稿者は「削除済みの利用者」（機能一覧 1.5）、削除済みは本文を置き換える（4.2）。
 * **自分のメッセージで削除済みでなければ、編集・削除を出す**（F-13。チャンネルの画面が `MessageChannelProvider` を置いているときだけ）。
 */
export function MessageItem({
  message,
  onOpenThread,
}: {
  message: Message;
  onOpenThread?: (message: Message) => void;
}) {
  const scope = useMessageChannel();
  const session = useSession();
  const [editing, setEditing] = useState(false);
  const ownScope =
    scope !== null &&
    !scope.readOnly &&
    session.status === 'signedIn' &&
    message.body !== null &&
    message.author?.id === session.user.id
      ? scope
      : null;

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
      ) : ownScope && editing ? (
        <EditMessageForm scope={ownScope} message={message} onDone={() => setEditing(false)} />
      ) : (
        <MessageBody body={message.body} mentions={message.mentions} />
      )}
      {/* 削除済みのメッセージは添付も出さない（api も返さない。機能一覧 4.2） */}
      {message.body !== null && <MessageAttachments attachments={message.attachments} />}
      {ownScope && !editing && (
        <MessageActions scope={ownScope} message={message} onEdit={() => setEditing(true)} />
      )}
      {onOpenThread && (
        <ThreadSummary
          message={message}
          canReply={scope?.readOnly !== true}
          onOpen={() => onOpenThread(message)}
        />
      )}
    </article>
  );
}

/**
 * スレッドの入口（機能一覧 6）。返信があれば件数と返信した人の表示名、無ければ「返信する」を出す。
 * 削除済みで返信の無いメッセージには出さない（削除済みの親には返信できない）。
 */
function ThreadSummary({
  message,
  canReply,
  onOpen,
}: {
  message: Message;
  /** 返信できるか（アーカイブ済みのチャンネルでは、返信の無いメッセージに「返信する」を出さない） */
  canReply: boolean;
  onOpen: () => void;
}) {
  if (message.replyCount > 0) {
    return (
      <div className="mt-1 flex items-baseline gap-2 text-sm">
        <button type="button" className="text-sky-700 underline" onClick={onOpen}>
          {`${message.replyCount}件の返信`}
        </button>
        {message.replyParticipants.length > 0 && (
          <span className="text-slate-500">
            {message.replyParticipants.map((user) => user.displayName).join('、')}
          </span>
        )}
      </div>
    );
  }
  if (message.body === null || !canReply) return null;
  return (
    <button type="button" className="mt-1 text-sm text-slate-600 underline" onClick={onOpen}>
      返信する
    </button>
  );
}
