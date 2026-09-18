import type { InfiniteData, UseInfiniteQueryResult } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { Virtuoso } from 'react-virtuoso';
import { errorMessage } from '../api/client';
import { useSession } from '../auth/session-context';
import { UserAvatar } from '../users/UserAvatar';
import { EditMessageForm, MessageActions } from './MessageActions';
import { MessageAttachments } from './MessageAttachments';
import { MessageBody } from './MessageBody';
import { MessageReactions } from './MessageReactions';
import { useMessageChannel } from './message-channel';
import { PinControls } from './PinnedMessages';
import { type Message, useMessages } from './queries';

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

/** 一覧に並べるメッセージ（チャンネルの `Message` と DM の `DmMessage` の共通部分）。 */
type ListedMessage = { id: string; createdAt: string; author: { id: string } | null };

/** 新しい順のページを遡って読む問い合わせ（チャンネルの `useMessages`・`useReplies` と DM の `useDmMessages`）。 */
type Pages<M> = UseInfiniteQueryResult<InfiniteData<{ messages: M[]; nextBefore: string | null }>>;

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
      renderMessage={(message) => <MessageItem message={message} onOpenThread={onOpenThread} />}
      lastReadMessageId={lastReadMessageId}
      joinedAt={joinedAt}
    />
  );
}

/**
 * 新しい順のページを、上が新しく下が古い一覧にする（#608。入力欄も一覧の上に置き、最新を見るにも入力するにも下までスクロールしない）。
 * 古いものは末尾のボタンで遡って読み、下に足す。
 * 1件の描き方は `renderMessage` で渡す（チャンネル・スレッドは `MessageItem`、DM は DM の1件。F-19）——
 * **遡って読んだときに位置を動かさないことと「ここから上が未読」の線の位置は、どの一覧でもここだけが持つ**。
 */
export function PagedMessages<M extends ListedMessage>({
  pages: query,
  labels,
  renderMessage,
  lastReadMessageId = null,
  joinedAt = null,
}: {
  pages: Pages<M>;
  labels: Labels;
  renderMessage: (message: M) => ReactNode;
  lastReadMessageId?: string | null;
  joinedAt?: string | null;
}) {
  const session = useSession();
  const me = session.status === 'signedIn' ? session.user.id : null;
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
  // api は新しい順に返し、画面も上を新しくする（#608）。ページの並びもページの中もそのまま使う
  const items = pages.flatMap((page) => page.messages);
  if (items.length === 0) return <p className="text-slate-600">{labels.empty}</p>;
  // **線は、既読位置より後のうち最も古い1件の下にだけ出す**（上が新しい並びでは、未読の塊の下端が境目になる）。
  // id は UUIDv7 で、文字の並びが時刻の順になる（機能一覧 10.1。同じミリ秒の前後が決まらない時刻では比べない）。
  // **既読位置をまだ持たないチャンネルでは、参加した時点より後のうち最も古い1件の下に出す**（10.1・openapi の Channel.lastReadMessageId）。
  // **未読数から位置を数えてはならない**——自分の投稿と削除済みは未読に数えないが、一覧には並ぶため必ずずれる。
  // 参加していないチャンネルはどちらも null になり、線は出ない（そもそも開けない）
  const oldestUnreadId = firstUnreadId(items, lastReadMessageId, joinedAt, me);

  return (
    <LoadedList
      items={items}
      renderMessage={renderMessage}
      oldestUnreadId={oldestUnreadId}
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

/**
 * 読み込めた一覧。開いたときは最新（いちばん上）を見せる。
 * **`firstItemIndex` は使わない**——古いものは下に足すため、既に出ている行の番号は変わらない。新しいものは上に足し、
 * いちばん上を見ている間はそのまま見える（上を見ていない間は、足した分だけ下にずれる）。
 */
function LoadedList<M extends ListedMessage>({
  items,
  renderMessage,
  oldestUnreadId,
  context,
}: {
  items: M[];
  renderMessage: (message: M) => ReactNode;
  oldestUnreadId: string | null;
  context: ListContext;
}) {
  return (
    <Virtuoso<M, ListContext>
      // 踏むと壊れる: 高さは className ではなく style で渡す。react-virtuoso は枠に height: 100% をインラインで付け、クラスの高さに勝つ
      // （親の高さは自動のため 0 になり、一覧が見えない。#606）
      style={{ height: '60vh' }}
      data={items}
      computeItemKey={(_, message) => message.id}
      context={context}
      components={{ Footer: OlderMessages }}
      itemContent={(_, message) => (
        <>
          {renderMessage(message)}
          {message.id === oldestUnreadId && <UnreadDivider />}
        </>
      )}
    />
  );
}

/**
 * 「ここから上が未読」の線を出す1件（新しい順に並んだ `items` から、未読のうち最も古いものを選ぶ）。無ければ null。
 *
 * - 既読位置があれば、**その id より後**のうち最も古い1件（id は UUIDv7 で、文字の並びが時刻の順になる）
 * - 既読位置がまだ無ければ、**参加した時刻より後**のうち最も古い1件（参加する前の履歴は未読にしない。機能一覧 10.1）
 * - どちらも無ければ出さない（参加していないチャンネル）
 * - **自分の投稿は飛ばす**——未読に数えないため（機能一覧 10.1）、自分の投稿の下に線を出すと、読むものが無いのに未読があるように見える。
 *   既読位置より後が自分の投稿だけなら出さない
 */
function firstUnreadId(
  items: readonly ListedMessage[],
  lastReadMessageId: string | null,
  joinedAt: string | null,
  me: string | null,
): string | null {
  const others = [...items].reverse().filter((message) => message.author?.id !== me);
  if (lastReadMessageId !== null) {
    return others.find((message) => message.id > lastReadMessageId)?.id ?? null;
  }
  if (joinedAt === null) return null;
  return others.find((message) => message.createdAt >= joinedAt)?.id ?? null;
}

/**
 * 「ここから上が未読」の区切り線（F-23。機能一覧 10.1）。上が新しい並びでは、未読の塊の下端に出す（#608）。
 * **線は装飾ではなく境目である**ため、`separator` として支援技術にも渡す（`separator` は中の文から名前を取らないので `aria-label` を付ける）。
 */
function UnreadDivider() {
  return (
    <div
      role="separator"
      aria-label="ここから上が未読"
      className="my-2 flex items-center gap-2 text-sm text-red-700"
    >
      <span className="h-px flex-1 bg-red-300" />
      ここから上が未読
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
    <MessageShell
      message={message}
      mentions={message.mentions}
      headerExtra={<PinControls message={message} />}
      editor={
        ownScope && editing ? (
          <EditMessageForm scope={ownScope} message={message} onDone={() => setEditing(false)} />
        ) : null
      }
    >
      {/* 削除済みのメッセージは添付も出さない（api も返さない。機能一覧 4.2） */}
      {message.body !== null && <MessageAttachments attachments={message.attachments} />}
      <MessageReactions message={message} />
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
    </MessageShell>
  );
}

/**
 * 1件のメッセージの枠（チャンネル・スレッド・DM で共通。F-19）。**退会した書き手は「削除済みの利用者」（機能一覧 1.5）、
 * 削除済みは本文を置き換え、削除済みには「（編集済み）」を出さない（4.2）——この出し方はここだけに置く**（一覧ごとに持つと片方だけが変わる）。
 * `editor` を渡すと、本文の代わりに出す（編集中）。`children` は本文の下に置く（操作・スレッドの入口）。
 * `headerExtra` は見出しの行の末尾に置く（チャンネルのメッセージのピン留め。DM には無い）。
 */
export function MessageShell({
  message,
  mentions,
  headerExtra = null,
  editor = null,
  children,
}: {
  message: {
    author: { displayName: string; avatarUrl: string | null } | null;
    createdAt: string;
    editedAt: string | null;
    body: string | null;
  };
  mentions?: Message['mentions'];
  headerExtra?: ReactNode;
  editor?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <article className="px-2 py-2">
      <header className="flex items-baseline gap-2 text-sm">
        <UserAvatar user={message.author} />
        <span className="font-bold">{message.author?.displayName ?? '削除済みの利用者'}</span>
        <time dateTime={message.createdAt} className="text-slate-500">
          {new Date(message.createdAt).toLocaleString('ja-JP')}
        </time>
        {message.editedAt !== null && message.body !== null && (
          <span className="text-slate-500">（編集済み）</span>
        )}
        {headerExtra}
      </header>
      {message.body === null ? (
        <p className="text-slate-500">このメッセージは削除されました</p>
      ) : editor !== null ? (
        editor
      ) : (
        <MessageBody body={message.body} mentions={mentions} />
      )}
      {children}
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
