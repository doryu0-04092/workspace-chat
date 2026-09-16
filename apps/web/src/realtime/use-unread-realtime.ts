import { useQueryClient } from '@tanstack/react-query';
import type { RealtimeEventName, UnreadUpdatedPayload } from '@workspace-chat/shared';
import { useEffect } from 'react';
import { type Channel, channelsKey, setChannelUnread } from '../workspaces/queries';
import { useRealtime } from './realtime-context';

const UNREAD_UPDATED = 'unread:updated' satisfies RealtimeEventName;

/**
 * 未読数のリアルタイムの反映（F-23。機能一覧 10.1・5.2）。
 * **配信で届いた値を、読み込んである一覧に当てるだけで、一覧は読み直さない**（技術スタックの「データ取得」）。
 * **配信はその未読の持ち主にだけ届く**ため、届いた値をそのまま自分の未読として扱ってよい。
 */
export function useUnreadRealtime(workspaceId: string) {
  const { socket } = useRealtime();
  const queryClient = useQueryClient();

  useEffect(() => {
    const onUnread = ({ channelId, unread }: UnreadUpdatedPayload) => {
      queryClient.setQueryData<Channel[]>(channelsKey(workspaceId), (channels) =>
        setChannelUnread(channels, channelId, unread),
      );
    };
    socket.on(UNREAD_UPDATED, onUnread);
    return () => {
      socket.off(UNREAD_UPDATED, onUnread);
    };
  }, [socket, queryClient, workspaceId]);
}
