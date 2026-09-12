import { REALTIME_PATH, REALTIME_TRANSPORTS } from '@workspace-chat/shared';
import { io, type Socket } from 'socket.io-client';
import { TEST_WEB_ORIGIN } from './api-env';

/**
 * テストから Socket.IO で繋ぐ部品。**製品コードから読み込まない**（tsconfig.build.json が外す）。
 */
export type Transport = 'websocket' | 'polling';

export type ConnectOptions = {
  origin?: string;
  token?: unknown;
  cookie?: string;
  transport?: Transport;
  path?: string;
};

/**
 * 接続できれば Socket を、断られれば connect_error の Error を返す。
 * transports の既定はクライアントが使う形（REALTIME_TRANSPORTS）。transport はそれ以外の経路を確かめるときにだけ指定する。
 */
export function connectRealtime(
  base: string,
  { origin = TEST_WEB_ORIGIN, token, cookie, transport, path = REALTIME_PATH }: ConnectOptions,
): Promise<
  { socket: Socket; error?: undefined } | { socket: Socket; error: Error & { data?: unknown } }
> {
  const socket = io(base, {
    path,
    transports: transport === undefined ? [...REALTIME_TRANSPORTS] : [transport],
    reconnection: false,
    forceNew: true,
    timeout: 5_000,
    ...(token === undefined ? {} : { auth: { token } }),
    extraHeaders: {
      ...(origin === '' ? {} : { origin }),
      ...(cookie === undefined ? {} : { cookie }),
    },
  });
  return new Promise((resolve) => {
    socket.once('connect', () => resolve({ socket }));
    socket.once('connect_error', (error) => {
      socket.close();
      resolve({ socket, error: error as Error & { data?: unknown } });
    });
  });
}

/** 次に届くイベントを待つ。届かなければ undefined。 */
export function nextEvent(socket: Socket, event: string, timeoutMs = 2_000): Promise<unknown> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), timeoutMs);
    socket.once(event, (payload: unknown) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}
