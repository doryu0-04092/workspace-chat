import { type QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect } from 'react';
import { Navigate, Route, Routes } from 'react-router';
import { LoginPage } from './auth/LoginPage';
import { RecoveryPage } from './auth/RecoveryPage';
import { RegisterPage } from './auth/RegisterPage';
import { GuestOnly, RequireSignedIn } from './auth/route-guards';
import { SessionProvider } from './auth/session-context';
import { DmPage } from './dms/DmPage';
import type { SessionStore } from './auth/session-store';
import { SignedInLayout } from './layout/SignedInLayout';
import type { ConnectRealtime } from './realtime/connect';
import { RealtimeProvider } from './realtime/realtime-context';
import { SearchPage } from './search/SearchPage';
import { ProfilePage } from './users/ProfilePage';
import { SettingsPage } from './users/SettingsPage';
import { ChannelPage } from './workspaces/ChannelPage';
import { WorkspacePage } from './workspaces/WorkspacePage';
import { WorkspacesPage } from './workspaces/WorkspacesPage';

/**
 * 画面の入口。ルーターは呼ぶ側が包む（本番は BrowserRouter、テストは MemoryRouter）。
 * 起動時に1回、リフレッシュでログインの状態を取り直す（store が同時の呼び出しを1本に束ねる）。
 * リアルタイムの接続は、ログインした画面の枠の間だけ持つ（接続の作り方は呼ぶ側が渡す。本番は socket.io-client、テストは偽物）。
 *
 * **踏むと壊れる: ログインの状態が切れたら（ログアウト・リフレッシュの失敗）、読み込みの記憶を捨てる。**
 * 読み込みの鍵は利用者を含まないため、捨てないと、同じタブで次にログインした別の利用者に、
 * 前の利用者のワークスペース名やプライベートチャンネル名が、取り直しが終わるまで出る。
 */
export function App({
  store,
  queryClient,
  connectRealtime,
}: {
  store: SessionStore;
  queryClient: QueryClient;
  connectRealtime: ConnectRealtime;
}) {
  useEffect(() => {
    void store.restore();
  }, [store]);

  useEffect(
    () =>
      store.state.subscribe((state, previous) => {
        if (state.status === 'signedOut' && previous.status !== 'signedOut') queryClient.clear();
      }),
    [store, queryClient],
  );

  return (
    <SessionProvider store={store}>
      <QueryClientProvider client={queryClient}>
        <Routes>
          <Route element={<GuestOnly />}>
            <Route path="login" element={<LoginPage />} />
            <Route path="register" element={<RegisterPage />} />
            <Route path="recovery" element={<RecoveryPage />} />
          </Route>
          <Route element={<RequireSignedIn />}>
            <Route
              element={
                <RealtimeProvider connect={connectRealtime}>
                  <SignedInLayout />
                </RealtimeProvider>
              }
            >
              <Route path="profile" element={<ProfilePage />} />
              <Route path="settings" element={<SettingsPage />} />
              <Route path="workspaces" element={<WorkspacesPage />} />
              <Route path="workspaces/:workspaceId" element={<WorkspacePage />} />
              <Route path="workspaces/:workspaceId/search" element={<SearchPage />} />
              <Route path="workspaces/:workspaceId/channels/:channelId" element={<ChannelPage />} />
              <Route path="workspaces/:workspaceId/dms/:dmId" element={<DmPage />} />
            </Route>
          </Route>
          <Route path="*" element={<Navigate to="/workspaces" replace />} />
        </Routes>
      </QueryClientProvider>
    </SessionProvider>
  );
}
