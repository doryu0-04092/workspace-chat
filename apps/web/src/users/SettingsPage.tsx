import { type FormEvent, useState } from 'react';
import { errorMessage } from '../api/client';
import { useDeleteAccount, useUpdateUserSettings, useUserSettings } from './queries';

/** 利用者ごとの設定の画面（F-23。機能一覧 10.1）。**プロフィールとは別の画面である**。アカウントの削除（F-36）もここに置く。 */
export function SettingsPage() {
  const settings = useUserSettings();
  const update = useUpdateUserSettings();

  return (
    <main className="mx-auto max-w-xl p-6">
      <h1 className="text-2xl font-bold">設定</h1>
      {settings.isError && (
        <p role="alert" className="mt-4 text-red-700">
          設定を読み込めませんでした。{errorMessage(settings.error)}
        </p>
      )}
      {settings.data && (
        <label className="mt-4 flex items-center gap-2">
          <input
            type="checkbox"
            checked={settings.data.threadUnreadIncluded}
            disabled={update.isPending}
            onChange={(event) => update.mutate({ threadUnreadIncluded: event.target.checked })}
          />
          スレッドの未読をチャンネルの未読に含める
        </label>
      )}
      {update.isError && (
        <p role="alert" className="mt-4 text-red-700">
          設定を変えられませんでした。{errorMessage(update.error)}
        </p>
      )}
      <DeleteAccount />
    </main>
  );
}

/**
 * アカウントの削除（F-36。機能一覧 1.5）。**パスワードの再入力を求め、送る前に確かめる**——削除は元に戻せない。
 * オーナーでも出す——オーナーが送ると api が 403 `owner_cannot_delete_account` で断り、その理由を画面に出す（1.5 の受け入れ条件）。
 * 削除できたら、ログインしていない状態になり、ログインの画面へ移る（RequireSignedIn）。
 */
function DeleteAccount() {
  const remove = useDeleteAccount();
  const [password, setPassword] = useState('');

  function submit(event: FormEvent) {
    event.preventDefault();
    if (
      !window.confirm(
        'アカウントを削除しますか？ 元に戻せません。同じユーザーID でも、二度とログインできなくなります。',
      )
    ) {
      return;
    }
    remove.mutate({ password });
  }

  return (
    <section aria-labelledby="delete-account-heading" className="mt-12 border-t pt-6">
      <h2 id="delete-account-heading" className="text-xl font-bold text-red-700">
        アカウントの削除
      </h2>
      <p className="mt-2">
        削除すると元に戻せません。このアカウントではログインできなくなり、同じユーザーID
        を新しく登録することもできません。投稿したメッセージは残り、「削除済みの利用者」として表示されます。
      </p>
      <p className="mt-2">
        ワークスペースのオーナーは削除できません（オーナーの権限を他の人に渡す機能が無いためです）。
      </p>
      <form className="mt-4 flex flex-col gap-2" onSubmit={submit}>
        <label htmlFor="delete-account-password">今のパスワード</label>
        <input
          id="delete-account-password"
          type="password"
          autoComplete="current-password"
          className="rounded border px-2 py-1"
          required
          maxLength={128}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        {remove.isError && (
          <p role="alert" className="text-red-700">
            {errorMessage(remove.error)}
          </p>
        )}
        <button
          className="self-start rounded border border-red-700 px-3 py-2 text-red-700 disabled:opacity-50"
          disabled={remove.isPending}
        >
          アカウントを削除する
        </button>
      </form>
    </section>
  );
}
