import { useState } from 'react';
import { errorMessage } from '../api/client';
import { useSession } from '../auth/session-context';
import {
  useChannelMembers,
  useInviteChannelMember,
  useKickChannelMember,
  useKickWorkspaceMember,
  useWorkspaceMembers,
} from './queries';

/** ログインしている利用者の id（出し分けで自分を除くため）。 */
function useSignedInUserId(): string | null {
  const session = useSession();
  return session.status === 'signedIn' ? session.user.id : null;
}

/**
 * ワークスペースのメンバー（F-06）と、オーナーによるキック（F-09。機能一覧 2.2）。
 *
 * - **一覧は「メンバーを見る」を押したときにだけ読む**（画面を開くたびに読まない）
 * - **「キックする」はオーナーにだけ、自分以外の相手に出す**——出し分けは画面の配慮であり、判定は api（CLAUDE.md 2）。
 *   オーナー自身は api も外せない（403 `owner_cannot_leave`）
 * - **キックは送る前に確かめる**——キックされた利用者は、そのワークスペースの全チャンネルから外れ、自分では戻れない
 */
export function WorkspaceMembers({
  workspaceId,
  isOwner,
}: {
  workspaceId: string;
  isOwner: boolean;
}) {
  const [open, setOpen] = useState(false);
  const members = useWorkspaceMembers(workspaceId, open);
  const kick = useKickWorkspaceMember(workspaceId);
  const me = useSignedInUserId();

  function confirmAndKick(memberId: string, displayName: string) {
    if (
      !window.confirm(
        `${displayName} をこのワークスペースからキックしますか？ 全てのチャンネルから外れます。`,
      )
    ) {
      return;
    }
    kick.mutate(memberId);
  }

  return (
    <section className="mt-8">
      <button
        type="button"
        className="underline"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        メンバーを見る
      </button>
      {open && members.isError && (
        <p role="alert" className="mt-2 text-red-700">
          メンバーを読み込めませんでした。{errorMessage(members.error)}
        </p>
      )}
      {open && members.data && (
        <ul aria-label="メンバー" className="mt-2 flex flex-col gap-1">
          {members.data.map((member) => (
            <li key={member.id} className="flex flex-wrap items-center gap-2">
              <span>{`${member.displayName} @${member.userId}`}</span>
              {member.role === 'OWNER' && <span className="text-sm text-slate-600">オーナー</span>}
              {isOwner && member.id !== me && (
                <button
                  type="button"
                  className="text-sm text-red-700 underline disabled:opacity-50"
                  aria-label={`${member.displayName} をキックする`}
                  disabled={kick.isPending}
                  onClick={() => confirmAndKick(member.id, member.displayName)}
                >
                  キックする
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {kick.isError && (
        <p role="alert" className="mt-2 text-red-700">
          {errorMessage(kick.error)}
        </p>
      )}
    </section>
  );
}

/**
 * チャンネルの参加者（F-10）と、オーナーによるチャンネルからのキック（F-09。そのチャンネルだけから外す。機能一覧 2.2）。
 * **一覧は「参加者を見る」を押したときにだけ読む。「チャンネルから外す」はオーナーにだけ、自分以外に出す**
 * （自分がチャンネルから抜ける操作は api にはある〔leaveChannel〕が、web にはまだ無い。#541）。
 * **外すのは送る前に確かめる。**
 */
export function ChannelMembers({
  workspaceId,
  channelId,
  isOwner,
}: {
  workspaceId: string;
  channelId: string;
  isOwner: boolean;
}) {
  const [open, setOpen] = useState(false);
  const members = useChannelMembers(workspaceId, channelId, open);
  const kick = useKickChannelMember(workspaceId, channelId);
  const me = useSignedInUserId();

  function confirmAndKick(memberId: string, displayName: string) {
    if (!window.confirm(`${displayName} をこのチャンネルから外しますか？`)) return;
    kick.mutate(memberId);
  }

  return (
    <section className="mt-4">
      <button
        type="button"
        className="text-sm underline"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        参加者を見る
      </button>
      {open && members.isError && (
        <p role="alert" className="mt-2 text-red-700">
          参加者を読み込めませんでした。{errorMessage(members.error)}
        </p>
      )}
      {open && members.data && (
        <ul aria-label="参加者" className="mt-2 flex flex-col gap-1">
          {members.data.map((member) => (
            <li key={member.id} className="flex flex-wrap items-center gap-2">
              <span>{`${member.displayName} @${member.userId}`}</span>
              {isOwner && member.id !== me && (
                <button
                  type="button"
                  className="text-sm text-red-700 underline disabled:opacity-50"
                  aria-label={`${member.displayName} をチャンネルから外す`}
                  disabled={kick.isPending}
                  onClick={() => confirmAndKick(member.id, member.displayName)}
                >
                  チャンネルから外す
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {kick.isError && (
        <p role="alert" className="mt-2 text-red-700">
          {errorMessage(kick.error)}
        </p>
      )}
    </section>
  );
}

/**
 * プライベートチャンネルへの招待（F-08。参加者なら誰でも招待でき、招待した時点で参加する。判定は api）。
 * **候補は押したときにだけ読む**——ワークスペースのメンバーのうち、このチャンネルに参加していない人を並べる。
 */
export function InviteToChannel({
  workspaceId,
  channelId,
}: {
  workspaceId: string;
  channelId: string;
}) {
  const [open, setOpen] = useState(false);
  const members = useWorkspaceMembers(workspaceId, open);
  const participants = useChannelMembers(workspaceId, channelId, open);
  const invite = useInviteChannelMember(workspaceId, channelId);
  const failed = members.error ?? participants.error;
  const joined = new Set(participants.data?.map((participant) => participant.id));
  const candidates = members.data?.filter((member) => !joined.has(member.id));

  return (
    <section className="mt-4">
      <button
        type="button"
        className="text-sm underline"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        メンバーを招待する
      </button>
      {open && failed && (
        <p role="alert" className="mt-2 text-red-700">
          招待できるメンバーを読み込めませんでした。{errorMessage(failed)}
        </p>
      )}
      {open &&
        !failed &&
        candidates &&
        participants.data &&
        (candidates.length === 0 ? (
          <p className="mt-2 text-sm text-slate-600">招待できるメンバーはいません。</p>
        ) : (
          <ul aria-label="招待できるメンバー" className="mt-2 flex flex-col gap-1">
            {candidates.map((member) => (
              <li key={member.id} className="flex flex-wrap items-center gap-2">
                <span>{`${member.displayName} @${member.userId}`}</span>
                <button
                  type="button"
                  className="text-sm underline disabled:opacity-50"
                  aria-label={`${member.displayName} を招待する`}
                  disabled={invite.isPending}
                  onClick={() => invite.mutate(member)}
                >
                  招待する
                </button>
              </li>
            ))}
          </ul>
        ))}
      {invite.isError && (
        <p role="alert" className="mt-2 text-red-700">
          {errorMessage(invite.error)}
        </p>
      )}
    </section>
  );
}
