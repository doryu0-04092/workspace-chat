import { type FormEvent, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { errorMessage } from '../api/client';
import {
  useAcceptInvitation,
  useCreateWorkspace,
  useDeclineInvitation,
  useMyInvitations,
  useWorkspaces,
} from './queries';

/**
 * 届いた招待（F-38）。ワークスペース名と、招待したオーナーの表示名・ユーザーID を出し、承諾か辞退かを選ばせる
 * （**どこの誰からの招待かが分からないと、選べない**。機能一覧 F-38 の受け入れ条件）。
 */
function ReceivedInvitations() {
  const invitations = useMyInvitations();
  const accept = useAcceptInvitation();
  const decline = useDeclineInvitation();
  // **出す理由は、直前の操作のものだけにする**——承諾と辞退の失敗を合わせて出すため、操作の前にもう一方の結果を消す
  const failed = accept.error ?? decline.error;

  function onAccept(invitationId: string) {
    decline.reset();
    accept.mutate(invitationId);
  }

  function onDecline(invitationId: string) {
    accept.reset();
    decline.mutate(invitationId);
  }

  // **読めなかったことを黙らない**——黙ると、届いている招待が見えないまま、利用者は無いと思い込む
  if (invitations.isError) {
    return (
      <p role="alert" className="mt-4 text-red-700">
        届いた招待を読み込めませんでした。{errorMessage(invitations.error)}
      </p>
    );
  }
  if (!invitations.data || invitations.data.length === 0) return null;
  const pending = accept.isPending || decline.isPending;
  return (
    <section className="mt-4">
      <h2 className="text-lg font-bold">届いた招待</h2>
      <ul aria-label="届いた招待" className="mt-2 flex flex-col gap-2">
        {invitations.data.map((invitation) => (
          <li key={invitation.id} className="flex flex-wrap items-center gap-3">
            <span>
              <span className="font-bold">{invitation.workspace.name}</span>
              {`（${invitation.invitedBy.displayName} @${invitation.invitedBy.userId} から）`}
            </span>
            <button
              type="button"
              className="rounded bg-slate-800 px-2 py-0.5 text-sm text-white disabled:opacity-50"
              aria-label={`${invitation.workspace.name} への招待を承諾する`}
              disabled={pending}
              onClick={() => onAccept(invitation.id)}
            >
              承諾する
            </button>
            <button
              type="button"
              className="rounded border px-2 py-0.5 text-sm disabled:opacity-50"
              aria-label={`${invitation.workspace.name} への招待を辞退する`}
              disabled={pending}
              onClick={() => onDecline(invitation.id)}
            >
              辞退する
            </button>
          </li>
        ))}
      </ul>
      {failed && (
        <p role="alert" className="mt-2 text-red-700">
          {errorMessage(failed)}
        </p>
      )}
    </section>
  );
}

/** ワークスペースの一覧と作成（F-06）。作成したら、そのワークスペースの画面へ移る。届いた招待もここで選ぶ（F-38）。 */
export function WorkspacesPage() {
  const workspaces = useWorkspaces();
  const create = useCreateWorkspace();
  const navigate = useNavigate();
  const [name, setName] = useState('');

  function submit(event: FormEvent) {
    event.preventDefault();
    create.mutate({ name }, { onSuccess: (workspace) => navigate(`/workspaces/${workspace.id}`) });
  }

  return (
    <main className="mx-auto max-w-xl p-6">
      <h1 className="text-2xl font-bold">ワークスペース</h1>
      <ReceivedInvitations />
      {workspaces.isPending && (
        <p role="status" className="mt-4 text-slate-600">
          読み込み中…
        </p>
      )}
      {workspaces.isError && (
        <p role="alert" className="mt-4 text-red-700">
          ワークスペースを読み込めませんでした。{errorMessage(workspaces.error)}
        </p>
      )}
      {workspaces.data?.length === 0 && (
        <p className="mt-4">所属しているワークスペースはありません。</p>
      )}
      {workspaces.data && workspaces.data.length > 0 && (
        <ul aria-label="所属するワークスペース" className="mt-4 flex flex-col gap-2">
          {workspaces.data.map((workspace) => (
            <li key={workspace.id}>
              <Link to={`/workspaces/${workspace.id}`} className="underline">
                {workspace.name}
              </Link>
            </li>
          ))}
        </ul>
      )}

      <form className="mt-8 flex flex-col gap-2" onSubmit={submit}>
        <label htmlFor="workspace-name">ワークスペース名</label>
        <input
          id="workspace-name"
          className="rounded border px-2 py-1"
          required
          maxLength={50}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        {create.isError && (
          <p role="alert" className="text-red-700">
            {errorMessage(create.error)}
          </p>
        )}
        <button
          className="self-start rounded bg-slate-800 px-3 py-2 text-white disabled:opacity-50"
          disabled={create.isPending}
        >
          ワークスペースを作成する
        </button>
      </form>
    </main>
  );
}
