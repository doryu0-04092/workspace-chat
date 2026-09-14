import { useState } from 'react';
import { Link, Outlet } from 'react-router';
import { useSession, useSessionStore } from '../auth/session-context';

/** ログインした画面の共通の枠。表示名とログアウトを持つ。 */
export function SignedInLayout() {
  const store = useSessionStore();
  const session = useSession();
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
          {session.status === 'signedIn' && <span>{session.user.displayName}</span>}
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
      <Outlet />
    </div>
  );
}
