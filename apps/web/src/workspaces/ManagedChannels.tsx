import { useState } from 'react';
import { errorMessage } from '../api/client';
import { ChannelMembers } from './MemberLists';
import {
  type ManagedChannel,
  useArchiveChannel,
  useManagedChannels,
  useRestoreChannel,
} from './queries';

/**
 * オーナーの管理用のチャンネル一覧（F-35・機能一覧 3.1・3.2）。**オーナーにだけ置く**（出し分けは画面の配慮で、判定は api。CLAUDE.md 2）。
 *
 * - **一覧は「チャンネルを管理する」を押したときにだけ読む**
 * - 参加していないプライベートとアーカイブ済みも並べ、名前・種別・参加者数・アーカイブ済みかだけを出す
 *   （メッセージ・添付ファイル・未読数・在席は、api も返さない）
 * - **アーカイブは送る前に確かめる**——投稿・返信・編集・削除と、参加・招待ができなくなる。復元はオーナーが行える
 * - **各チャンネルで参加者を見て外せる**——参加していないプライベート・アーカイブ済みのチャンネルからも（F-09。#539 から回した分）
 */
export function ManagedChannels({ workspaceId }: { workspaceId: string }) {
  const [open, setOpen] = useState(false);
  const channels = useManagedChannels(workspaceId, open);
  const archive = useArchiveChannel(workspaceId);
  const restore = useRestoreChannel(workspaceId);
  // **出す理由は、直前の操作のものだけにする**——アーカイブと復元の失敗を合わせて出すため、操作の前にもう一方の結果を消す
  // （消さないと、アーカイブが断られた後に復元が通っても、アーカイブの理由が残る。#534 と同じ型）
  const failed = archive.error ?? restore.error;

  function onRestore(channel: ManagedChannel) {
    archive.reset();
    restore.mutate(channel.id);
  }

  function confirmAndArchive(channel: ManagedChannel) {
    if (
      !window.confirm(
        `${channel.name} をアーカイブしますか？ 投稿・返信・編集・削除と、参加・招待ができなくなります（オーナーは復元できます）。`,
      )
    ) {
      return;
    }
    restore.reset();
    archive.mutate(channel.id);
  }

  return (
    <section className="mt-8">
      <button
        type="button"
        className="underline"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        チャンネルを管理する
      </button>
      {open && channels.isError && (
        <p role="alert" className="mt-2 text-red-700">
          管理用のチャンネル一覧を読み込めませんでした。{errorMessage(channels.error)}
        </p>
      )}
      {open && channels.data && (
        <ul aria-label="管理用のチャンネル一覧" className="mt-2 flex flex-col gap-3">
          {channels.data.map((channel) => (
            <li key={channel.id} className="flex flex-col gap-1">
              <div className="flex flex-wrap items-center gap-2">
                <span>{`# ${channel.name}`}</span>
                {channel.visibility === 'PRIVATE' && (
                  <span className="text-sm text-slate-600">プライベート</span>
                )}
                <span className="text-sm text-slate-600">{`参加者 ${channel.memberCount} 人`}</span>
                {channel.archived && <span className="text-sm text-slate-600">アーカイブ済み</span>}
                {channel.archived ? (
                  <button
                    type="button"
                    className="text-sm underline disabled:opacity-50"
                    aria-label={`${channel.name} を復元する`}
                    disabled={restore.isPending}
                    onClick={() => onRestore(channel)}
                  >
                    復元する
                  </button>
                ) : (
                  <button
                    type="button"
                    className="text-sm text-red-700 underline disabled:opacity-50"
                    aria-label={`${channel.name} をアーカイブする`}
                    disabled={archive.isPending}
                    onClick={() => confirmAndArchive(channel)}
                  >
                    アーカイブする
                  </button>
                )}
              </div>
              <ChannelMembers workspaceId={workspaceId} channelId={channel.id} isOwner />
            </li>
          ))}
        </ul>
      )}
      {failed && (
        <p role="alert" className="mt-2 text-red-700">
          {errorMessage(failed)}
        </p>
      )}
    </section>
  );
}
