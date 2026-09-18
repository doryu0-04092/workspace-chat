import { type FormEvent, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { ApiError, errorMessage } from '../api/client';
import { DmList } from '../dms/DmList';
import { useUnreadRealtime } from '../realtime/use-unread-realtime';
import { SearchForm } from '../search/SearchForm';
import { ManagedChannels } from './ManagedChannels';
import { WorkspaceMembers } from './MemberLists';
import {
  type Channel,
  useArchivedChannels,
  useChannels,
  useCreateChannel,
  useInvitationCandidates,
  useInviteToWorkspace,
  useJoinChannel,
  useLeaveWorkspace,
  useWorkspace,
} from './queries';

function channelLabel(channel: Channel): string {
  return `# ${channel.name}${channel.visibility === 'PRIVATE' ? '（プライベート）' : ''}`;
}

/**
 * ワークスペースの画面（F-10 のチャンネルの一覧・パブリックへの参加・作成、F-08 の招待、F-38 の退出）。
 * **作成と招待のフォームをオーナーにだけ出すのは画面の出し分けであり、権限の根拠ではない**（判定は api。CLAUDE.md 2）。
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
      {/* 検索（F-30。機能一覧 12.1）。結果は検索の画面に出す */}
      <SearchForm workspaceId={workspaceId} />
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
                  {/* 自分宛のメンションの件数（機能一覧 10.2）。**ブラウザ通知の許可によらず、画面内で分かるようにする** */}
                  {channel.mentions > 0 && (
                    <span className="rounded-full bg-red-600 px-2 text-xs font-bold text-white">
                      {`メンション ${channel.mentions} 件`}
                    </span>
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
      {/* 自分が当事者の DM と、DM を始める（F-19）。未読はチャンネルと同じく太字と件数で出す（10.1） */}
      {workspace.data && <DmList workspaceId={workspaceId} />}
      <ArchivedChannels workspaceId={workspaceId} />
      {workspace.data?.role === 'OWNER' && <CreateChannelForm workspaceId={workspaceId} />}
      {workspace.data?.role === 'OWNER' && <InviteForm workspaceId={workspaceId} />}
      {workspace.data?.role === 'OWNER' && <ManagedChannels workspaceId={workspaceId} />}
      {workspace.data && (
        <WorkspaceMembers workspaceId={workspaceId} isOwner={workspace.data.role === 'OWNER'} />
      )}
      {workspace.data && <LeaveWorkspace workspaceId={workspaceId} />}
    </main>
  );
}

/**
 * 自分が参加しているアーカイブ済みのチャンネル（F-35。機能一覧 3.2「参加者は読める」）。押したときにだけ読み、読むための画面へのリンクを並べる。
 */
function ArchivedChannels({ workspaceId }: { workspaceId: string }) {
  const [open, setOpen] = useState(false);
  const archived = useArchivedChannels(workspaceId, open);

  return (
    <section className="mt-8">
      <button
        type="button"
        className="text-sm underline"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        アーカイブ済みのチャンネル
      </button>
      {open && archived.isError && (
        <p role="alert" className="mt-2 text-red-700">
          アーカイブ済みのチャンネルを読み込めませんでした。{errorMessage(archived.error)}
        </p>
      )}
      {open &&
        archived.data &&
        (archived.data.length === 0 ? (
          <p className="mt-2 text-sm text-slate-600">アーカイブ済みのチャンネルはありません。</p>
        ) : (
          <ul aria-label="アーカイブ済みのチャンネル" className="mt-2 flex flex-col gap-1">
            {archived.data.map((channel) => (
              <li key={channel.id}>
                <Link
                  to={`/workspaces/${workspaceId}/channels/${channel.id}`}
                  className="underline"
                >
                  {channelLabel(channel)}
                </Link>
              </li>
            ))}
          </ul>
        ))}
    </section>
  );
}

/** 入力が止まってから（250 ミリ秒）、前後の空白を除いた値を返す。空白だけなら null（#616。打つたびに候補を読まない）。 */
function useSettledQuery(input: string): string | null {
  const [settled, setSettled] = useState<string | null>(null);
  useEffect(() => {
    const trimmed = input.trim();
    const timer = setTimeout(() => setSettled(trimmed === '' ? null : trimmed), 250);
    return () => clearTimeout(timer);
  }, [input]);
  return settled;
}

/**
 * ワークスペースへの招待（F-08）。**オーナーにだけ出すのは画面の出し分けであり、権限の根拠ではない**（判定は api。CLAUDE.md 2）。
 * 招待できたら入力を空にし、誰を招待したかを出す（承諾されるまで参加は成立しない。F-38）。
 * **入力に合わせて候補を出し、押せばその人のユーザーID で招待する**（ユーザーID を正確に知らなくても招待できる。#616）。
 * 候補を読むのは入力が止まってから（打つたびに読むと、1分 60 回の上限に当たる）。空白だけなら読まない。
 */
function InviteForm({ workspaceId }: { workspaceId: string }) {
  const invite = useInviteToWorkspace(workspaceId);
  const [userId, setUserId] = useState('');
  const q = useSettledQuery(userId);
  const candidates = useInvitationCandidates(workspaceId, q);

  function send(target: string) {
    invite.mutate({ userId: target }, { onSuccess: () => setUserId('') });
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    send(userId);
  }

  return (
    <form className="mt-8 flex flex-col gap-2" onSubmit={submit}>
      <label htmlFor="invitee-user-id">招待するユーザーID</label>
      <input
        id="invitee-user-id"
        className="rounded border px-2 py-1"
        required
        pattern="[A-Za-z0-9_]{3,30}"
        value={userId}
        onChange={(event) => setUserId(event.target.value)}
      />
      {q !== null &&
        userId.trim() !== '' &&
        candidates.data &&
        (candidates.data.length === 0 ? (
          <p className="text-sm text-slate-600">招待できる利用者は見つかりません。</p>
        ) : (
          <ul aria-label="招待の候補" className="flex flex-col gap-1 rounded border p-2">
            {candidates.data.map((candidate) => (
              <li key={candidate.id} className="flex flex-wrap items-center gap-2">
                <span>{`${candidate.displayName} @${candidate.userId}`}</span>
                <button
                  type="button"
                  className="text-sm underline disabled:opacity-50"
                  aria-label={`${candidate.displayName}（@${candidate.userId}）を招待する`}
                  disabled={invite.isPending}
                  onClick={() => send(candidate.userId)}
                >
                  招待する
                </button>
              </li>
            ))}
          </ul>
        ))}
      {invite.isError && (
        <p role="alert" className="text-red-700">
          {errorMessage(invite.error)}
        </p>
      )}
      {invite.isSuccess && (
        <p role="status" aria-label="招待の結果" className="text-slate-700">
          {`${invite.data.invitee.displayName}（@${invite.data.invitee.userId}）を招待しました。承諾されると参加します。`}
        </p>
      )}
      <button
        className="self-start rounded bg-slate-800 px-3 py-2 text-white disabled:opacity-50"
        disabled={invite.isPending}
      >
        招待する
      </button>
    </form>
  );
}

/**
 * ワークスペースからの退出（F-38）。**オーナーにも出す**——オーナーが押すと api が 403 `owner_cannot_leave` で断り、
 * **その理由を画面に出す**（F-38 の受け入れ条件「オーナーが退出しようとすると拒否され、理由が画面に表示される」）。
 * **送る前に確かめる**——抜けた利用者は自分では戻れない（オーナーに招待し直してもらう必要がある。F-38）。
 */
function LeaveWorkspace({ workspaceId }: { workspaceId: string }) {
  const leave = useLeaveWorkspace(workspaceId);
  const navigate = useNavigate();

  function confirmAndLeave() {
    if (
      !window.confirm(
        'このワークスペースから退出しますか？ 戻るには、オーナーに招待し直してもらう必要があります。',
      )
    ) {
      return;
    }
    leave.mutate(undefined, { onSuccess: () => navigate('/workspaces') });
  }

  return (
    <div className="mt-8 flex flex-col gap-2">
      <button
        type="button"
        className="self-start rounded border border-red-700 px-3 py-2 text-red-700 disabled:opacity-50"
        disabled={leave.isPending}
        onClick={confirmAndLeave}
      >
        このワークスペースから退出する
      </button>
      {leave.isError && (
        <p role="alert" className="text-red-700">
          {errorMessage(leave.error)}
        </p>
      )}
    </div>
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
