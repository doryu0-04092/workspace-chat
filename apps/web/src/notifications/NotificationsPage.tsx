import { Link } from 'react-router';
import { errorMessage, segment } from '../api/client';
import { MessageBody } from '../messages/MessageBody';
import { type Notification, useMarkNotificationRead, useNotifications } from './queries';

/** 通知から移る先。本体はそのチャンネル、返信はそのスレッドを開いたチャンネル（`ChannelPage` の `thread`）。 */
function messagePathOf(notification: Notification): string {
  const channel = `/workspaces/${segment(notification.workspace.id)}/channels/${segment(notification.channel.id)}`;
  const { parentId } = notification.message;
  return parentId === null ? channel : `${channel}?${new URLSearchParams({ thread: parentId })}`;
}

/**
 * 通知の一覧（F-26。機能一覧 10.3）。受け取ったメンションを新しい順に出し、既読化と、該当メッセージへの移動ができる。
 * **未読か既読かは文字でも出す**（太字は装飾であり、支援技術には伝わらない。10.1 の未読と同じ）。
 */
export function NotificationsPage() {
  const notifications = useNotifications();
  const markRead = useMarkNotificationRead();
  const items = notifications.data?.pages.flatMap((page) => page.notifications) ?? [];

  return (
    <main className="mx-auto max-w-3xl p-6">
      <h1 className="text-2xl font-bold">通知</h1>
      {notifications.isPending && (
        <p role="status" className="mt-4 text-slate-600">
          読み込み中…
        </p>
      )}
      {notifications.isError && (
        <p role="alert" className="mt-4 text-red-700">
          通知を読み込めませんでした。{errorMessage(notifications.error)}
        </p>
      )}
      {markRead.isError && (
        <p role="alert" className="mt-4 text-red-700">
          既読にできませんでした。{errorMessage(markRead.error)}
        </p>
      )}
      {notifications.isSuccess && items.length === 0 && <p className="mt-4">通知はありません。</p>}
      <ul className="mt-4 flex flex-col gap-2">
        {items.map((notification) => {
          const unread = notification.readAt === null;
          const { message } = notification;
          return (
            <li key={notification.id}>
              <article
                className={`rounded border px-3 py-2 ${unread ? 'border-sky-300 bg-sky-50' : ''}`}
              >
                <header className="flex flex-wrap items-baseline gap-2 text-sm">
                  <span className={unread ? 'font-bold' : 'text-slate-500'}>
                    {unread ? '未読' : '既読'}
                  </span>
                  <span>{`${notification.workspace.name} / # ${notification.channel.name}`}</span>
                  <span className="font-bold">
                    {`${message.author?.displayName ?? '削除済みの利用者'} さんからのメンション`}
                  </span>
                  <time dateTime={notification.createdAt} className="text-slate-500">
                    {new Date(notification.createdAt).toLocaleString('ja-JP')}
                  </time>
                </header>
                {message.body !== null && (
                  <MessageBody body={message.body} mentions={message.mentions} />
                )}
                <div className="mt-1 flex gap-3 text-sm">
                  <Link
                    to={messagePathOf(notification)}
                    className="underline"
                    onClick={() => {
                      if (unread) markRead.mutate(notification.id);
                    }}
                  >
                    メッセージへ移動
                  </Link>
                  {unread && (
                    <button
                      type="button"
                      className="underline disabled:opacity-50"
                      disabled={markRead.isPending}
                      onClick={() => markRead.mutate(notification.id)}
                    >
                      既読にする
                    </button>
                  )}
                </div>
              </article>
            </li>
          );
        })}
      </ul>
      {notifications.hasNextPage && (
        <button
          type="button"
          className="mt-4 rounded border px-3 py-1 disabled:opacity-50"
          disabled={notifications.isFetchingNextPage}
          onClick={() => void notifications.fetchNextPage()}
        >
          さらに読み込む
        </button>
      )}
    </main>
  );
}
