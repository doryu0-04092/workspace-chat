import { Link, useParams } from 'react-router';
import { MessageList } from '../messages/MessageList';
import { PostMessageForm } from '../messages/PostMessageForm';
import { useChannels } from './queries';

/** チャンネルの画面。メッセージの一覧と投稿（F-11・F-12）。リアルタイムの反映は #379 の3つ目の後半の2つ目。 */
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
    <main className="mx-auto max-w-3xl p-6">
      <h1 className="text-2xl font-bold">{`# ${channel.name}`}</h1>
      <Link to={`/workspaces/${workspaceId}`} className="text-sm underline">
        チャンネルの一覧へ
      </Link>
      <section aria-label="メッセージの一覧" className="mt-4">
        <MessageList key={channelId} workspaceId={workspaceId} channelId={channelId} />
      </section>
      <PostMessageForm workspaceId={workspaceId} channelId={channelId} />
    </main>
  );
}
