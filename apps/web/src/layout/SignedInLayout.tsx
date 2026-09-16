import { useState } from 'react';
import { Link, Outlet } from 'react-router';
import { failureMessage } from '../auth/failure-message';
import { useSession, useSessionStore } from '../auth/session-context';
import { useRealtime } from '../realtime/realtime-context';
import { useInvitationRealtime } from '../realtime/use-invitation-realtime';
import { useMyInvitations } from '../workspaces/queries';

/**
 * ログインした画面の共通の枠。表示名とログアウトを持ち、リアルタイムの接続を断られたら理由を出す。
 * **未承諾の招待があれば、どの画面にいても件数を出す**（F-38「招待された側に通知が出る」。一覧の画面を開いたときだけにしない）。
 */
export function SignedInLayout() {
  const store = useSessionStore();
  const session = useSession();
  const { refused } = useRealtime();
  const invitations = useMyInvitations();
  useInvitationRealtime();
  const pendingInvitations = invitations.data?.length ?? 0;
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function logout() {
    setPending(true);
    setMessage(null);
    const result = await store.logout();
    if (!result.ok) {
      setMessage('ログアウトできませんでした。時間をおいて、やり直してください。');
      setPending(false);
    }
  }

  return (
    <div className="min-h-screen">
      <header className="flex items-center justify-between gap-4 border-b px-6 py-3">
        <Link to="/workspaces" className="font-bold">
          workspace-chat
        </Link>
        <div className="flex items-center gap-3">
          {pendingInvitations > 0 && (
            <Link to="/workspaces" className="rounded bg-amber-100 px-2 py-0.5 underline">
              {`招待 ${pendingInvitations} 件`}
            </Link>
          )}
          {session.status === 'signedIn' && <span>{session.user.displayName}</span>}
          <Link to="/settings" className="underline">
            設定
          </Link>
          <button
            type="button"
            className="rounded border px-3 py-1 disabled:opacity-50"
            disabled={pending}
            onClick={logout}
          >
            ログアウト
          </button>
        </div>
      </header>
      {message && (
        <p role="alert" className="px-6 pt-4 text-red-700">
          {message}
        </p>
      )}
      {refused && (
        <p role="alert" className="px-6 pt-4 text-red-700">
          リアルタイムの反映に接続できませんでした。{failureMessage(refused)}
        </p>
      )}
      <Outlet />
    </div>
  );
}
