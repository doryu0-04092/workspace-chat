import { useState } from 'react';
import { useSession } from '../auth/session-context';
import {
  browserNotificationsEnabled,
  browserNotificationsSupported,
  setBrowserNotificationsEnabled,
} from './browser-notifications';

/**
 * ブラウザ通知の切り替え（F-25。機能一覧 10.2）。**通知の許可を求めるのは、利用者がここで有効にしたときだけ**（初回訪問で求めない）。
 * **許可が拒否されたら有効にせず、画面内の件数（F-24 のバッジ）で分かることを伝える**。
 */
export function BrowserNotificationSetting() {
  const session = useSession();
  const userId = session.status === 'signedIn' ? session.user.id : null;
  const supported = browserNotificationsSupported();
  const [enabled, setEnabled] = useState(
    () => userId !== null && browserNotificationsEnabled(userId),
  );
  const [denied, setDenied] = useState(() => supported && Notification.permission === 'denied');
  const [pending, setPending] = useState(false);

  async function toggle(next: boolean) {
    if (userId === null) return;
    setPending(true);
    const permission = await setBrowserNotificationsEnabled(userId, next);
    setPending(false);
    setDenied(permission === 'denied');
    setEnabled(browserNotificationsEnabled(userId));
  }

  return (
    <section className="mt-6">
      <h2 className="text-lg font-bold">ブラウザ通知</h2>
      {supported ? (
        <label className="mt-2 flex items-center gap-2">
          <input
            type="checkbox"
            checked={enabled}
            disabled={pending || userId === null}
            onChange={(event) => void toggle(event.target.checked)}
          />
          メンションをブラウザで通知する
        </label>
      ) : (
        <p className="mt-2">
          このブラウザは通知に対応していません。メンションは画面内の件数で分かります。
        </p>
      )}
      {supported && denied && (
        <p role="alert" className="mt-2 text-red-700">
          ブラウザが通知を拒否しています。通知を出すには、ブラウザのサイトの設定で許可してください。メンションは画面内の件数で分かります。
        </p>
      )}
      <p className="mt-2 text-sm text-slate-600">
        通知が届くのは、このタブを開いている間だけです。設定はこのブラウザにだけ残ります。
      </p>
    </section>
  );
}
