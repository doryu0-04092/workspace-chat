import { type FormEvent, useState } from 'react';
import { Link, useParams } from 'react-router';
import { ApiError, errorMessage } from '../api/client';
import { useUnreadRealtime } from '../realtime/use-unread-realtime';
import {
  type Channel,
  useChannels,
  useCreateChannel,
  useJoinChannel,
  useWorkspace,
} from './queries';

function channelLabel(channel: Channel): string {
  return `# ${channel.name}${channel.visibility === 'PRIVATE' ? '（プライベート）' : ''}`;
}

/**
 * ワークスペースの画面（F-10 のチャンネルの一覧・パブリックへの参加・作成）。
 * **作成のフォームをオーナーにだけ出すのは画面の出し分けであり、権限の根拠ではない**（判定は api。CLAUDE.md 2）。
 */
export function WorkspacePage() {
  const { workspaceId = '' } = useParams();
  const workspace = useWorkspace(workspaceId);
  const channels = useChannels(workspaceId);
  const join = useJoinChannel(workspaceId);
  useUnreadRealtime(workspaceId);

  if (workspace.error instanceof ApiError && workspace.error.failure.status === 404) {
    return (
      <main className="mx-auto max-w-xl p-6">
        <p>ワークスペースが見つかりません。</p>
        <Link to="/workspaces" className="underline">
          ワークスペースの一覧へ
        </Link>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-xl p-6">
      <h1 className="text-2xl font-bold">{workspace.data?.name ?? ''}</h1>
      {(workspace.isError || channels.isError) && (
        <p role="alert" className="mt-4 text-red-700">
          チャンネルを読み込めませんでした。{errorMessage(workspace.error ?? channels.error)}
        </p>
      )}
      {channels.data && (
        <ul aria-label="チャンネル" className="mt-4 flex flex-col gap-2">
          {channels.data.map((channel) => (
            <li key={channel.id} className="flex items-center gap-3">
              {channel.joined ? (
                <>
                  <Link
                    to={`/workspaces/${workspaceId}/channels/${channel.id}`}
                    className={channel.unread > 0 ? 'font-bold underline' : 'underline'}
                  >
                    {channelLabel(channel)}
                  </Link>
                  {/* **太字は装飾であり、支援技術には伝わらない**ため、未読は件数の文字でも出す（機能一覧 10.1） */}
                  {channel.unread > 0 && (
                    <span className="text-sm text-slate-600">{`未読 ${channel.unread} 件`}</span>
                  )}
                </>
              ) : (
                <>
                  <span>{channelLabel(channel)}</span>
                  <button
                    type="button"
                    className="rounded border px-2 py-0.5 text-sm disabled:opacity-50"
                    aria-label={`${channel.name} に参加する`}
                    disabled={join.isPending}
                    onClick={() => join.mutate(channel.id)}
                  >
                    参加する
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {join.isError && (
        <p role="alert" className="mt-4 text-red-700">
          {errorMessage(join.error)}
        </p>
      )}
      {workspace.data?.role === 'OWNER' && <CreateChannelForm workspaceId={workspaceId} />}
    </main>
  );
}

function CreateChannelForm({ workspaceId }: { workspaceId: string }) {
  const create = useCreateChannel(workspaceId);
  const [name, setName] = useState('');
  const [visibility, setVisibility] = useState<Channel['visibility']>('PUBLIC');

  function submit(event: FormEvent) {
    event.preventDefault();
    create.mutate({ name, visibility }, { onSuccess: () => setName('') });
  }

  return (
    <form className="mt-8 flex flex-col gap-2" onSubmit={submit}>
      <label htmlFor="channel-name">チャンネル名</label>
      <input
        id="channel-name"
        className="rounded border px-2 py-1"
        required
        maxLength={50}
        value={name}
        onChange={(event) => setName(event.target.value)}
      />
      <fieldset className="flex gap-4">
        <legend className="sr-only">種別</legend>
        <label className="flex items-center gap-1">
          <input
            type="radio"
            name="visibility"
            checked={visibility === 'PUBLIC'}
            onChange={() => setVisibility('PUBLIC')}
          />
          パブリック
        </label>
        <label className="flex items-center gap-1">
          <input
            type="radio"
            name="visibility"
            checked={visibility === 'PRIVATE'}
            onChange={() => setVisibility('PRIVATE')}
          />
          プライベート
        </label>
      </fieldset>
      {create.isError && (
        <p role="alert" className="text-red-700">
          {errorMessage(create.error)}
        </p>
      )}
      <button
        className="self-start rounded bg-slate-800 px-3 py-2 text-white disabled:opacity-50"
        disabled={create.isPending}
      >
        チャンネルを作成する
      </button>
    </form>
  );
}
