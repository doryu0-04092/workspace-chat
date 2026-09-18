import type { ChannelRoomRequest, RealtimeEventName, TypingPayload } from '@workspace-chat/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSession } from '../auth/session-context';
import { useRealtime } from './realtime-context';

const TYPING_START = 'typing:start' satisfies RealtimeEventName;
const TYPING_STOP = 'typing:stop' satisfies RealtimeEventName;

/**
 * 打ち続けている間に `typing:start` を送り直す間隔（F-34。機能一覧 13.3「過剰に送信されない」。実装時に決めた値）。
 * **キー入力ごとには送らない**——打ち始めに1回送り、打ち続けても、この間隔を過ぎるまで次を送らない。
 */
export const TYPING_SEND_INTERVAL_MS = 3_000;

/** 入力が止まってから `typing:stop` を送るまでの時間（13.3「一定時間入力が止まったら消える」。実装時に決めた値）。 */
export const TYPING_IDLE_MS = 3_000;

/**
 * 受け取った側が、最後の `typing:start` から表示を残す時間（実装時に決めた値）。`typing:stop` が届かなかったとき
 * （送った側の切断・タブを閉じた）にも消すため。**送り直しの間隔の2倍にする**——打ち続けている人の表示が、送り直しの遅れで点滅しない。
 */
export const TYPING_DISPLAY_MS = 2 * TYPING_SEND_INTERVAL_MS;

/**
 * 入力中の知らせを送る（F-34）。返す関数に、入力欄の値が変わるたびにいまの本文を渡す。
 *
 * - 本文が空でなければ、打ち始めと、前に送ってから `TYPING_SEND_INTERVAL_MS` を過ぎたときにだけ `typing:start` を送る
 * - 本文が空になった（消した・送信して欄が空になった）とき、止まって `TYPING_IDLE_MS` たったとき、チャンネルを離れたときに `typing:stop` を送る
 * - **繋がっていなければ送らない**（送っていないものは、送ったことにしない）
 */
export function useTypingNotifier(channelId: string): (body: string) => void {
  const { socket } = useRealtime();
  const typing = useRef<{ sentAt: number } | null>(null);
  const idle = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const stop = useCallback(() => {
    clearTimeout(idle.current);
    if (typing.current === null) return;
    typing.current = null;
    if (socket.connected) {
      const room: ChannelRoomRequest = { channelId };
      socket.emit(TYPING_STOP, room);
    }
  }, [socket, channelId]);

  useEffect(() => stop, [stop]);

  return useCallback(
    (body: string) => {
      if (body === '') {
        stop();
        return;
      }
      const now = Date.now();
      if (
        socket.connected &&
        (typing.current === null || now - typing.current.sentAt >= TYPING_SEND_INTERVAL_MS)
      ) {
        const room: ChannelRoomRequest = { channelId };
        socket.emit(TYPING_START, room);
        typing.current = { sentAt: now };
      }
      clearTimeout(idle.current);
      idle.current = setTimeout(stop, TYPING_IDLE_MS);
    },
    [socket, channelId, stop],
  );
}

type Typist = TypingPayload['user'];

/**
 * そのチャンネルで入力中の利用者（F-34）。届いた順に並べる。
 * **自分は出さない**（13.3「自分の入力中インジケータは自分には表示されない」。別のタブで打っている自分も同じ利用者として除く）。
 * `typing:stop` が届くか、最後の `typing:start` から `TYPING_DISPLAY_MS` たったら外す。
 */
export function useTypingUsers(channelId: string): Typist[] {
  const { socket } = useRealtime();
  const session = useSession();
  const me = session.status === 'signedIn' ? session.user.id : null;
  const [typists, setTypists] = useState<Typist[]>([]);

  useEffect(() => {
    const expiries = new Map<string, ReturnType<typeof setTimeout>>();
    const remove = (userId: string) => {
      clearTimeout(expiries.get(userId));
      expiries.delete(userId);
      setTypists((current) => current.filter((user) => user.id !== userId));
    };
    const onStart = ({ channelId: target, user }: TypingPayload) => {
      if (target !== channelId || user.id === me) return;
      clearTimeout(expiries.get(user.id));
      expiries.set(
        user.id,
        setTimeout(() => remove(user.id), TYPING_DISPLAY_MS),
      );
      setTypists((current) =>
        current.some((typist) => typist.id === user.id) ? current : [...current, user],
      );
    };
    const onStop = ({ channelId: target, user }: TypingPayload) => {
      if (target === channelId) remove(user.id);
    };
    socket.on(TYPING_START, onStart);
    socket.on(TYPING_STOP, onStop);
    return () => {
      socket.off(TYPING_START, onStart);
      socket.off(TYPING_STOP, onStop);
      for (const timer of expiries.values()) clearTimeout(timer);
      setTypists([]);
    };
  }, [socket, channelId, me]);

  return typists;
}
