import { type QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect } from 'react';
import { Navigate, Route, Routes } from 'react-router';
import { LoginPage } from './auth/LoginPage';
import { RegisterPage } from './auth/RegisterPage';
import { GuestOnly, RequireSignedIn } from './auth/route-guards';
import { SessionProvider } from './auth/session-context';
import type { SessionStore } from './auth/session-store';
import { SignedInLayout } from './layout/SignedInLayout';
import { ChannelPage } from './workspaces/ChannelPage';
import { WorkspacePage } from './workspaces/WorkspacePage';
import { WorkspacesPage } from './workspaces/WorkspacesPage';

/**
 * 画面の入口。ルーターは呼ぶ側が包む（本番は BrowserRouter、テストは MemoryRouter）。
 * 起動時に1回、リフレッシュでログインの状態を取り直す（store が同時の呼び出しを1本に束ねる）。
 */
export function App({ store, queryClient }: { store: SessionStore; queryClient: QueryClient }) {
  useEffect(() => {
    void store.restore();
  }, [store]);

  return (
    <SessionProvider store={store}>
      <QueryClientProvider client={queryClient}>
        <Routes>
          <Route element={<GuestOnly />}>
            <Route path="login" element={<LoginPage />} />
            <Route path="register" element={<RegisterPage />} />
          </Route>
          <Route element={<RequireSignedIn />}>
            <Route element={<SignedInLayout />}>
              <Route path="workspaces" element={<WorkspacesPage />} />
              <Route path="workspaces/:workspaceId" element={<WorkspacePage />} />
              <Route path="workspaces/:workspaceId/channels/:channelId" element={<ChannelPage />} />
            </Route>
          </Route>
          <Route path="*" element={<Navigate to="/workspaces" replace />} />
        </Routes>
      </QueryClientProvider>
    </SessionProvider>
  );
}
