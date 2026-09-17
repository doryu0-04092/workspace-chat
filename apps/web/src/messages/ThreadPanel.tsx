import { useEffect } from 'react';
import { MessageItem, PagedMessages, REPLY_LABELS } from './MessageList';
import { useMessageChannel } from './message-channel';
import { MessageForm } from './PostMessageForm';
import {
  type Message,
  useLoadedMessage,
  usePostReply,
  useReplies,
  useUpdateThreadRead,
} from './queries';

/**
 * スレッド（F-17。機能一覧 6）。親と返信を上が古い順に並べ、返信を送る。
 * 親はチャンネルの一覧に読み込み済みのときだけ出す（1件のメッセージを取る api は無い）。返信は親が無くても読む。
 */
export function ThreadPanel({
  workspaceId,
  channelId,
  parentId,
  onClose,
}: {
  workspaceId: string;
  channelId: string;
  parentId: string;
  onClose: () => void;
}) {
  const parent = useLoadedMessage(workspaceId, channelId, parentId);
  const replies = useReplies(workspaceId, channelId, parentId);
  const post = usePostReply(workspaceId, channelId, parentId);
  const readOnly = useMessageChannel()?.readOnly === true;
  useAdvanceThreadRead(workspaceId, channelId, parentId, replies.data?.pages[0]?.messages);

  return (
    <section aria-label="スレッド" className="mt-4 rounded border p-2">
      <div className="flex items-center justify-between">
        <h2 className="font-bold">スレッド</h2>
        <button type="button" className="text-sm underline" onClick={onClose}>
          スレッドを閉じる
        </button>
      </div>
      {parent && <MessageItem message={parent} />}
      <PagedMessages
        pages={replies}
        labels={REPLY_LABELS}
        renderMessage={(message) => <MessageItem message={message} />}
      />
      {/* 削除済みと分かった親には返信のフォームを出さない（api が断る）。**親が読み込まれていなければ出す**——削除済みかは分からず、消すと読み込んだページより古い親に返信できなくなる */}
      {!readOnly && parent?.body !== null && (
        <MessageForm
          submit={post.mutate}
          pending={post.isPending}
          error={post.error}
          workspaceId={workspaceId}
          channelId={channelId}
          label="返信"
          submitLabel="返信を送信する"
        />
      )}
    </section>
  );
}

/**
 * 読み込んである最新の返信までスレッドの既読位置を進める（F-23。機能一覧 10.1）。返信の未読はこの位置で決まり、チャンネルの既読位置では減らない。
 * **削除されていない返信だけを送る**——api は削除済みの id を 404 で断り、最後の返信が消されただけで既読が進まなくなる。
 * **同じ位置は送り直さない**——効果の依存が位置そのものであり、変わらないうちは走らない（上限は 1分 120 回）。
 */
function useAdvanceThreadRead(
  workspaceId: string,
  channelId: string,
  parentId: string,
  newestPage: Message[] | undefined,
) {
  const { mutate: advance } = useUpdateThreadRead(workspaceId, channelId);
  // 最新のページは新しい順で、その先頭の削除されていない返信が、送れる中でいちばん新しい
  const newestId = newestPage?.find((m) => !m.deleted)?.id ?? null;

  useEffect(() => {
    if (newestId !== null) advance({ parentId, lastReadMessageId: newestId });
  }, [parentId, newestId, advance]);
}
