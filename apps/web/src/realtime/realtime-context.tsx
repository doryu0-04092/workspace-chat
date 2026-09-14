import { createContext, type ReactNode, useContext, useEffect, useState } from 'react';
import { useSessionStore } from '../auth/session-context';
import type { ErrorCode, Failure } from '../auth/session-store';
import type { ConnectRealtime, RealtimeSocket } from './connect';

type Realtime = { socket: RealtimeSocket; refused: Failure | null };

const RealtimeContext = createContext<Realtime | null>(null);

/**
 * ログインした画面の間だけ、リアルタイムの接続を1本持つ（F-16）。枠が外れたら（ログアウトを含む）切る。
 *
 * - **ハンドシェイクが `invalid_token` で断られたら、リフレッシュしてから1回だけ繋ぎ直す。** ミドルウェアで断られた接続は
 *   自動では繋ぎ直さない（Socket.IO の文書「the connection was denied by the server // in that case, `socket.connect()` must be manually called in order to reconnect」）。
 *   アクセストークンは短命のため、切れた後の再接続はこの形で断られる。取り直した後も断られたら、繋ぎ直しを繰り返さず理由を出す
 * - リフレッシュも通らなければ、store がログインしていない状態にする（この枠が外れ、接続が切れる）
 * - それ以外の理由で断られたら、繋ぎ直さず理由を出す
 */
export function RealtimeProvider({
  connect,
  children,
}: {
  connect: ConnectRealtime;
  children: ReactNode;
}) {
  const store = useSessionStore();
  const [socket] = useState(() =>
    connect(() => {
      const state = store.getState();
      return state.status === 'signedIn' ? state.accessToken : null;
    }),
  );
  const [refused, setRefused] = useState<Failure | null>(null);

  useEffect(() => {
    let active = true;
    let renewed = false;
    const onConnect = () => {
      renewed = false;
      setRefused(null);
    };
    const onConnectError = (error: Error & { data?: { code?: string } }) => {
      if (socket.active) return;
      const code = error.data?.code;
      if (code === 'invalid_token' && !renewed) {
        renewed = true;
        // リフレッシュを待つ間に枠が外れたら（ログアウトなど）、通っても繋ぎ直さない。枠の外に接続を残さない
        void store.renew().then((token) => {
          if (active && token !== null) socket.connect();
        });
        return;
      }
      setRefused({ ok: false, status: -1, code: code as ErrorCode | undefined });
    };
    socket.on('connect', onConnect);
    socket.on('connect_error', onConnectError);
    socket.connect();
    return () => {
      active = false;
      socket.off('connect', onConnect);
      socket.off('connect_error', onConnectError);
      socket.disconnect();
    };
  }, [socket, store]);

  return (
    <RealtimeContext.Provider value={{ socket, refused }}>{children}</RealtimeContext.Provider>
  );
}

export function useRealtime(): Realtime {
  const realtime = useContext(RealtimeContext);
  if (!realtime) throw new Error('RealtimeProvider の外で useRealtime を呼ばない');
  return realtime;
}
