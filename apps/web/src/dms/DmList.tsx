import { type FormEvent, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { errorMessage } from '../api/client';
import { useSession } from '../auth/session-context';
import { useWorkspaceMembers } from '../workspaces/queries';
import { type Dm, useDms, useStartDm } from './queries';

/** 相手の表示名。退会した相手は「削除済みの利用者」（機能一覧 1.5）。 */
export function counterpartName(dm: Dm): string {
  return dm.counterpart?.displayName ?? '削除済みの利用者';
}

/**
 * ワークスペースの画面の DM（F-19。機能一覧 8）。自分が当事者の DM を並べ、相手を選んで始める。
 * **未読のある DM は太字にし、件数を文字でも出す**（機能一覧 10.1。太字は装飾であり、支援技術には伝わらない——チャンネルと同じ）。
 */
export function DmList({ workspaceId }: { workspaceId: string }) {
  const dms = useDms(workspaceId);

  return (
    <section className="mt-8">
      <h2 className="font-bold">ダイレクトメッセージ</h2>
      {dms.isError && (
        <p role="alert" className="mt-2 text-red-700">
          DM を読み込めませんでした。{errorMessage(dms.error)}
        </p>
      )}
      {dms.data &&
        (dms.data.length === 0 ? (
          <p className="mt-2 text-sm text-slate-600">DM はまだありません。</p>
        ) : (
          <ul aria-label="DM" className="mt-2 flex flex-col gap-2">
            {dms.data.map((dm) => (
              <li key={dm.id} className="flex items-center gap-3">
                <Link
                  to={`/workspaces/${workspaceId}/dms/${dm.id}`}
                  className={dm.unread > 0 ? 'font-bold underline' : 'underline'}
                >
                  {counterpartName(dm)}
                </Link>
                {dm.unread > 0 && (
                  <span className="text-sm text-slate-600">{`未読 ${dm.unread} 件`}</span>
                )}
              </li>
            ))}
          </ul>
        ))}
      <StartDm workspaceId={workspaceId} />
    </section>
  );
}

/**
 * DM を始める（F-19）。**相手の候補はワークスペースのメンバーを押したときにだけ読み**（画面を開くたびに読まない）、自分は出さない。
 * 出し分けは画面の配慮であり、相手がメンバーかの判定は api（422 `dm_counterpart_not_found`）。始めたら（既にあればそれを開き）DM の画面へ移る。
 */
function StartDm({ workspaceId }: { workspaceId: string }) {
  const [open, setOpen] = useState(false);
  const [counterpartId, setCounterpartId] = useState('');
  const members = useWorkspaceMembers(workspaceId, open);
  const start = useStartDm(workspaceId);
  const navigate = useNavigate();
  const session = useSession();
  const me = session.status === 'signedIn' ? session.user.id : null;
  const candidates = members.data?.filter((member) => member.id !== me) ?? [];
  const selected = candidates.some((member) => member.id === counterpartId)
    ? counterpartId
    : (candidates[0]?.id ?? '');

  function submit(event: FormEvent) {
    event.preventDefault();
    if (selected === '') return;
    // **`mutate` の `onSuccess` に移動を置く**——この部品は移るまで消えない（一覧に足しても、この部品は残る）
    start.mutate(selected, {
      onSuccess: (dm) => navigate(`/workspaces/${workspaceId}/dms/${dm.id}`),
    });
  }

  return (
    <div className="mt-2">
      <button
        type="button"
        className="text-sm underline"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        DM を始める
      </button>
      {open && members.isError && (
        <p role="alert" className="mt-2 text-red-700">
          メンバーを読み込めませんでした。{errorMessage(members.error)}
        </p>
      )}
      {open && members.data && (
        <form className="mt-2 flex flex-col gap-2" onSubmit={submit}>
          <label htmlFor="dm-counterpart">DM の相手</label>
          <select
            id="dm-counterpart"
            className="rounded border px-2 py-1"
            value={selected}
            onChange={(event) => setCounterpartId(event.target.value)}
          >
            {candidates.map((member) => (
              <option key={member.id} value={member.id}>
                {`${member.displayName} @${member.userId}`}
              </option>
            ))}
          </select>
          {start.isError && (
            <p role="alert" className="text-red-700">
              {errorMessage(start.error)}
            </p>
          )}
          <button
            className="self-start rounded bg-slate-800 px-3 py-2 text-white disabled:opacity-50"
            disabled={start.isPending || selected === ''}
          >
            DM を開く
          </button>
        </form>
      )}
    </div>
  );
}
