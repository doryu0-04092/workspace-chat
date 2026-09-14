import { REALTIME_PATH, REALTIME_TRANSPORTS } from '@workspace-chat/shared';
import { io, type Socket } from 'socket.io-client';

/** 画面が使うソケットの部分（socket.io-client の Socket のうち、ここで呼ぶもの）。検査は偽物に差し替える。 */
export type RealtimeSocket = Pick<
  Socket,
  'connected' | 'active' | 'connect' | 'disconnect' | 'on' | 'off' | 'emit'
>;

/** 接続を作る。`token` は、繋ぐたびに読む「いまのアクセストークン」（ログインしていなければ null）。 */
export type ConnectRealtime = (token: () => string | null) => RealtimeSocket;

/**
 * 本番の接続（F-16。機能一覧 5.2）。**自分からは繋がない**（`autoConnect: false`。繋ぐ時点はログインした画面の枠が決める）。
 * - 同じ origin に、パスは `REALTIME_PATH`、transports は `REALTIME_TRANSPORTS` で繋ぐ（踏むと壊れる。理由は packages/shared の realtime-events.ts）
 * - **`auth` は関数で渡す。** socket.io-client は接続を開くたびにこの関数を呼ぶため（4.8.3 の `Socket#onopen`）、再接続でもいまのアクセストークンが載る
 */
export const connectRealtime: ConnectRealtime = (token) =>
  io({
    path: REALTIME_PATH,
    transports: [...REALTIME_TRANSPORTS],
    autoConnect: false,
    auth: (callback) => callback({ token: token() }),
  });
