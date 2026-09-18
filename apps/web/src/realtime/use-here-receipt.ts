import {
  HERE_MENTION_NOTICE,
  type HereMentionPayload,
  type HereMentionReceipt,
} from '@workspace-chat/shared';
import { useEffect } from 'react';
import { useRealtime } from './realtime-context';

/**
 * `@here` の受け取りを返す（F-21。機能一覧 9.2「受け取った側は、そのチャンネルを開いていなければ弾き、開いていれば受け取りを返す」・10.2）。
 * **開いているチャンネル（この画面の `channelId`）の `@here` にだけ返し、それ以外は返さずに弾く**——返した利用者にだけ、
 * サーバーが通知（メンションの件数）を作る。チャンネルを離れたら聞くのをやめる（離れた後に届いたものは弾く）。
 */
export function useHereReceipt(channelId: string): void {
  const { socket } = useRealtime();

  useEffect(() => {
    const onNotice = (payload: HereMentionPayload, ack?: (receipt: HereMentionReceipt) => void) => {
      if (payload.channelId === channelId) ack?.({ received: true });
    };
    socket.on(HERE_MENTION_NOTICE, onNotice);
    return () => {
      socket.off(HERE_MENTION_NOTICE, onNotice);
    };
  }, [socket, channelId]);
}
