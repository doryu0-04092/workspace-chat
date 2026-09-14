import { useQueryClient } from '@tanstack/react-query';
import {
  type ChannelEnterAck,
  type ChannelRoomRequest,
  type MessageDeletedPayload,
  type MessageNewPayload,
  type MessageUpdatedPayload,
  REALTIME_REQUESTS,
  type RealtimeEventName,
} from '@workspace-chat/shared';
import { useEffect, useState } from 'react';
import type { Failure } from '../auth/session-store';
import {
  addMessage,
  markDeleted,
  type MessagePages,
  messagesKey,
  replaceMessage,
} from '../messages/queries';
import { useRealtime } from './realtime-context';

const MESSAGE_NEW = 'message:new' satisfies RealtimeEventName;
const MESSAGE_UPDATED = 'message:updated' satisfies RealtimeEventName;
const MESSAGE_DELETED = 'message:deleted' satisfies RealtimeEventName;

/** 入室要求が上限（429）で断られたとき、送り直すまで待つ時間。api の入室の上限の窓（1分）と同じ。 */
export const ENTER_RETRY_DELAY_MS = 60_000;

/**
 * 開いているチャンネルのリアルタイムの反映（F-16。機能一覧 5.2・9.2）。入室を断られたら、その理由を返す。
 *
 * - **接続したら（再接続を含む）入室要求を送り、入れたら一覧を読み直す**——入室の前と、切れていた間に投稿されたメッセージを補完する
 *   （5.2「再接続後、切断中に発生したメッセージが補完される」。`connect` は「upon connection and reconnection」に届く）
 * - **上限（429）で断られたら、1分おいて、繋がっていれば入室要求を送り直す**（9.2「画面は時間をおいてやり直す」）。ほかの断りは送り直さない
 * - チャンネルを離れたら、繋がっていれば退室要求を送る（9.2）
 * - `message:new` / `message:updated` / `message:deleted` を、このチャンネルの一覧のキャッシュに反映する（技術スタックの「データ取得」）。
 *   `message:new` は同じ id を2行にしない（自分の投稿は、投稿の応答と配信の両方で届く）
 */
export function useChannelRealtime(workspaceId: string, channelId: string): Failure | null {
  const { socket } = useRealtime();
  const queryClient = useQueryClient();
  const [rejected, setRejected] = useState<Failure | null>(null);

  useEffect(() => {
    const key = messagesKey(workspaceId, channelId);
    const room: ChannelRoomRequest = { channelId };
    const update = (change: (data: MessagePages | undefined) => MessagePages | undefined) =>
      queryClient.setQueryData<MessagePages>(key, change);

    let active = true;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const enter = () => {
      clearTimeout(retry);
      socket.emit(REALTIME_REQUESTS.channelEnter, room, (ack: ChannelEnterAck) => {
        if (!active) return;
        if (!ack.ok) {
          setRejected({ ok: false, status: ack.status, code: ack.error.code });
          if (ack.status === 429) {
            retry = setTimeout(() => {
              if (socket.connected) enter();
            }, ENTER_RETRY_DELAY_MS);
          }
          return;
        }
        setRejected(null);
        void queryClient.invalidateQueries({ queryKey: key });
      });
    };
    const onNew = ({ message }: MessageNewPayload) => {
      if (message.channelId === channelId) update((data) => addMessage(data, message));
    };
    const onUpdated = ({ message }: MessageUpdatedPayload) => {
      if (message.channelId === channelId) update((data) => replaceMessage(data, message));
    };
    const onDeleted = (payload: MessageDeletedPayload) => {
      if (payload.channelId === channelId) update((data) => markDeleted(data, payload.messageId));
    };

    socket.on('connect', enter);
    socket.on(MESSAGE_NEW, onNew);
    socket.on(MESSAGE_UPDATED, onUpdated);
    socket.on(MESSAGE_DELETED, onDeleted);
    if (socket.connected) enter();
    return () => {
      active = false;
      clearTimeout(retry);
      socket.off('connect', enter);
      socket.off(MESSAGE_NEW, onNew);
      socket.off(MESSAGE_UPDATED, onUpdated);
      socket.off(MESSAGE_DELETED, onDeleted);
      if (socket.connected) socket.emit(REALTIME_REQUESTS.channelExit, room);
    };
  }, [socket, queryClient, workspaceId, channelId]);

  return rejected;
}
