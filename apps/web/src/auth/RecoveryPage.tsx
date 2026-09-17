import { type FormEvent, useState } from 'react';
import { Link } from 'react-router';
import { failureMessage } from './failure-message';
import { LOSS_WARNING, RecoveryCodeNotice } from './RecoveryCodeNotice';
import { recover } from './recover';

/**
 * リカバリーコードによるパスワードの再設定（F-37。機能一覧 1.1）。通ったら新しいコードを1度だけ見せる。
 * **違うときの文はログインと分ける**——api の `invalid_credentials` は、ここではユーザーID かリカバリーコードが違うことを表す。
 */
export function RecoveryPage() {
  const [userId, setUserId] = useState('');
  const [recoveryCode, setRecoveryCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [issuedCode, setIssuedCode] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setMessage(null);
    const result = await recover({ userId, recoveryCode, newPassword });
    setPending(false);
    if (result.ok) setIssuedCode(result.recoveryCode);
    else if (result.code === 'invalid_credentials') {
      setMessage('ユーザーID かリカバリーコードが違います（一度使ったコードは使えません）。');
    } else setMessage(failureMessage(result));
  }

  if (issuedCode !== null) {
    return (
      <RecoveryCodeNotice
        lead="パスワードを再設定しました。使ったリカバリーコードは、もう使えません。次の新しいコードを控えてください。この画面を離れると、二度と表示できません。"
        recoveryCode={issuedCode}
      />
    );
  }

  return (
    <main className="mx-auto max-w-sm p-8">
      <h1 className="text-2xl font-bold">パスワードの再設定</h1>
      <p className="mt-4 text-sm text-red-700">{LOSS_WARNING}</p>
      <form className="mt-6 flex flex-col gap-4" onSubmit={submit}>
        <div className="flex flex-col gap-1">
          <label htmlFor="recovery-userId">ユーザーID</label>
          <input
            id="recovery-userId"
            className="rounded border px-2 py-1"
            name="userId"
            autoComplete="username"
            required
            value={userId}
            onChange={(event) => setUserId(event.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="recovery-code">リカバリーコード</label>
          <input
            id="recovery-code"
            className="rounded border px-2 py-1 font-mono"
            name="recoveryCode"
            autoComplete="off"
            required
            aria-describedby="recovery-code-hint"
            value={recoveryCode}
            onChange={(event) => setRecoveryCode(event.target.value)}
          />
          <span id="recovery-code-hint" className="text-xs text-slate-600">
            登録（または前回の再設定）で控えた16文字。ハイフンと大文字小文字は問いません
          </span>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="recovery-newPassword">新しいパスワード</label>
          <input
            id="recovery-newPassword"
            className="rounded border px-2 py-1"
            name="newPassword"
            type="password"
            autoComplete="new-password"
            required
            aria-describedby="recovery-newPassword-hint"
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
          />
          <span id="recovery-newPassword-hint" className="text-xs text-slate-600">
            8〜128文字
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
          再設定する
        </button>
      </form>
      <p className="mt-6 text-sm">
        <Link to="/login">ログインの画面へ戻る</Link>
      </p>
    </main>
  );
}
