import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { failureMessage } from '../auth/failure-message';
import { MessageList } from '../messages/MessageList';
import { PostMessageForm } from '../messages/PostMessageForm';
import { useMessages } from '../messages/queries';
import { ThreadPanel } from '../messages/ThreadPanel';
import { useChannelRealtime } from '../realtime/use-channel-realtime';
import { useChannels, useUpdateChannelRead } from './queries';

/** 開いているスレッドの親の id を持つ URL のパラメータ（機能一覧 6。開き直しても同じスレッドを開く）。 */
const THREAD_PARAM = 'thread';

/** チャンネルの画面。参加しているチャンネルだけを開き、メッセージの一覧・投稿・スレッド・リアルタイムの反映を置く（F-11・F-12・F-16・F-17）。 */
export function ChannelPage() {
  const { workspaceId = '', channelId = '' } = useParams();
  const channels = useChannels(workspaceId);
  const channel = channels.data?.find((c) => c.id === channelId && c.joined);

  if (channels.isPending) {
    return (
      <p role="status" className="p-6 text-slate-600">
        読み込み中…
      </p>
    );
  }
  if (!channel) {
    return (
      <main className="mx-auto max-w-xl p-6">
        <p>チャンネルが見つかりません。</p>
        <Link to={`/workspaces/${workspaceId}`} className="underline">
          チャンネルの一覧へ
        </Link>
      </main>
    );
  }
  return (
    <main className="mx-auto max-w-5xl p-6">
      <h1 className="text-2xl font-bold">{`# ${channel.name}`}</h1>
      <Link to={`/workspaces/${workspaceId}`} className="text-sm underline">
        チャンネルの一覧へ
      </Link>
      <ChannelMessages
        key={channelId}
        workspaceId={workspaceId}
        channelId={channelId}
        lastReadMessageId={channel.lastReadMessageId ?? null}
      />
    </main>
  );
}

/**
 * 参加しているチャンネルの本体。入室要求は、参加していると分かったチャンネルにだけ送る。
 *
 * **区切り線の位置は、開いた時点の既読位置で固定する**（読み進めても動かない。機能一覧 10.1）。
 * チャンネルを変えると `key` で作り直され、そのチャンネルの位置で取り直す。
 */
function ChannelMessages({
  workspaceId,
  channelId,
  lastReadMessageId,
}: {
  workspaceId: string;
  channelId: string;
  lastReadMessageId: string | null;
}) {
  const rejected = useChannelRealtime(workspaceId, channelId);
  const [unreadFrom] = useState(lastReadMessageId);
  useAdvanceRead(workspaceId, channelId);
  const [searchParams, setSearchParams] = useSearchParams();
  const threadId = searchParams.get(THREAD_PARAM);
  const setThread = (id: string | null) =>
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      if (id === null) next.delete(THREAD_PARAM);
      else next.set(THREAD_PARAM, id);
      return next;
    });

  return (
    <>
      {rejected && (
        <p role="alert" className="mt-4 text-red-700">
          リアルタイムの反映を始められませんでした。{failureMessage(rejected)}
        </p>
      )}
      <div className={threadId ? 'md:grid md:grid-cols-2 md:gap-4' : undefined}>
        <div>
          <section aria-label="メッセージの一覧" className="mt-4">
            <MessageList
              workspaceId={workspaceId}
              channelId={channelId}
              onOpenThread={(message) => setThread(message.id)}
              lastReadMessageId={unreadFrom}
            />
          </section>
          <PostMessageForm workspaceId={workspaceId} channelId={channelId} />
        </div>
        {threadId && (
          <ThreadPanel
            key={threadId}
            workspaceId={workspaceId}
            channelId={channelId}
            parentId={threadId}
            onClose={() => setThread(null)}
          />
        )}
      </div>
    </>
  );
}

/**
 * 読み込んである最新の**本体**まで既読位置を進める（F-23。機能一覧 10.1）。
 * 返信はスレッドごとに別の位置を持つため、ここでは数えない。
 * **同じ位置は送り直さない**——描き直しのたびに送ると、上限（429）に当たる。
 */
function useAdvanceRead(workspaceId: string, channelId: string) {
  const messages = useMessages(workspaceId, channelId);
  const { mutate: advance } = useUpdateChannelRead(workspaceId, channelId);
  // 最新のページは新しい順で、その先頭の本体が、読み込んである中でいちばん新しい
  const newestId = messages.data?.pages[0]?.messages.find((m) => m.parentId === null)?.id ?? null;

  // **同じ位置は送り直さない**——効果の依存が位置そのものであり、変わらないうちは走らない
  useEffect(() => {
    if (newestId !== null) advance(newestId);
  }, [newestId, advance]);
}
