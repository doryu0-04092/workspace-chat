import { useQueryClient } from '@tanstack/react-query';
import type {
  DmUnreadUpdatedPayload,
  RealtimeEventName,
  UnreadUpdatedPayload,
} from '@workspace-chat/shared';
import { useEffect } from 'react';
import { type Dm, dmsKey, setDmUnread } from '../dms/queries';
import { type Channel, channelsKey, setChannelUnread } from '../workspaces/queries';
import { useRealtime } from './realtime-context';

const UNREAD_UPDATED = 'unread:updated' satisfies RealtimeEventName;

/**
 * 未読数とメンションの件数のリアルタイムの反映（F-23・F-24。機能一覧 10.1・10.2・5.2）。
 * **配信で届いた値を、読み込んである一覧に当てるだけで、一覧は読み直さない**（技術スタックの「データ取得」）。
 * **配信はその未読の持ち主にだけ届く**ため、届いた値をそのまま自分の未読として扱ってよい。
 *
 * **DM の未読（`dmId` を持つ。F-19）は DM の一覧に、チャンネルの未読はチャンネルの一覧に当てる**（混ぜない）。
 * **DM の一覧に無い DM**（相手が始めたばかりの DM）の未読が、開いているワークスペースについて届いたときだけ、DM の一覧を取り直す
 * ——当てる行が無く、取り直さないと、相手から届いた DM に気づけない。別のワークスペースの DM では取り直さない。
 */
export function useUnreadRealtime(workspaceId: string) {
  const { socket } = useRealtime();
  const queryClient = useQueryClient();

  useEffect(() => {
    const onUnread = (payload: UnreadUpdatedPayload | DmUnreadUpdatedPayload) => {
      if ('dmId' in payload) {
        if (payload.workspaceId !== workspaceId) return;
        const dms = queryClient.getQueryData<Dm[]>(dmsKey(workspaceId));
        if (dms?.some((dm) => dm.id === payload.dmId)) {
          queryClient.setQueryData<Dm[]>(dmsKey(workspaceId), (current) =>
            setDmUnread(current, payload.dmId, payload.unread),
          );
        } else {
          // **`exact` で当てる**——鍵の下には DM のメッセージのキャッシュも入っている
          void queryClient.invalidateQueries({ queryKey: dmsKey(workspaceId), exact: true });
        }
        return;
      }
      const { channelId, unread, mentions } = payload;
      queryClient.setQueryData<Channel[]>(channelsKey(workspaceId), (channels) =>
        setChannelUnread(channels, channelId, { unread, mentions }),
      );
    };
    socket.on(UNREAD_UPDATED, onUnread);
    return () => {
      socket.off(UNREAD_UPDATED, onUnread);
    };
  }, [socket, queryClient, workspaceId]);
}
