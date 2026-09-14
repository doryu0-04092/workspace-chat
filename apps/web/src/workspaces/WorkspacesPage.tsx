import { useState } from 'react';
import { useSession, useSessionStore } from '../auth/session-context';

/** ワークスペースの画面。この段ではログインしている利用者の表示名とログアウトだけを持つ（中身は #379 の3つ目）。 */
export function WorkspacesPage() {
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
    <main className="p-8">
      <header className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-bold">ワークスペース</h1>
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
        <p role="alert" className="mt-4 text-red-700">
          {message}
        </p>
      )}
    </main>
  );
}
