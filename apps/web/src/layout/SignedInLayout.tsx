import { useState } from 'react';
import { Link, Outlet } from 'react-router';
import { failureMessage } from '../auth/failure-message';
import { useSession, useSessionStore } from '../auth/session-context';
import { useMentionRealtime } from '../notifications/use-mention-realtime';
import { useAvatarCookies } from '../delivery/signed-cookies';
import { useRealtime } from '../realtime/realtime-context';
import { useInvitationRealtime } from '../realtime/use-invitation-realtime';
import { useMyProfile } from '../users/queries';
import { UserAvatar } from '../users/UserAvatar';
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
  // 自分へのメンションのブラウザ通知と、通知の一覧の読み直し（F-25・F-26）。どの画面にいても受ける
  useMentionRealtime();
  // アバターの配信の Cookie は、ログインしている間ずっと取り直す（機能一覧 1.3。どの画面にもアバターが出る）
  useAvatarCookies();
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
          {/* **読めなかったことを黙らない**——黙ると「招待が無い」と「読めなかった」が同じ見え方になる（一覧の画面と揃える） */}
          {invitations.isError && (
            <Link to="/workspaces" className="text-red-700 underline">
              招待を読み込めませんでした
            </Link>
          )}
          {pendingInvitations > 0 && (
            <Link to="/workspaces" className="rounded bg-amber-100 px-2 py-0.5 underline">
              {`招待 ${pendingInvitations} 件`}
            </Link>
          )}
          {session.status === 'signedIn' && <HeaderAvatar />}
          {session.status === 'signedIn' && <span>{session.user.displayName}</span>}
          <Link to="/profile" className="underline">
            プロフィール
          </Link>
          <Link to="/notifications" className="underline">
            通知
          </Link>
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

/**
 * 画面の枠のアバター画像（F-04。機能一覧 1.3）。プロフィールの画面と同じ読み込みを使い、上げ直したら読み直さずに変わる。
 * 表示は利用者の一覧と同じ UserAvatar（無い・読めないときは頭文字）。プロフィールを読み込むまでは何も出さない。
 */
function HeaderAvatar() {
  const profile = useMyProfile();
  return profile.data ? <UserAvatar user={profile.data} size="h-7 w-7" /> : null;
}
