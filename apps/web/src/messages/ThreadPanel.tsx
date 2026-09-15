import { MessageItem, PagedMessages, REPLY_LABELS } from './MessageList';
import { MessageForm } from './PostMessageForm';
import { useLoadedMessage, usePostReply, useReplies } from './queries';

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

  return (
    <section aria-label="スレッド" className="mt-4 rounded border p-2">
      <div className="flex items-center justify-between">
        <h2 className="font-bold">スレッド</h2>
        <button type="button" className="text-sm underline" onClick={onClose}>
          スレッドを閉じる
        </button>
      </div>
      {parent && <MessageItem message={parent} />}
      <PagedMessages pages={replies} labels={REPLY_LABELS} />
      <MessageForm
        post={post}
        workspaceId={workspaceId}
        channelId={channelId}
        label="返信"
        submitLabel="返信を送信する"
      />
    </section>
  );
}
