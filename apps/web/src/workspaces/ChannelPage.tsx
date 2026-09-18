import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { ApiError, errorMessage } from '../api/client';
import { failureMessage } from '../auth/failure-message';
import { FileCookiesReady, useChannelFileCookies } from '../delivery/signed-cookies';
import { MessageChannelProvider } from '../messages/message-channel';
import { MessageList } from '../messages/MessageList';
import { PinnedMessages } from '../messages/PinnedMessages';
import { PostMessageForm } from '../messages/PostMessageForm';
import { useMessages } from '../messages/queries';
import { ThreadPanel } from '../messages/ThreadPanel';
import { TypingIndicator } from '../messages/TypingIndicator';
import { useChannelRealtime } from '../realtime/use-channel-realtime';
import { useHereReceipt } from '../realtime/use-here-receipt';
import { ChannelMembers, InviteToChannel } from './MemberLists';
import {
  type Channel,
  useArchivedChannels,
  useChannels,
  useLeaveChannel,
  useUpdateChannelRead,
  useWorkspace,
} from './queries';

/** 開いているスレッドの親の id を持つ URL のパラメータ（機能一覧 6。開き直しても同じスレッドを開く）。 */
const THREAD_PARAM = 'thread';

/** チャンネルの画面。参加しているチャンネルだけを開き、メッセージの一覧・投稿・スレッド・リアルタイムの反映を置く（F-11・F-12・F-16・F-17）。 */
export function ChannelPage() {
  const { workspaceId = '', channelId = '' } = useParams();
  const channels = useChannels(workspaceId);
  // オーナーかどうか（参加者の一覧で「チャンネルから外す」を出すため。F-09。判定は api）
  const workspace = useWorkspace(workspaceId);
  const current = channels.data?.find((c) => c.id === channelId && c.joined);
  // **一般の一覧に無ければ、自分が参加しているアーカイブ済みのチャンネルから探す**（参加者は読める。機能一覧 3.2）
  const archived = useArchivedChannels(workspaceId, channels.isSuccess && !current);
  const channel = current ?? archived.data?.find((c) => c.id === channelId);

  if (channels.isPending || (channels.isSuccess && !current && archived.isPending)) {
    return (
      <p role="status" className="p-6 text-slate-600">
        読み込み中…
      </p>
    );
  }
  // 一覧の読み込みの失敗を「無い」と言い換えない（404 だけが「見つかりません」。ワークスペースの画面と同じ見せ方。#431）
  const loadError = channels.isError ? channels.error : !current ? archived.error : null;
  if (
    !channel &&
    loadError &&
    !(loadError instanceof ApiError && loadError.failure.status === 404)
  ) {
    return (
      <main className="mx-auto max-w-xl p-6">
        <p role="alert" className="text-red-700">
          チャンネルを読み込めませんでした。{errorMessage(loadError)}
        </p>
        <Link to={`/workspaces/${workspaceId}`} className="underline">
          チャンネルの一覧へ
        </Link>
      </main>
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
      {!current && (
        <p className="mt-2 rounded bg-slate-100 px-3 py-2 text-sm">
          アーカイブ済みのチャンネルです。読むことだけができます（投稿・返信・編集・削除はできません）。
        </p>
      )}
      <LeaveChannel key={`leave-${channelId}`} workspaceId={workspaceId} channel={channel} />
      {/* アーカイブ済みのチャンネルには人を増やせない（機能一覧 3.2。api も 409 で断る） */}
      {current && channel.visibility === 'PRIVATE' && (
        <InviteToChannel
          key={`invite-${channelId}`}
          workspaceId={workspaceId}
          channelId={channelId}
        />
      )}
      <ChannelMembers
        key={`members-${channelId}`}
        workspaceId={workspaceId}
        channelId={channelId}
        isOwner={workspace.data?.role === 'OWNER'}
      />
      <ChannelMessages
        key={channelId}
        workspaceId={workspaceId}
        channelId={channelId}
        lastReadMessageId={channel.lastReadMessageId ?? null}
        joinedAt={channel.joinedAt ?? null}
        readOnly={!current}
      />
    </main>
  );
}

/**
 * チャンネルから抜ける（F-10）。確かめてから送り、通ったらワークスペースの画面へ移る。
 * プライベートは、抜けると招待されない限り戻れないことを確かめの文で伝える。
 */
function LeaveChannel({ workspaceId, channel }: { workspaceId: string; channel: Channel }) {
  const leave = useLeaveChannel(workspaceId, channel.id);
  const navigate = useNavigate();

  function confirmAndLeave() {
    const question =
      channel.visibility === 'PRIVATE'
        ? 'このチャンネルから抜けますか？ 戻るには、招待し直してもらう必要があります。'
        : 'このチャンネルから抜けますか？';
    if (!window.confirm(question)) return;
    // **`mutate` の `onSuccess` には移動を置かない**——通った時点で一覧から参加が外れてこの部品が消え、部品ごとの `onSuccess` は呼ばれない。
    // 断られた理由は `leave.error` で出す
    leave.mutateAsync().then(
      () => navigate(`/workspaces/${workspaceId}`),
      () => {},
    );
  }

  return (
    <div className="mt-2 flex flex-col gap-1">
      <button
        type="button"
        className="self-start rounded border border-red-700 px-2 py-0.5 text-sm text-red-700 disabled:opacity-50"
        disabled={leave.isPending}
        onClick={confirmAndLeave}
      >
        このチャンネルから抜ける
      </button>
      {leave.isError && (
        <p role="alert" className="text-red-700">
          {errorMessage(leave.error)}
        </p>
      )}
    </div>
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
  joinedAt,
  readOnly,
}: {
  workspaceId: string;
  channelId: string;
  lastReadMessageId: string | null;
  joinedAt: string | null;
  /** アーカイブ済み（読むだけ。投稿・返信・編集・削除の操作を出さない。機能一覧 3.2） */
  readOnly: boolean;
}) {
  const rejected = useChannelRealtime(workspaceId, channelId);
  // 添付の配信の Cookie は、参加しているチャンネルを開いている間だけ取り直す（機能一覧 11.2）
  const filesReady = useChannelFileCookies(workspaceId, channelId);
  // 開いているチャンネルの @here にだけ受け取りを返す（F-21）
  useHereReceipt(channelId);
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
    // 一覧とスレッドの自分のメッセージに、編集・削除を出すため（F-13）
    <MessageChannelProvider workspaceId={workspaceId} channelId={channelId} readOnly={readOnly}>
      <FileCookiesReady value={filesReady}>
        {rejected && (
          <p role="alert" className="mt-4 text-red-700">
            リアルタイムの反映を始められませんでした。{failureMessage(rejected)}
          </p>
        )}
        {/* チャンネルのピン留めの一覧（F-33）。付け外しの操作は、アーカイブ済みでないときだけ出す */}
        <PinnedMessages />
        <div className={threadId ? 'md:grid md:grid-cols-2 md:gap-4' : undefined}>
          <div>
            {/* 入力欄は一覧の上に置く（最新も上に来るため、下までスクロールしない。#608） */}
            {!readOnly && (
              <>
                <PostMessageForm workspaceId={workspaceId} channelId={channelId} />
                <TypingIndicator channelId={channelId} />
              </>
            )}
            <section aria-label="メッセージの一覧" className="mt-4">
              <MessageList
                workspaceId={workspaceId}
                channelId={channelId}
                onOpenThread={(message) => setThread(message.id)}
                lastReadMessageId={unreadFrom}
                joinedAt={joinedAt}
              />
            </section>
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
      </FileCookiesReady>
    </MessageChannelProvider>
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
  // 最新のページは新しい順で、その先頭の**削除されていない本体**が、既読位置に送れる中でいちばん新しい。
  // **一覧は削除済みも返すが、api の既読の更新は削除済みの id を 404 で断る**（channels.service.ts の updateRead）——
  // 条件を揃えないと、最後の投稿が消されただけで既読が進まなくなり、読んでもそのチャンネルは未読のまま残る
  const newestId =
    messages.data?.pages[0]?.messages.find((m) => m.parentId === null && !m.deleted)?.id ?? null;

  // **同じ位置は送り直さない**——効果の依存が位置そのものであり、変わらないうちは走らない
  useEffect(() => {
    if (newestId !== null) advance(newestId);
  }, [newestId, advance]);
}
