import { QueryClient } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { StrictMode } from 'react';
import { MemoryRouter } from 'react-router';
import { VirtuosoMockContext } from 'react-virtuoso';
import { App } from '../App';
import { createSessionStore } from '../auth/session-store';
import type { ConnectRealtime, RealtimeSocket } from '../realtime/connect';
import { FakeSocket } from './fake-socket';

/** jsdom は要素の大きさを測れないため、Virtuoso には表示域と行の高さを固定で渡す（react-virtuoso の VirtuosoMockContext）。 */
const VIRTUOSO_SIZES = { viewportHeight: 2000, itemHeight: 40 };

/** テスト用の QueryClient。失敗をやり直さない（やり直すと、失敗の表示を待つ検査が遅れて時間切れになる）。 */
export function testQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

/**
 * 指定した URL から画面の入口を描画する。ロックは使わない（jsdom に navigator.locks は無い）。
 * リアルタイムの接続は偽のソケットに差し替え、作られた順に `sockets` に並べる。
 */
export function renderApp(path: string, { strict = false } = {}) {
  const store = createSessionStore({ locks: undefined });
  const sockets: FakeSocket[] = [];
  const connectRealtime: ConnectRealtime = (token) => {
    const socket = new FakeSocket(token);
    sockets.push(socket);
    // 偽物は socket.io-client の Socket の型引数つきの署名を持たない。画面が呼ぶ名前と引数の形は揃えてある（fake-socket.ts）
    return socket as unknown as RealtimeSocket;
  };
  const tree = (
    <MemoryRouter initialEntries={[path]}>
      <VirtuosoMockContext.Provider value={VIRTUOSO_SIZES}>
        <App store={store} queryClient={testQueryClient()} connectRealtime={connectRealtime} />
      </VirtuosoMockContext.Provider>
    </MemoryRouter>
  );
  return { store, sockets, ...render(strict ? <StrictMode>{tree}</StrictMode> : tree) };
}
