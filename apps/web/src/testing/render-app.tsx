import { QueryClient } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { StrictMode } from 'react';
import { MemoryRouter } from 'react-router';
import { App } from '../App';
import { createSessionStore } from '../auth/session-store';

/** テスト用の QueryClient。失敗をやり直さない（やり直すと、失敗の表示を待つ検査が遅れて時間切れになる）。 */
export function testQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

/** 指定した URL から画面の入口を描画する。ロックは使わない（jsdom に navigator.locks は無い）。 */
export function renderApp(path: string, { strict = false } = {}) {
  const store = createSessionStore({ locks: undefined });
  const tree = (
    <MemoryRouter initialEntries={[path]}>
      <App store={store} queryClient={testQueryClient()} />
    </MemoryRouter>
  );
  return { store, ...render(strict ? <StrictMode>{tree}</StrictMode> : tree) };
}
