import { type FormEvent, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { failureMessage } from './failure-message';
import { register } from './register';

const LOSS_WARNING =
  'リカバリーコードを失うと、アカウントを復旧できません。パスワードを忘れたときの唯一の手段です（メールでの再設定はありません）。';

/**
 * 新規登録（F-01・F-37）。登録するとリカバリーコードを1度だけ見せ、控えたことを選ぶまで先へ進めない（機能一覧 1.1）。
 * **コードはこの部品の状態にだけ持ち、保存しない。** 画面を離れれば消え、再表示はできない。
 */
export function RegisterPage() {
  const navigate = useNavigate();
  const [userId, setUserId] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [recoveryCode, setRecoveryCode] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setMessage(null);
    const result = await register({ userId, password, displayName });
    setPending(false);
    if (result.ok) setRecoveryCode(result.recoveryCode);
    else setMessage(failureMessage(result));
  }

  if (recoveryCode !== null) {
    return (
      <main className="mx-auto max-w-sm p-8">
        <h1 className="text-2xl font-bold">リカバリーコード</h1>
        <p className="mt-4">
          登録しました。次のコードを控えてください。この画面を離れると、二度と表示できません。
        </p>
        <p className="mt-4 rounded bg-slate-100 p-3 text-center font-mono text-lg">
          {recoveryCode}
        </p>
        <p className="mt-4 text-red-700">{LOSS_WARNING}</p>
        <label className="mt-6 flex items-center gap-2">
          <input
            type="checkbox"
            checked={saved}
            onChange={(event) => setSaved(event.target.checked)}
          />
          リカバリーコードを控えました
        </label>
        <button
          type="button"
          className="mt-4 w-full rounded bg-slate-800 px-3 py-2 text-white disabled:opacity-50"
          disabled={!saved}
          onClick={() => navigate('/login', { replace: true })}
        >
          ログインの画面へ進む
        </button>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-sm p-8">
      <h1 className="text-2xl font-bold">新規登録</h1>
      <p className="mt-4 text-sm text-red-700">{LOSS_WARNING}</p>
      <form className="mt-6 flex flex-col gap-4" onSubmit={submit}>
        {/* 条件の文は label の外に置き、aria-describedby で結ぶ（label の中に置くと、項目の名前に条件の文が混ざる） */}
        <div className="flex flex-col gap-1">
          <label htmlFor="register-userId">ユーザーID</label>
          <input
            id="register-userId"
            className="rounded border px-2 py-1"
            name="userId"
            autoComplete="username"
            required
            pattern="[A-Za-z0-9_]{3,30}"
            aria-describedby="register-userId-hint"
            value={userId}
            onChange={(event) => setUserId(event.target.value)}
          />
          <span id="register-userId-hint" className="text-xs text-slate-600">
            英数字とアンダースコア、3〜30文字
          </span>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="register-password">パスワード</label>
          <input
            id="register-password"
            className="rounded border px-2 py-1"
            name="password"
            type="password"
            autoComplete="new-password"
            required
            minLength={8}
            maxLength={128}
            aria-describedby="register-password-hint"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          <span id="register-password-hint" className="text-xs text-slate-600">
            8〜128文字
          </span>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="register-displayName">表示名</label>
          <input
            id="register-displayName"
            className="rounded border px-2 py-1"
            name="displayName"
            required
            maxLength={50}
            aria-describedby="register-displayName-hint"
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
          />
          <span id="register-displayName-hint" className="text-xs text-slate-600">
            1〜50文字（空白だけは不可）
          </span>
        </div>
        {message && (
          <p role="alert" className="text-red-700">
            {message}
          </p>
        )}
        <button
          className="rounded bg-slate-800 px-3 py-2 text-white disabled:opacity-50"
          disabled={pending}
        >
          登録する
        </button>
      </form>
      <p className="mt-6 text-sm">
        アカウントがあれば <Link to="/login">ログイン</Link>
      </p>
    </main>
  );
}
