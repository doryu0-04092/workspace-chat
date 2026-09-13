import { Navigate, Outlet, useLocation } from 'react-router';
import { useSession } from './session-context';

function Loading() {
  return (
    <p role="status" className="p-8 text-slate-600">
      読み込み中…
    </p>
  );
}

/** ログインしている利用者だけに見せる。ログインしていなければ、元の行き先を持ってログインの画面へ移す。 */
export function RequireSignedIn() {
  const session = useSession();
  const location = useLocation();
  if (session.status === 'checking') return <Loading />;
  if (session.status === 'signedOut')
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return <Outlet />;
}

/** ログインしていない利用者だけに見せる（ログイン・登録）。ログインしたら元の行き先かワークスペースの画面へ移す。 */
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
