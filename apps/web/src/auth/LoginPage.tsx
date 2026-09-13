import { type FormEvent, useState } from 'react';
import { Link } from 'react-router';
import { failureMessage } from './failure-message';
import { useSessionStore } from './session-context';

/** ログイン（F-02）。成功したら、行き先への移動は GuestOnly が行う。 */
export function LoginPage() {
  const store = useSessionStore();
  const [userId, setUserId] = useState('');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setMessage(null);
    const result = await store.login(userId, password);
    if (!result.ok) {
      setMessage(failureMessage(result));
      setPending(false);
    }
  }

  return (
    <main className="mx-auto max-w-sm p-8">
      <h1 className="text-2xl font-bold">ログイン</h1>
      <form className="mt-6 flex flex-col gap-4" onSubmit={submit}>
        <label className="flex flex-col gap-1">
          ユーザーID
          <input
            className="rounded border px-2 py-1"
            name="userId"
            autoComplete="username"
            required
            value={userId}
            onChange={(event) => setUserId(event.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1">
          パスワード
          <input
            className="rounded border px-2 py-1"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
        {message && (
          <p role="alert" className="text-red-700">
            {message}
          </p>
        )}
        <button
          className="rounded bg-slate-800 px-3 py-2 text-white disabled:opacity-50"
          disabled={pending}
        >
          ログイン
        </button>
      </form>
      <p className="mt-6 text-sm">
        アカウントが無ければ <Link to="/register">新規登録</Link>
      </p>
    </main>
  );
}
