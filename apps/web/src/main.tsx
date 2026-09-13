import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { createQueryClient } from './api/query-client';
import { App } from './App';
import { createSessionStore } from './auth/session-store';
import './index.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('#root が見つからない');
}
// ログインの状態と読み込みの記憶はページにつき1つ。描画の外で作り、StrictMode の描画のやり直しで作り直さない。
const store = createSessionStore();
const queryClient = createQueryClient();
createRoot(container).render(
  <StrictMode>
    <BrowserRouter>
      <App store={store} queryClient={queryClient} />
    </BrowserRouter>
  </StrictMode>,
);
