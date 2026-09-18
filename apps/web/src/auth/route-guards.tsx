import { Navigate, Outlet, useLocation } from 'react-router';
import { useSession } from './session-context';

function Loading() {
  return (
    <p role="status" className="p-8 text-slate-600">
      読み込み中…
    </p>
  );
}

/**
 * 起動時の復元で、ログインの状態を確かめられなかった（やり直しても通信の失敗・5xx・429 が続いた。機能一覧 1.2。#420）。
 * ログインの画面には移さない。
 */
function Unavailable() {
  return (
    <div className="space-y-3 p-8">
      <p role="alert" className="text-red-700">
        ログインの状態を確かめられませんでした。時間をおいて、再読み込みしてください。
      </p>
      <button
        type="button"
        className="rounded border px-3 py-1"
        onClick={() => window.location.reload()}
      >
        再読み込み
      </button>
    </div>
  );
}

/** ログインしている利用者だけに見せる。ログインしていなければ、元の行き先を持ってログインの画面へ移す。 */
export function RequireSignedIn() {
  const session = useSession();
  const location = useLocation();
  if (session.status === 'checking') return <Loading />;
  if (session.status === 'unavailable') return <Unavailable />;
  if (session.status === 'signedOut')
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return <Outlet />;
}

/**
 * ログインしていない利用者だけに見せる（ログイン・登録・再設定 `/recovery`）。ログインしたら元の行き先かワークスペースの画面へ移す。
 *
 * **`unavailable` でも塞がない。** 起動時の復元を確かめられなかっただけで、利用者が自分で開いた
 * ログイン・登録・再設定の画面まで出さないと、**本来ログインできる利用者がログインできなくなる**——
 * リフレッシュの枠（発信元単位で 15 分に 60 回）とログインの枠（同 20 回）は別であり、
 * 前者が尽きていても後者は空いている（機能一覧 1.2・1.1）。`Unavailable` を出すのは
 * `RequireSignedIn` の側だけである（決定は「ログインの画面へ**移さない**」であって「塞ぐ」ではない）。
 */
export function GuestOnly() {
  const session = useSession();
  const location = useLocation();
  if (session.status === 'checking') return <Loading />;
  if (session.status === 'signedIn') {
    const from = (location.state as { from?: unknown } | null)?.from;
    return <Navigate to={typeof from === 'string' ? from : '/workspaces'} replace />;
  }
  return <Outlet />;
}
