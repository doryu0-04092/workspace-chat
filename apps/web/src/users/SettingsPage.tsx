import { errorMessage } from '../api/client';
import { useUpdateUserSettings, useUserSettings } from './queries';

/** 利用者ごとの設定の画面（F-23。機能一覧 10.1）。**プロフィールとは別の画面である**。 */
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
    </main>
  );
}
