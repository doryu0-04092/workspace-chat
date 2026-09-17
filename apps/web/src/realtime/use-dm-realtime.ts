import { useQueryClient } from '@tanstack/react-query';
import type {
  DmMessageDeletedPayload,
  DmMessageNewPayload,
  DmMessageUpdatedPayload,
  MessageDeletedPayload,
  MessageNewPayload,
  MessageUpdatedPayload,
  RealtimeEventName,
} from '@workspace-chat/shared';
import { useEffect } from 'react';
import { type DmMessage, type DmMessagePages, dmMessagesKey } from '../dms/queries';
import { addMessage, markDeleted, replaceMessage } from '../messages/queries';
import { useRealtime } from './realtime-context';

const MESSAGE_NEW = 'message:new' satisfies RealtimeEventName;
const MESSAGE_UPDATED = 'message:updated' satisfies RealtimeEventName;
const MESSAGE_DELETED = 'message:deleted' satisfies RealtimeEventName;

/** DM のメッセージか（チャンネルのメッセージは `dmId` を持たない。realtime-events.ts の `DmMessageNewPayload`）。 */
function isDmMessage(message: MessageNewPayload['message'] | DmMessage): message is DmMessage {
  return 'dmId' in message && typeof message.dmId === 'string';
}

/**
 * 開いている DM のリアルタイムの反映（F-19。機能一覧 5.2 の DM の箇条）。
 *
 * - **DM はチャンネルの部屋を持たず、入室要求を送らない**——配信は利用者の部屋へ届く（接続した時点で入っている）
 * - `message:new` / `message:updated` / `message:deleted` のうち、**この DM の `dmId` を持つものだけ**を一覧に当てる
 *   （イベント名はチャンネルと同じで、チャンネルのメッセージは `dmId` を持たない）。`message:new` は同じ id を2行にしない
 * - **繋ぎ直したら一覧を読み直す**（5.2「再接続後、切断中に発生したメッセージが補完される」。`connect` は「upon connection and reconnection」に届く）
 */
export function useDmRealtime(workspaceId: string, dmId: string): void {
  const { socket } = useRealtime();
  const queryClient = useQueryClient();

  useEffect(() => {
    const key = dmMessagesKey(workspaceId, dmId);
    const update = (change: (data: DmMessagePages | undefined) => DmMessagePages | undefined) =>
      queryClient.setQueryData<DmMessagePages>(key, change);

    const onNew = ({ message }: MessageNewPayload | DmMessageNewPayload) => {
      if (isDmMessage(message) && message.dmId === dmId) {
        update((data) => addMessage(data, message));
      }
    };
    const onUpdated = ({ message }: MessageUpdatedPayload | DmMessageUpdatedPayload) => {
      if (isDmMessage(message) && message.dmId === dmId) {
        update((data) => replaceMessage(data, message));
      }
    };
    const onDeleted = (payload: MessageDeletedPayload | DmMessageDeletedPayload) => {
      if ('dmId' in payload && payload.dmId === dmId) {
        update((data) => markDeleted(data, payload.messageId));
      }
    };
    const onConnect = () => void queryClient.invalidateQueries({ queryKey: key });

    socket.on('connect', onConnect);
    socket.on(MESSAGE_NEW, onNew);
    socket.on(MESSAGE_UPDATED, onUpdated);
    socket.on(MESSAGE_DELETED, onDeleted);
    return () => {
      socket.off('connect', onConnect);
      socket.off(MESSAGE_NEW, onNew);
      socket.off(MESSAGE_UPDATED, onUpdated);
      socket.off(MESSAGE_DELETED, onDeleted);
    };
  }, [socket, queryClient, workspaceId, dmId]);
}
