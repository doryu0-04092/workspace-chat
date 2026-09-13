import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { App } from './App';
import { createSessionStore } from './auth/session-store';
import './index.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('#root が見つからない');
}
// ログインの状態はページにつき1つ。描画の外で作り、StrictMode の描画のやり直しで作り直さない。
const store = createSessionStore();
createRoot(container).render(
  <StrictMode>
    <BrowserRouter>
      <App store={store} />
    </BrowserRouter>
  </StrictMode>,
);
