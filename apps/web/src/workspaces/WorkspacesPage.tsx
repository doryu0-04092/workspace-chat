import { type FormEvent, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { errorMessage } from '../api/client';
import { useCreateWorkspace, useWorkspaces } from './queries';

/** ワークスペースの一覧と作成（F-06）。作成したら、そのワークスペースの画面へ移る。 */
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
